#!/usr/bin/env node
// rn-serve [--port=8081] [--host=127.0.0.1] [--metro-config=FILE]
//   [--max-workers=N] [--define=K=V ...] [--babel-aliases=FILE]
//   [--esm | --no-esm] [--dev-tools | --no-dev-tools] [--reset-cache]
//   [--no-warm] [--no-client-logs]
// A dev server for a React Native app, where Metro's would be: each bundle
// the app asks for built as rn-bundle builds it (for the platform, dev and
// minify of its URL), with Metro's prelude, polyfills and setup-env first,
// and a source map; its assets; LogBox's symbolication; each app's console,
// as Metro's terminal prints it, each line labelled ` LOG `, ` WARN `, ...
// (but --no-client-logs); reload and the dev
// menu (r, d), and with @react-native/dev-middleware installed, the debugger
// (j; with --dev-tools, opened for each app as it connects, unless DevTools
// are connected to its device already: src/devtools.js), its Network panel
// on: where the app's runtime reports no requests
// (React Native before 0.83), each dev bundle in Metro's module format has
// a reporter of rn's, which tells rn-serve of each request an XMLHttpRequest
// makes (fetch's too), which rn-serve shows the panel (src/network.js). A
// file a bundle was built from changed, each bundle is built anew, each
// file's transform kept in memory while its source is the same. Each
// file as it loads (its Flow stripped, lowered by esbuild, and the project's
// Babel config's output) is kept on disk too, across runs, in the OS's
// temporary directory, as Metro keeps its cache (rn-serve-cache-UID, the
// user's alone; rn-bundle keeps none): while the file, rn, esbuild,
// flow-remove-types and its dependencies, the Babel config the file has (the
// plugins left out of it, as --esm leaves one, among it), the code of
// @babel/core and of what the config loads or reads, the versions of the
// packages they depend on (not the lockfile: a package the app adds is of
// none of it), NODE_ENV and BABEL_ENV
// are the same; each build logs, on its line, its time, and of the files it
// loaded, those the cache had (hits), those loaded anew (misses), those as
// they were in memory, and why one was kept none of. --reset-cache empties
// it first, as Metro's does its own. As it starts, it builds, ahead of the
// app, the bundles an app asked for of its last run; of none, the project's
// one bundle (the one its native project names, else its index), for iOS
// on a Mac, else for Android; --no-warm builds none. A dev
// bundle is in Metro's module format, with metro-runtime's require (that
// react-native has): each app of one gets what changed, as Metro's Fast
// Refresh sends it, where the project's Babel config runs each component of
// the project's built with react-refresh's Babel plugin (react-native's) for
// it to refresh; an app of another bundle reloads. Without Babel, a
// metro-runtime before 0.83.3 (react-native before 0.81) reloads the app on
// an edit of an ES module: esbuild makes its exports getters, which that
// runtime takes for no refresh boundary. A build error is shown in the app.
// --esm, as rn-bundle's: Babel leaves import and export to esbuild, which
// links the modules of a bundle it builds whole (minified, or of no dev), and
// makes each of a dev bundle CommonJS itself, its exports getters: so that
// runtime reloads the app on an edit of one too.
// The project's Metro config is loaded as rn-bundle loads it, its server's
// port the default of --port, its maxWorkers of --max-workers (how many
// workers each bundle's Babel runs in at most, as rn-bundle's), and an
// option of its server or symbolicator not as Metro's default an error too.
// It answers the app and its tools, never another webpage (src/gate.js), on
// 127.0.0.1 unless --host: --host=0.0.0.0 for a device on Wi-Fi.
// The project's rn.config.json (src/rn-config.js) has the defaults of
// --esm (its esm), --dev-tools (its devTools), --max-workers (its
// maxWorkers, over the Metro config's) and of the Metro config (its
// metroConfig: false, none, as of a project with none, but a package's
// exports read of any Metro; a path, that file), the flags over it; and
// what it adds to Metro's defaults of assetExts, sourceExts and
// assetResolutions (a Metro config that sets one of them otherwise, an error).

import { realpathSync } from 'node:fs'
import { enableCompileCache } from 'node:module'
import { isIP } from 'node:net'
import { hostname } from 'node:os'
import { emitKeypressEvents } from 'node:readline'
import { parseArgs, format as printf, styleText } from 'node:util'

