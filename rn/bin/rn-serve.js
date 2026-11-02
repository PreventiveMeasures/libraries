#!/usr/bin/env node
// rn-serve [--port=8081] [--host=127.0.0.1] [--metro-config=FILE]
//   [--max-workers=N] [--define=K=V ...] [--babel-aliases=FILE] [--esm]
//   [--reset-cache] [--client-logs]
// A dev server for a React Native app, where Metro's would be: each bundle
// the app asks for built as rn-bundle builds it (for the platform, dev and
// minify of its URL), with Metro's prelude, polyfills and setup-env first,
// and a source map; its assets; LogBox's symbolication; reload and the dev
// menu (r, d), and with @react-native/dev-middleware installed, the debugger
// (j). A file a bundle was built from changed, each bundle is built anew,
// each file's transform kept in memory while its source is the same. Each
// file as it loads (its Flow stripped, lowered by esbuild, and the project's
// Babel config's output) is kept on disk too, across runs, in the OS's
// temporary directory, as Metro keeps its cache (rn-serve-cache-UID, the
// user's alone; rn-bundle keeps none): while the file, rn, esbuild,
// flow-remove-types, the lockfile, the Babel config the file has (the
// plugins left out of it, as --esm leaves one, among it), the code of
// @babel/core and of what the config loads or reads, NODE_ENV and BABEL_ENV
// are the same; each build logs, on its line, its time, and of the files it
// loaded, those the cache had (hits), those loaded anew (misses), those as
// they were in memory, and why one was kept none of. --reset-cache empties
// it first, as Metro's does its own. A dev
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

import { lstatSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { enableCompileCache } from 'node:module'
import { isIP } from 'node:net'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { emitKeypressEvents } from 'node:readline'
import { parseArgs } from 'node:util'

import { babelAliases, defines, failer, flowStripper, locateThrough, peers, projectBabel } from '../src/cli.js'
import { createDevBundler } from '../src/dev-bundler.js'
import { createGate } from '../src/gate.js'
import { createLoadCache } from '../src/load-cache.js'
import { maxWorkersOf, metroOptions } from '../src/metro-options.js'
import { bundlingError, createDevServer } from '../src/serve.js'
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
    esm: { type: 'boolean', default: false },
    'reset-cache': { type: 'boolean', default: false },
    'client-logs': { type: 'boolean', default: false },
  },
})

const fail = failer('rn-serve')
const log = (line) => process.stdout.write(`${line}\n`)
if (values.port !== undefined && (!/^\d+$/u.test(values.port) || Number(values.port) > 65_535)) fail(`--port takes a port, not ${values.port}`)
defines(true, values.define, fail)

const projectRoot = realpathSync(process.cwd())
const project = peers(projectRoot, fail)
const esbuild = project.peer('esbuild', 'bundling')
const metro = await metroOptions(projectRoot, project, fail, { file: values['metro-config'] ?? null, name: 'rn-serve', serving: true })
const port = values.port === undefined ? (metro.port ?? 8081) : Number(values.port)
// For Fast Refresh: the module system dev bundles are written for, and the
// plugin that has Babel register each component.
const runtime = locateThrough(project, 'metro-runtime/src/polyfills/require.js', ['react-native'])
const refreshPlugin = locateThrough(project, 'react-refresh/babel', ['react-native'])
const cacheDir = cacheDirOf(values['reset-cache'])
const babelFor = projectBabel(projectRoot, project, fail, { sourceMaps: true, refresh: runtime === null ? null : refreshPlugin, babelRCLookup: metro.babelRCLookup, babelRuntime: metro.babelRuntime, maxWorkers: maxWorkersOf(values['max-workers'], metro, fail), fingerprint: cacheDir !== null })
if (values.esm && babelFor === null) fail("--esm keeps ES modules through the project's Babel config, and it has none")
if (babelFor !== null && values['babel-aliases'] !== undefined) fail("--babel-aliases maps the imports where no Babel runs: the project's Babel config has its aliases")
const stripFlow = flowStripper(project, babelFor !== null)
const loadCache = cacheDir === null ? null : createLoadCache(cacheDir, { esbuild, flow: stripFlow === null ? null : project.locate('flow-remove-types'), cwd: projectRoot })
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
  targetOptions: ({ platform, dev, inlineRequires }) => {
    const babel = babelFor?.({ platform, dev, inlineRequires }) ?? null
    return { stripFlow, ...babel, aliases, esm: values.esm, define: defines(dev, values.define, fail), store: loadCache?.(babel) ?? null }
  },
  onBuild: ({ request, outcome, ms, cached }) => {
    watcher?.update(devBundler.files())
    const what = `${request.entryFile} for ${request.platform ?? 'no platform'}${request.dev ? ', dev' : ''}${request.minify ? ', minified' : ''} ${status(ms, cached)}`
    if (outcome.ok) return log(`rn-serve: built ${what}`)
    return bundlingError(esbuild, outcome.errors, projectRoot).then(({ message }) => log(`rn-serve: failed to build ${what}:\n${message}`), (error) => log(`rn-serve: failed to build ${what}: ${error.message}`))
  },
})
const devServer = createDevServer({ projectRoot, watchFolders: metro.watchFolders ?? [projectRoot], esbuild, devBundler, gate, log, clientLogs: values['client-logs'] })

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
})

