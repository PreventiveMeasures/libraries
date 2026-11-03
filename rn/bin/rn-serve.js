#!/usr/bin/env node
// rn-serve [--port=8081] [--host=127.0.0.1] [--metro-config=FILE] [--max-workers=N] [--define=K=V ...]
//   [--babel-aliases=FILE] [--esm | --no-esm] [--devtools | --no-devtools] [--reset-cache] [--no-warm]
//   [--no-client-logs] [--launch=ios [--simulator=NAME] [--binary-path=APP] | --no-launch]
// A Metro-compatible dev server: bundles built as rn-bundle builds them, assets, symbolication, client
// logs, Fast Refresh and, with @react-native/dev-middleware, the debugger. Loaded files are cached on disk
// across runs; rn.config.json gives the flags' defaults; --launch=ios starts the app on a simulator.

import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { enableCompileCache } from 'node:module'
import { isIP } from 'node:net'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'
import { emitKeypressEvents } from 'node:readline'
import { parseArgs, format as printf, styleText } from 'node:util'

import { babelAliases, defines, failer, flowStripper, locateThrough, peers, projectBabel } from '../src/cli.js'
import { createDevBundler } from '../src/dev-bundler.js'
import { createDevToolsOpener } from '../src/devtools.js'
import { createGate, hostnamesOf, isLoopback } from '../src/gate.js'
import { launchIos } from '../src/launch-ios.js'
import { createLoadCache } from '../src/load-cache.js'
import { prune } from '../src/load-prune.js'
import { maxWorkersOf, metroOptions } from '../src/metro-options.js'
import { REPORTER } from '../src/network.js'
import { extendedMetro, flagOf, metroConfigOf, readRnConfig } from '../src/rn-config.js'
import { bundlingError, createDevServer } from '../src/serve.js'
import { bundleName, cacheDirOf, lastBuilds, usersOwn } from '../src/serve-cache.js'
import { printable } from '../src/terminal.js'
import { createWatcher } from '../src/watch.js'

// Caches compiled code (@babel/core, esbuild, the Metro config) on disk; NODE_DISABLE_COMPILE_CACHE=1 opts out.
enableCompileCache()

const { values } = parseArgs({
  options: {
    port: { type: 'string' },
    host: { type: 'string', default: '127.0.0.1' },
    'metro-config': { type: 'string' },
    'max-workers': { type: 'string' },
    define: { type: 'string', multiple: true, default: [] },
    'babel-aliases': { type: 'string' },
    esm: { type: 'boolean' },
    devtools: { type: 'boolean' },
    'reset-cache': { type: 'boolean', default: false },
    warm: { type: 'boolean', default: true },
    'client-logs': { type: 'boolean', default: true },
    launch: { type: 'string' },
    // Declared so that strict parseArgs accepts --no-launch on the string option.
    'no-launch': { type: 'boolean' },
    simulator: { type: 'string' },
    'binary-path': { type: 'string' },
  },
  allowNegative: true,
})

const fail = failer('rn-serve')
// Silent once quitting (quit()).
let quiet = false
const log = (line) => {
  if (!quiet) process.stdout.write(`${line}\n`)
}
if (values.port !== undefined && (!/^\d+$/u.test(values.port) || Number(values.port) > 65_535)) fail(`--port takes a port, not ${values.port}`)
defines(true, values.define, fail)