import { babelAliases, defines, failer, flowStripper, locateThrough, peers, projectBabel } from '../src/cli.js'
import { createDevBundler } from '../src/dev-bundler.js'
import { createDevToolsOpener } from '../src/devtools.js'
import { createGate } from '../src/gate.js'
import { createLoadCache } from '../src/load-cache.js'
import { prune } from '../src/load-prune.js'
import { maxWorkersOf, metroOptions } from '../src/metro-options.js'
import { REPORTER } from '../src/network.js'
import { extendedMetro, flagOf, metroConfigOf, readRnConfig } from '../src/rn-config.js'
import { bundlingError, createDevServer } from '../src/serve.js'
import { bundleName, cacheDirOf, lastBuilds, usersOwn } from '../src/serve-cache.js'
import { createWatcher } from '../src/watch.js'

// Node's cache of the code it compiles, on disk, as tsc has it: the
// project's @babel/core, esbuild's API and Metro's config, loaded below,
// compiled once of each version (NODE_DISABLE_COMPILE_CACHE=1 leaves it off).
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
    'dev-tools': { type: 'boolean' },
    'reset-cache': { type: 'boolean', default: false },
    warm: { type: 'boolean', default: true },
    'client-logs': { type: 'boolean', default: true },
  },
  allowNegative: true,
})

const fail = failer('rn-serve')
const log = (line) => process.stdout.write(`${line}\n`)
if (values.port !== undefined && (!/^\d+$/u.test(values.port) || Number(values.port) > 65_535)) fail(`--port takes a port, not ${values.port}`)
defines(true, values.define, fail)

const projectRoot = realpathSync(process.cwd())
const rnConfig = readRnConfig(projectRoot, fail)
const esm = flagOf(values.esm, rnConfig, 'esm', 'esm')
const devTools = flagOf(values['dev-tools'], rnConfig, 'devTools', 'dev-tools').on
const project = peers(projectRoot, fail)
const esbuild = project.peer('esbuild', 'bundling')
const metro = extendedMetro(await metroOptions(projectRoot, project, fail, { file: metroConfigOf(values['metro-config'], rnConfig), name: 'rn-serve', serving: true }), rnConfig, fail)
const port = values.port === undefined ? (metro.port ?? 8081) : Number(values.port)
// For Fast Refresh: the module system dev bundles are written for, and the
// plugin that has Babel register each component.
const runtime = locateThrough(project, 'metro-runtime/src/polyfills/require.js', ['react-native'])
const refreshPlugin = locateThrough(project, 'react-refresh/babel', ['react-native'])
const cacheDir = cacheDirOf(values['reset-cache'], log)
const last = cacheDir === null ? null : lastBuilds(cacheDir, projectRoot)
const babelFor = projectBabel(projectRoot, project, fail, { sourceMaps: true, refresh: runtime === null ? null : refreshPlugin, babelRCLookup: metro.babelRCLookup, babelRuntime: metro.babelRuntime, maxWorkers: maxWorkersOf(values['max-workers'], metro, fail), fingerprint: cacheDir !== null })
if (esm.on && babelFor === null) fail(`${esm.by} keeps ES modules through the project's Babel config, and it has none`)
if (babelFor !== null && values['babel-aliases'] !== undefined) fail("--babel-aliases maps the imports where no Babel runs: the project's Babel config has its aliases")
const stripFlow = flowStripper(project, babelFor !== null)
let pruned = null
const loadCache = cacheDir === null ? null : createLoadCache(cacheDir, { esbuild, flow: stripFlow === null ? null : project.locate('flow-remove-types') })
const aliases = values['babel-aliases'] === undefined ? null : babelAliases(projectRoot, values['babel-aliases'], fail)
const devMiddleware = locateThrough(project, '@react-native/dev-middleware', ['react-native', '@react-native/community-cli-plugin'])

const { host } = values
const wildcard = host === '0.0.0.0' || host === '::'
const machine = hostname().toLowerCase()
const gate = createGate({ hostnames: [machine, `${machine.replace(/\.local$/u, '')}.local`, ...(isIP(host) === 0 ? [host] : [])] })