// Why a file loaded anew was kept none of (loadCached()'s).
const UNKEPT = { fingerprint: "without a fingerprint of Babel's config", config: 'of a Babel config with no key', external: "of a plugin's files of its own", failed: 'failed' }
const counted = (count, one, many) => `${count} ${count === 1 ? one : many}`

// A build's status, on its line: its time, and of the files it loaded, those
// the cache had, those loaded anew, those as they were in memory, and why
// one loaded anew was kept none of; `cached`, the store's tally(), null
// where there is none.
function status(ms, cached) {
  if (cached === null) return `in ${ms} ms, cache: off`
  const { hits, misses, memory, unkept } = cached
  const why = Object.entries(unkept).map(([reason, count]) => `${count} ${UNKEPT[reason] ?? reason}`).join(', ')
  return `in ${ms} ms, cache: ${counted(hits, 'hit', 'hits')}, ${counted(misses, 'miss', 'misses')}${memory === 0 ? '' : `, ${memory} unchanged in memory`}${why === '' ? '' : ` (not cached: ${why})`}`
}

// The directory each file as it loads is kept in across runs: the user's
// own, in the OS's temporary directory, as Metro keeps its cache; emptied
// first with --reset-cache. null, none kept, where it is another user's, or
// another may write in it: the bundles would run what they put there.
function cacheDirOf(reset) {
  const uid = process.getuid?.() ?? null
  const dir = join(tmpdir(), uid === null ? 'rn-serve-cache' : `rn-serve-cache-${uid}`)
  try {
    if (reset) rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const stat = lstatSync(dir)
    if (uid === null || (stat.isDirectory() && stat.uid === uid && (stat.mode & 0o022) === 0)) return dir
  } catch {
    // Not there, and can't be made.
  }
  log(`rn-serve: keeping no files across runs: ${dir} is not this user's alone`)
  return null
}

function mountDebugger(serverUrl) {
  try {
    devServer.mount(project.load(devMiddleware).createDevMiddleware({ serverBaseUrl: serverUrl, logger: { info: log, warn: log, error: log } }))
  } catch (error) {
    log(`rn-serve: @react-native/dev-middleware fails, no debugger: ${error.message}`)
  }
}

function keys(serverUrl) {
  log(`rn-serve: r reload, d dev menu${devMiddleware === null ? '' : ', j debugger'}, ctrl-c quit`)
  emitKeypressEvents(process.stdin)
  process.stdin.setRawMode(true)
  process.stdin.on('keypress', (text, key) => {
    // At once, a build in progress though: what it would make is kept in
    // memory alone, and esbuild and Babel's workers end with the process.
    if (key?.ctrl && (key.name === 'c' || key.name === 'd')) {
      process.stdin.setRawMode(false)
      process.exit(0)
    } else if (text === 'r' || text === 'd') {
      const method = text === 'r' ? 'reload' : 'devMenu'
      log(`rn-serve: ${method} to ${devServer.broadcast(method)} app(s)`)
    } else if (text === 'j' && devMiddleware !== null) {
      void openDebugger(serverUrl)
    }
  })
}

// As React Native's `j`: the debugger of the app last connected.
async function openDebugger(serverUrl) {
  try {
    const response = await fetch(`${serverUrl}/open-debugger`, { method: 'POST' })
    if (!response.ok) log(`rn-serve: no debugger: ${(await response.text()).trim()}`)
  } catch (error) {
    log(`rn-serve: no debugger: ${error.message}`)
  }
}