// The project: its rn.config.json, Metro config, peers, Babel config and cache.
const projectRoot = realpathSync(process.cwd())
const rnConfig = readRnConfig(projectRoot, fail)
const esm = flagOf(values.esm, rnConfig, 'esm')
const devtools = flagOf(values.devtools, rnConfig, 'devtools').on
const launch = launchOf()
const project = peers(projectRoot, fail)
const esbuild = project.peer('esbuild', 'bundling')
const metro = extendedMetro(await metroOptions(projectRoot, project, fail, { file: metroConfigOf(values['metro-config'], rnConfig), name: 'rn-serve', serving: true }), rnConfig, fail)
const port = values.port === undefined ? (rnConfig.port ?? metro.port ?? 8081) : Number(values.port)
// For Fast Refresh: the module system of dev bundles, and the Babel plugin that registers components.
// Without Babel, metro-runtime < 0.83.3 reloads on an ES module edit: esbuild's export getters aren't a boundary to it.
const runtime = locateThrough(project, 'metro-runtime/src/polyfills/require.js', ['react-native'])
const refreshPlugin = locateThrough(project, 'react-refresh/babel', ['react-native'])
const cacheDir = cacheDirOf(values['reset-cache'], log)
const last = cacheDir === null ? null : lastBuilds(cacheDir, projectRoot, { launched: launch === null ? null : 'ios' })
const babelFor = projectBabel(projectRoot, project, fail, { sourceMaps: true, refresh: runtime === null ? null : refreshPlugin, babelRCLookup: metro.babelRCLookup, babelRuntime: metro.babelRuntime, maxWorkers: maxWorkersOf(values['max-workers'], metro, fail), fingerprint: cacheDir !== null })
if (esm.on && babelFor === null) fail(`${esm.by} keeps ES modules through the project's Babel config, and it has none`)
if (babelFor !== null && values['babel-aliases'] !== undefined) fail("--babel-aliases maps the imports where no Babel runs: the project's Babel config has its aliases")
const stripFlow = flowStripper(project, babelFor !== null)
const loadCache = cacheDir === null ? null : createLoadCache(cacheDir, { esbuild, flow: stripFlow === null ? null : project.locate('flow-remove-types') })
const aliases = values['babel-aliases'] === undefined ? null : babelAliases(projectRoot, values['babel-aliases'], fail)
const devMiddleware = locateThrough(project, '@react-native/dev-middleware', ['react-native', '@react-native/community-cli-plugin'])

// The dev bundler, its server, and the watch that rebuilds on a change.
let pruned = null
const devBundler = createDevBundler({
  projectRoot,
  esbuild,
  metro,
  runtime,
  injected: devMiddleware === null ? [] : [REPORTER],
  targetOptions: (target) => {
    const babel = babelFor?.(target) ?? null
    return { stripFlow, ...babel, aliases, esm: esm.on, define: defines(target.dev, values.define, fail), store: loadCache?.(babel) ?? null }
  },
  onBuild: built,
})
// Colors only where stdout supports them.
const style = (format, text) => styleText(format, text, { stream: process.stdout })
const { host } = values
const gate = createGate({ hostnames: hostnamesOf(host, hostname()) })
const devServer = createDevServer({ projectRoot, watchFolders: metro.watchFolders ?? [projectRoot], esbuild, devBundler: last?.served(devBundler) ?? devBundler, gate, log, clientLogs: values['client-logs'], style })
const reloadApps = () => log(`rn-serve: reloading ${devServer.broadcast('reload')} app(s)`)
// A change rebuilds every bundle, 50 ms after the last one, a refresh at a time.
let timer = null
let refreshing = Promise.resolve()
const watcher = createWatcher(projectRoot, (path, event) => {
  devBundler.changed(path, event)
  clearTimeout(timer)
  timer = setTimeout(() => {
    refreshing = refreshing.then(refresh).catch((error) => log(`rn-serve: ${error?.stack ?? error}`))
  }, 50)
}, { onError: (error) => log(`rn-serve: can't watch: ${error.message}`) })

const wildcard = host === '0.0.0.0' || host === '::'
const urlHost = wildcard ? '127.0.0.1' : isIP(host) === 6 ? `[${host}]` : host
const { server } = devServer
server.on('error', portTaken)
server.listen(port, host, () => {
  const location = `${urlHost}:${server.address().port}`
  const serverUrl = `http://${location}`
  log(`rn-serve: ${serverUrl} for ${projectRoot} (esbuild ${esbuild.version})`)
  if (!isLoopback(host)) log(`rn-serve: ${wildcard ? 'on every network interface' : `on ${host}`}: anyone on the network can fetch the app and its source${devMiddleware === null ? '' : ', and debug the app: run code in it, and have the server fetch a URL'}`)
  if (metro.file === null && metro.polyfills(null).length === 0) log('rn-serve: no @react-native/js-polyfills: bundles have no polyfills')
  if (devMiddleware === null) log('rn-serve: no @react-native/dev-middleware: no debugger')
  else mountDebugger(serverUrl)
  if (runtime === null) log('rn-serve: no metro-runtime: no Fast Refresh, a change reloads the app')
  else if (babelFor !== null && refreshPlugin === null) log("rn-serve: no react-refresh: Fast Refresh keeps no component's state")
  if (process.stdin.isTTY) keys(serverUrl)
  if (values.warm) void last?.warm(devBundler, log)
  if (launch !== null) {
    launchIos({ ...launch, location, log }).then(({ bundleId, simulator }) => log(`rn-serve: launched ${bundleId} on ${simulator.name}`), (error) => log(`rn-serve: can't launch the app: ${error.message}`))
  }
})