let watcher = null
const devBundler = createDevBundler({
  projectRoot,
  esbuild,
  metro,
  runtime,
  injected: devMiddleware === null ? [] : [REPORTER],
  targetOptions: ({ platform, dev, inlineRequires }) => {
    const babel = babelFor?.({ platform, dev, inlineRequires }) ?? null
    return { stripFlow, ...babel, aliases, esm: esm.on, define: defines(dev, values.define, fail), store: loadCache?.(babel) ?? null }
  },
  onBuild: ({ request, outcome, ms, cached }) => {
    watcher?.update(devBundler.files())
    // Once a run, its first build's packs read: of what no run uses, and
    // the cache of Babel's output alone, of before.
    if (cacheDir !== null) pruned ??= prune(cacheDir, { before: [usersOwn('rn-serve-babel')] })
    const what = `${bundleName(request)} ${status(ms, cached)}`
    if (outcome.ok) return log(`rn-serve: built ${what}`)
    return bundlingError(esbuild, outcome.errors, projectRoot).then(({ message }) => log(`rn-serve: failed to build ${what}:\n${message}`), (error) => log(`rn-serve: failed to build ${what}: ${error.message}`))
  },
})
// Each app's console, as Metro's terminal prints it, its labels colored
// where stdout is a terminal that takes them: but --no-client-logs.
const style = (format, text) => styleText(format, text, { stream: process.stdout })
const devServer = createDevServer({ projectRoot, watchFolders: metro.watchFolders ?? [projectRoot], esbuild, devBundler: last?.served(devBundler) ?? devBundler, gate, log, clientLogs: values['client-logs'], style })

// A change: each bundle built anew; the apps of one in the module format get
// what changed from the build they have (once a build no longer fails, though
// nothing did), those of another, or of one whose scripts changed (a
// polyfill), which no update defines anew, reload where it is new; and each
// sees the error where one fails.
const refreshOnce = async () => {
  let reload = false
  let updated = 0
  const errors = new Map()
  for (const { request, before, after, good } of await devBundler.refresh()) {
    if (after.ok && after.modules !== undefined && good?.modules !== undefined && after.scripts === good.scripts) updated += devServer.hotUpdate(request, good, after, { recovered: !before.ok })
    else if (after.ok && (!before.ok || before.js !== after.js)) reload = true
    if (after.ok || before === after) continue
    const error = await bundlingError(esbuild, after.errors, projectRoot)
    if (!errors.has(error.message)) errors.set(error.message, { error, requests: [] })
    errors.get(error.message).requests.push(request)
  }
  // Each error once, however many bundles it fails, to the apps of those.
  for (const { error, requests } of errors.values()) devServer.hotError(error, requests)
  if (updated > 0) log(`rn-serve: updated ${updated} app(s)`)
  if (reload) log(`rn-serve: reloading ${devServer.broadcast('reload')} app(s)`)
}
let refreshing = Promise.resolve()
const refresh = () => {
  refreshing = refreshing.then(refreshOnce).catch((error) => log(`rn-serve: ${error?.stack ?? error}`))
}
let timer = null
watcher = createWatcher(projectRoot, () => {
  devBundler.changed()
  clearTimeout(timer)
  timer = setTimeout(refresh, 50)
}, { onError: (error) => log(`rn-serve: can't watch: ${error.message}`) })

const urlHost = wildcard ? '127.0.0.1' : isIP(host) === 6 ? `[${host}]` : host
const { server } = devServer
server.on('error', async (error) => {
  if (error.code !== 'EADDRINUSE') fail(error.message)
  let running = null
  try {
    const response = await fetch(`http://${urlHost}:${port}/status`)
    running = [await response.text(), response.headers.get('x-react-native-project-root')]
  } catch {
    // No dev server.
  }
  if (running?.[0] !== 'packager-status:running') fail(`port ${port} is taken: pass another with --port`)
  // The header has the root as a file URL's path has it.
  const root = running[1] === null ? null : decodeURIComponent(running[1])
  if (root !== projectRoot) fail(`a dev server for ${root} is running on port ${port}: pass another with --port`)
  log(`rn-serve: a dev server for this project is running on port ${port} already`)
  process.exit(0)
})
server.listen(port, host, () => {
  const serverUrl = `http://${urlHost}:${server.address().port}`
  log(`rn-serve: ${serverUrl} for ${projectRoot} (esbuild ${esbuild.version})`)
  if (wildcard) log('rn-serve: on every network interface: anyone on the network can fetch the app and its source')
  if (metro.file === null && metro.polyfills(null).length === 0) log("rn-serve: no @react-native/js-polyfills, as @react-native/metro-config has it: bundles have Metro's prelude but no polyfills")
  if (devMiddleware === null) log('rn-serve: no @react-native/dev-middleware, as react-native has it: no debugger')
  else mountDebugger(serverUrl)
  if (runtime === null) log("rn-serve: no metro-runtime, as react-native has it: no Fast Refresh, a change reloads the app")
  else if (babelFor !== null && refreshPlugin === null) log("rn-serve: no react-refresh, as react-native has it: Fast Refresh keeps no component's state")
  if (process.stdin.isTTY) keys(serverUrl)
  if (values.warm) void last?.warm(devBundler, log)
})

