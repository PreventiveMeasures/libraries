#!/usr/bin/env node
// rn-serve [--port=8081] [--host=127.0.0.1] [--babel] [--define=K=V ...]
//   [--babel-aliases=FILE] [--client-logs]
// A dev server for a React Native app, where Metro's would be: each bundle
// the app asks for built as rn-bundle builds it (for the platform, dev and
// minify of its URL), with Metro's prelude, polyfills and setup-env first,
// and a source map; its assets; LogBox's symbolication; reload and the dev
// menu (r, d), and with @react-native/dev-middleware installed, the debugger
// (j). A file a bundle was built from changed, each bundle is built anew,
// each file's transform kept in memory while its source is the same, and the
// app reloads; no Fast Refresh. A build error is shown in the app.
// It answers the app and its tools, never another webpage (src/gate.js), on
// 127.0.0.1 unless --host: --host=0.0.0.0 for a device on Wi-Fi.

import { realpathSync } from 'node:fs'
import { isIP } from 'node:net'
import { hostname } from 'node:os'
import { emitKeypressEvents } from 'node:readline'
import { parseArgs } from 'node:util'

import { assetExts, babelAliases, defines, failer, flowStripper, locateThrough, peers, polyfills, projectBabel } from '../src/cli.js'
import { createDevBundler } from '../src/dev-bundler.js'
import { createGate } from '../src/gate.js'
import { bundlingError, createDevServer } from '../src/serve.js'
import { createWatcher } from '../src/watch.js'

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '8081' },
    host: { type: 'string', default: '127.0.0.1' },
    babel: { type: 'boolean', default: false },
    define: { type: 'string', multiple: true, default: [] },
    'babel-aliases': { type: 'string' },
    'client-logs': { type: 'boolean', default: false },
  },
})

const fail = failer('rn-serve')
const log = (line) => process.stdout.write(`${line}\n`)
const port = Number(values.port)
if (!/^\d+$/u.test(values.port) || port > 65_535) fail(`--port takes a port, not ${values.port}`)
if (values.babel && values['babel-aliases'] !== undefined) fail("--babel takes the aliases of the project's Babel config; --babel-aliases takes them from a file: pass one")
defines(true, values.define, fail)

const projectRoot = realpathSync(process.cwd())
const project = peers(projectRoot, fail)
const esbuild = project.peer('esbuild', 'bundling')
const stripFlow = flowStripper(project, values.babel)
const babelFor = values.babel ? projectBabel(projectRoot, project, fail, { sourceMaps: true }) : null
const aliases = values['babel-aliases'] === undefined ? null : babelAliases(projectRoot, values['babel-aliases'], fail)
const polyfillPaths = polyfills(project, fail)
const devMiddleware = locateThrough(project, '@react-native/dev-middleware', ['react-native', '@react-native/community-cli-plugin'])

const { host } = values
const wildcard = host === '0.0.0.0' || host === '::'
const machine = hostname().toLowerCase()
const gate = createGate({ hostnames: [machine, `${machine.replace(/\.local$/u, '')}.local`, ...(isIP(host) === 0 ? [host] : [])] })

let watcher = null
const devBundler = createDevBundler({
  projectRoot,
  esbuild,
  assetExts: assetExts(projectRoot, project, fail),
  polyfills: polyfillPaths,
  targetOptions: ({ platform, dev }) => ({
    stripFlow,
    ...babelFor?.({ platform, dev }),
    aliases,
    define: defines(dev, values.define, fail),
  }),
  onBuild: ({ request, outcome, ms }) => {
    watcher?.update(devBundler.files())
    const what = `${request.entryFile} for ${request.platform ?? 'no platform'}${request.dev ? ', dev' : ''}${request.minify ? ', minified' : ''}`
    if (outcome.ok) return log(`rn-serve: built ${what} in ${ms} ms`)
    return bundlingError(esbuild, outcome.errors, projectRoot).then(({ message }) => log(`rn-serve: failed to build ${what}:\n${message}`), (error) => log(`rn-serve: failed to build ${what}: ${error.message}`))
  },
})
const devServer = createDevServer({ projectRoot, esbuild, devBundler, gate, log, clientLogs: values['client-logs'] })

// A change: each bundle built anew; the apps reload where one is new, and see
// the error where one fails.
const refreshOnce = async () => {
  let reload = false
  const errors = new Map()
  for (const { before, after } of await devBundler.refresh()) {
    if (after.ok && (!before.ok || before.js !== after.js)) reload = true
    if (after.ok || before === after) continue
    const error = await bundlingError(esbuild, after.errors, projectRoot)
    errors.set(error.message, error)
  }
  // Each error once, however many bundles it fails.
  for (const error of errors.values()) devServer.hotError(error)
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
  if (polyfillPaths.length === 0) log("rn-serve: no @react-native/js-polyfills, as @react-native/metro-config has it: bundles have Metro's prelude but no polyfills")
  if (devMiddleware === null) log('rn-serve: no @react-native/dev-middleware, as react-native has it: no debugger')
  else mountDebugger(serverUrl)
  if (process.stdin.isTTY) keys(serverUrl)
})

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
    if (key?.ctrl && (key.name === 'c' || key.name === 'd')) {
      process.stdin.setRawMode(false)
      watcher.close()
      server.close()
      server.closeAllConnections()
      void quit()
    } else if (text === 'r' || text === 'd') {
      const method = text === 'r' ? 'reload' : 'devMenu'
      log(`rn-serve: ${method} to ${devServer.broadcast(method)} app(s)`)
    } else if (text === 'j' && devMiddleware !== null) {
      void openDebugger(serverUrl)
    }
  })
}

async function quit() {
  await devBundler.dispose()
  process.exit(0)
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