// The app to launch (--launch, else rn.config.json's launch), or null. Without simctl,
// rn.config.json's launch is only warned of; --launch fails.
function launchOf() {
  // parseArgs may give --no-launch as launch: false or as no-launch.
  const flag = values['no-launch'] || values.launch === false ? false : values.launch
  if (typeof flag === 'string' && flag !== 'ios') fail(`--launch takes ios, not ${flag}`)
  if (!(flag ?? rnConfig.launch)) {
    if (values.simulator !== undefined || values['binary-path'] !== undefined) fail('--simulator and --binary-path are of --launch=ios')
    return null
  }
  if (spawnSync('xcrun', ['--find', 'simctl'], { stdio: 'ignore' }).status !== 0) {
    if (flag !== undefined) fail("--launch=ios needs Xcode's simctl (xcrun --find simctl)")
    log("rn-serve: no Xcode's simctl (xcrun --find simctl): rn.config.json's launch launches nothing here")
    return null
  }
  const given = values['binary-path'] ?? rnConfig.ios?.binaryPath
  if (given === undefined) fail("--launch=ios installs the app of --binary-path, else of rn.config.json's ios.binaryPath: give one, a simulator's build of it (an .app)")
  const appPath = resolve(projectRoot, given)
  const by = values['binary-path'] === undefined ? "rn.config.json's ios.binaryPath" : '--binary-path'
  if (!existsSync(join(appPath, 'Info.plist'))) fail(`${by}: no app at ${given}, an .app of its Info.plist`)
  return { appPath, simulator: values.simulator ?? rnConfig.ios?.simulator ?? null }
}

// Why a missed file wasn't cached, by load-cache.js's reason.
const UNKEPT = { fingerprint: "without a fingerprint of Babel's config", config: 'of a Babel config with no key', external: "of a plugin's files of its own", failed: 'failed' }
const counted = (count, one, many) => `${count} ${count === 1 ? one : many}`
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`

// A build's log suffix: its time and the cache's tally (`cached`, null when there's no cache).
function status(ms, cached) {
  if (cached === null) return `in ${seconds(ms)}, cache: off`
  const { hits, misses, memory, unkept, ms: taken } = cached
  const why = Object.entries(unkept).map(([reason, count]) => `${count} ${UNKEPT[reason] ?? reason}`).join(', ')
  return `in ${seconds(ms)}, cache ${seconds(taken)}: ${counted(hits, 'hit', 'hits')}, ${counted(misses, 'miss', 'misses')}${memory === 0 ? '' : `, ${memory} unchanged in memory`}${why === '' ? '' : ` (not cached: ${why})`}`
}

// Logs each build, built or failed.
function built({ request, outcome, ms, cached }) {
  watcher.update(devBundler.files())
  // Prune once per run, after the first build has touched its packs; also drop the old Babel-only cache.
  if (cacheDir !== null) pruned ??= prune(cacheDir, { before: [usersOwn('rn-serve-babel')] })
  const what = `${bundleName(request)} ${status(ms, cached)}`
  if (outcome.ok) return log(`rn-serve: built ${what}`)
  return bundlingError(esbuild, outcome.errors, projectRoot).then(({ message }) => log(`rn-serve: failed to build ${what}:\n${message}`), (error) => log(`rn-serve: failed to build ${what}: ${error.message}`))
}

// Rebuilds every bundle. Apps get a hot update from their last good module-format build if its scripts
// (polyfills) are unchanged, else reload if the bundle changed. Each error goes once to the apps it fails.
async function refresh() {
  let reload = false
  let updated = 0
  const failed = []
  for (const { request, before, after, good } of await devBundler.refresh()) {
    if (after.ok && after.modules !== undefined && good?.modules !== undefined && after.scripts === good.scripts) updated += devServer.hotUpdate(request, good, after, { recovered: !before.ok })
    else if (after.ok && (!before.ok || before.js !== after.js)) reload = true
    else if (!after.ok && before !== after) failed.push({ request, error: await bundlingError(esbuild, after.errors, projectRoot) })
  }
  for (const each of Map.groupBy(failed, ({ error }) => error.message).values()) devServer.hotError(each[0].error, each.map(({ request }) => request))
  if (updated > 0) log(`rn-serve: updated ${updated} app(s)`)
  if (reload) reloadApps()
}

// The port is taken: by a dev server for this project, which is left to serve, as React Native does; else rn-serve fails.
async function portTaken({ code, message }) {
  if (code !== 'EADDRINUSE') fail(message)
  const response = await fetch(`http://${urlHost}:${port}/status`).catch(() => null)
  if ((await response?.text().catch(() => null)) !== 'packager-status:running') fail(`port ${port} is taken: pass another with --port`)
  // The header has the root percent-encoded, as a file URL's path.
  const header = response.headers.get('x-react-native-project-root')
  const root = header === null ? null : decodeURIComponent(header)
  if (root !== projectRoot) fail(`a dev server for ${root} is running on port ${port}: pass another with --port`)
  log(`rn-serve: a dev server for this project is running on port ${port} already`)
  process.exit(0)
}