// Why a file loaded anew was kept none of (loadCached()'s).
const UNKEPT = { fingerprint: "without a fingerprint of Babel's config", config: 'of a Babel config with no key', external: "of a plugin's files of its own", failed: 'failed' }
const counted = (count, one, many) => `${count} ${count === 1 ? one : many}`

// A build's status, on its line: its time, the time of it the cache took,
// and of the files it loaded, those the cache had, those loaded anew, those
// as they were in memory, and why one loaded anew was kept none of;
// `cached`, the store's tally, null where there is none.
function status(ms, cached) {
  const seconds = (each) => `${(each / 1000).toFixed(1)} s`
  if (cached === null) return `in ${seconds(ms)}, cache: off`
  const { hits, misses, memory, unkept, ms: taken } = cached
  const why = Object.entries(unkept).map(([reason, count]) => `${count} ${UNKEPT[reason] ?? reason}`).join(', ')
  return `in ${seconds(ms)}, cache ${seconds(taken)}: ${counted(hits, 'hit', 'hits')}, ${counted(misses, 'miss', 'misses')}${memory === 0 ? '' : `, ${memory} unchanged in memory`}${why === '' ? '' : ` (not cached: ${why})`}`
}

// With its Network panel, which rn-serve has show the app's requests where
// its runtime reports none (src/network.js): of each DevTools as it
// connects; with --dev-tools, DevTools opened for each app as it connects.
// Its logger, called as console is: a format string and its arguments.
function mountDebugger(serverUrl) {
  const { network } = devServer
  const logged = (...args) => log(printf(...args))
  try {
    const mounted = project.load(devMiddleware).createDevMiddleware({
      serverBaseUrl: serverUrl,
      logger: { info: logged, warn: logged, error: logged },
      unstable_experiments: { enableNetworkInspector: true },
      unstable_customInspectorMessageHandler: network.handler,
    })
    mounted.websocketEndpoints?.['/inspector/debug']?.prependListener?.('connection', network.debuggerConnected)
    if (devTools) {
      const opener = createDevToolsOpener((device) => void openDebugger(serverUrl, device))
      mounted.websocketEndpoints?.['/inspector/debug']?.prependListener?.('connection', opener.debuggerConnected)
      mounted.websocketEndpoints?.['/inspector/device']?.prependListener?.('connection', opener.deviceConnected)
    }
    devServer.mount(mounted)
  } catch (error) {
    log(`rn-serve: @react-native/dev-middleware fails, no debugger: ${error.message}`)
  }
}

// At once, a build in progress though: what it would make is kept in
// memory alone, and esbuild and Babel's workers end with the process; but
// a pack of the cache being written (load-cache.js's), written first, of
// which a run after would have none else, and the cache pruned. Asked
// again, at once.
let quitting = false
function quit() {
  if (quitting) process.exit(0)
  quitting = true
  void Promise.all([loadCache?.settled(), pruned]).finally(() => process.exit(0))
}
process.on('SIGINT', quit)
process.on('SIGTERM', quit)

function keys(serverUrl) {
  log(`rn-serve: r reload, d dev menu${devMiddleware === null ? '' : ', j debugger'}, ctrl-c quit`)
  emitKeypressEvents(process.stdin)
  process.stdin.setRawMode(true)
  process.stdin.on('keypress', (text, key) => {
    if (key?.ctrl && (key.name === 'c' || key.name === 'd')) {
      process.stdin.setRawMode(false)
      quit()
    } else if (text === 'r' || text === 'd') {
      const method = text === 'r' ? 'reload' : 'devMenu'
      log(`rn-serve: ${method} to ${devServer.broadcast(method)} app(s)`)
    } else if (text === 'j' && devMiddleware !== null) {
      void openDebugger(serverUrl)
    }
  })
}

// As React Native's `j`: the debugger of the app last connected; of
// `device`'s, where given.
async function openDebugger(serverUrl, device = null) {
  try {
    const response = await fetch(`${serverUrl}/open-debugger${device === null ? '' : `?device=${encodeURIComponent(device)}`}`, { method: 'POST' })
    if (!response.ok) log(`rn-serve: no debugger: ${(await response.text()).trim()}`)
  } catch (error) {
    log(`rn-serve: no debugger: ${error.message}`)
  }
}