// dev-middleware's debugger, with rn-serve's Network panel (src/network.js); with --devtools, DevTools open
// for each app as it connects. Its logger is called like console; control characters a device sends are escaped.
function mountDebugger(serverUrl) {
  const { network } = devServer
  const logged = (...args) => log(printable(printf(...args)))
  try {
    const mounted = project.load(devMiddleware).createDevMiddleware({
      serverBaseUrl: serverUrl,
      logger: { info: logged, warn: logged, error: logged },
      unstable_experiments: { enableNetworkInspector: true },
      unstable_customInspectorMessageHandler: network.handler,
    })
    const listen = (path, listener) => mounted.websocketEndpoints?.[path]?.prependListener?.('connection', listener)
    listen('/inspector/debug', network.debuggerConnected)
    if (devtools) {
      const opener = createDevToolsOpener((device) => void openDebugger(serverUrl, device))
      listen('/inspector/debug', opener.debuggerConnected)
      listen('/inspector/device', opener.deviceConnected)
    }
    devServer.mount(mounted)
  } catch (error) {
    log(`rn-serve: @react-native/dev-middleware fails, no debugger: ${error.message}`)
  }
}

// Stops at once: says nothing more, watches no more, takes no more requests, and tells each app the
// server is going away. Quits without waiting for builds (their output lives in memory only), but lets
// the cache finish the pack it's writing, which the next run needs, and the prune. A second signal
// quits at once.
let quitting = false
function quit() {
  if (quitting) process.exit(0)
  quitting = true
  quiet = true
  clearTimeout(timer)
  watcher?.close()
  devServer.close()
  void Promise.all([loadCache?.settled(), pruned]).finally(() => process.exit(0))
}
process.on('SIGINT', quit)
process.on('SIGTERM', quit)

// A terminal's keys, listed as rn-serve starts; ctrl-c and ctrl-d quit.
function keys(serverUrl) {
  const each = [
    // Built anew, each file resolved and read again, not as the watcher's changes leave the build before.
    {
      key: 'r',
      what: 'reload',
      action: () => {
        devBundler.changed()
        reloadApps()
      },
    },
    { key: 'd', what: 'dev menu', action: () => log(`rn-serve: dev menu on ${devServer.broadcast('devMenu')} app(s)`) },
    ...(devMiddleware === null ? [] : [{ key: 'j', what: 'debugger', action: () => void openDebugger(serverUrl) }]),
  ]
  log(`rn-serve: ${[...each, { key: 'ctrl-c', what: 'quit' }].map(({ key, what }) => `${style(['bold', 'cyan'], key)} ${what}`).join(style('dim', ' \u00B7 '))}`)
  emitKeypressEvents(process.stdin)
  process.stdin.setRawMode(true)
  process.stdin.on('keypress', (text, key) => {
    if (key?.ctrl && (key.name === 'c' || key.name === 'd')) {
      process.stdin.setRawMode(false)
      quit()
    } else {
      each.find((one) => one.key === text)?.action()
    }
  })
}

// As React Native's `j`: opens the debugger of the last connected app, or of `device`.
async function openDebugger(serverUrl, device = null) {
  try {
    const response = await fetch(`${serverUrl}/open-debugger${device === null ? '' : `?device=${encodeURIComponent(device)}`}`, { method: 'POST' })
    if (!response.ok) log(`rn-serve: no debugger: ${(await response.text()).trim()}`)
  } catch (error) {
    log(`rn-serve: no debugger: ${error.message}`)
  }
}
