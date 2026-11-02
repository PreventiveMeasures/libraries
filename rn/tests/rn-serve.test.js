import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { request } from 'node:http'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { runInNewContext } from 'node:vm'

import { png, writeTree } from './fixtures.js'

const BIN = fileURLToPath(new URL('../bin/rn-serve.js', import.meta.url))
// The OS's temporary directory of each rn-serve, which keeps Babel's output
// there: the tests' own.
const TMP = mkdtempSync(join(tmpdir(), 'rn-serve-tmp-'))
after(() => rmSync(TMP, { recursive: true, force: true }))
const envOf = (dir) => ({ ...process.env, TMPDIR: dir, TMP: dir, TEMP: dir })
const linked = (name) => ({ link: realpathSync(fileURLToPath(new URL(`../node_modules/${name}`, import.meta.url))) })
const under = (dir, tree) => Object.fromEntries(Object.entries(tree).map(([path, content]) => [`${dir}/${path}`, content]))

const until = async (get, what, ms = 15_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) {
    const value = await get()
    if (value) return value
  }
  throw new Error(`timed out waiting for ${what}`)
}

// rn-serve on a free port, in `cwd`, of the temporary directory `tmp`, of
// no bundle built ahead of the app but where `warm`, of `env` over the
// environment. -> { url, output(), stop() }
async function serve(cwd, args = [], tmp = TMP, { warm = false, env = {} } = {}) {
  const child = spawn(process.execPath, [BIN, '--port=0', ...(warm ? [] : ['--no-warm']), ...args], { cwd, env: { ...envOf(tmp), ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  const collect = (data) => {
    out += data
  }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  const url = await until(() => /rn-serve: (http:\/\/\S+) for/u.exec(out)?.[1] ?? (child.exitCode === null ? null : assert.fail(out)), 'rn-serve to listen')
  return {
    url,
    output: () => out,
    stop: async () => {
      if (child.exitCode !== null) return
      child.kill()
      await once(child, 'exit')
    },
  }
}

// A request as a client sends it, any headers given. -> { status, headers, body }
const fetchRaw = (url, { method = 'GET', headers = {}, body, path } = {}) => new Promise((done, fail) => {
  const target = new URL(url)
  const req = request({ host: target.hostname, port: target.port, path: path ?? `${target.pathname}${target.search}`, method, headers })
  req.on('response', async (res) => {
    const chunks = []
    for await (const chunk of res) chunks.push(chunk)
    done({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
  })
  req.on('error', fail)
  req.end(body)
})

// An upgrade to a WebSocket. -> its status: 101 where accepted.
const upgradeStatus = (url, headers = {}) => new Promise((done) => {
  const target = new URL(url)
  const req = request({ host: target.hostname, port: target.port, path: target.pathname, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': Buffer.alloc(16, 7).toString('base64'), ...headers } })
  req.on('upgrade', (res, socket) => {
    socket.destroy()
    done(res.statusCode)
  })
  req.on('response', (res) => done(res.statusCode))
  req.on('error', (error) => done(error.code))
  req.end()
})

const socket = async (url) => {
  const ws = new WebSocket(url.replace(/^http/u, 'ws'))
  const messages = []
  ws.addEventListener('message', ({ data }) => messages.push(JSON.parse(String(data))))
  await once(ws, 'open')
  return { ws, messages }
}

// The bundle run in a context of its own. -> its globalThis.result, as JSON has it.
const run = (code, globals = {}) => {
  const context = { console: { log: () => {} }, ...globals }
  context.globalThis = context
  runInNewContext(code, context)
  return JSON.parse(JSON.stringify({ result: context.result }))
}

// Where a token is in generated code: 1-based line, 0-based column.
const positionOf = (code, token) => {
  const lines = code.split('\n')
  const line = lines.findIndex((text) => text.includes(token))
  assert.notEqual(line, -1, `no ${token} in the bundle`)
  return { lineNumber: line + 1, column: lines[line].indexOf(token) }
}

const APP = {
  'package.json': { name: 'app' },
  'index.js': [
    "import { where } from './lib/where'",
    "import { getAssetByID } from 'react-native/asset-registry'",
    "const logo = require('./img/logo.png')",
    'globalThis.result = { where, dev: __DEV__, env: process.env.NODE_ENV, order: globalThis.order, logo: getAssetByID(logo), started: typeof __BUNDLE_START_TIME__ }',
    'globalThis.boom = () => {',
    "  throw new Error('boom')",
    '}',
    '',
  ].join('\n'),
  'lib/where.ios.js': "export const where = 'ios'\n",
  'lib/where.android.js': "export const where = 'android'\n",
  'img/logo.png': png(20, 10),
  'img/logo@2x.png': png(40, 20),
  // Of an asset type, in the project, but in no bundle.
  'secret.yml': 'token: 1\n',
  'linked.js': { link: '/etc/hostname' },
  'node_modules/react-native/package.json': { name: 'react-native', version: '0.88.1', exports: { './asset-registry': './src/asset-registry.js', './setup-env': './src/setup-env.js' } },
  'node_modules/react-native/src/asset-registry.js': 'const assets = []\nexports.registerAsset = (asset) => assets.push(asset)\nexports.getAssetByID = (id) => assets[id - 1]\n',
  'node_modules/react-native/src/setup-env.js': '(globalThis.order ??= []).push("setup-env")\n',
  // The polyfills, as a dependency of @react-native/metro-config's has them.
  'node_modules/@react-native/metro-config/package.json': { name: '@react-native/metro-config', main: 'index.js' },
  'node_modules/@react-native/metro-config/index.js': "throw new Error('never run')\n",
  'node_modules/@react-native/metro-config/node_modules/@react-native/js-polyfills/package.json': { name: '@react-native/js-polyfills', main: 'index.js' },
  'node_modules/@react-native/metro-config/node_modules/@react-native/js-polyfills/index.js': "module.exports = () => [require.resolve('./polyfill.js')]\n",
  'node_modules/@react-native/metro-config/node_modules/@react-native/js-polyfills/polyfill.js': "'use strict'\n;(global.order ??= []).push('polyfill')\n",
}

describe('rn-serve', () => {
  const { root, cleanup } = writeTree({ ...under('app', APP), 'outside.js': "globalThis.result = 'outside'\n" })
  const app = join(root, 'app')
  let server
  before(async () => {
    server = await serve(app)
  })
  after(async () => {
    await server?.stop()
    cleanup()
  })
  const bundleUrl = (query = 'platform=ios') => `${server.url}/index.bundle?${query}`

  it('answers /status as Metro does, its project root named', async () => {
    const r = await fetchRaw(`${server.url}/status`)
    assert.deepEqual([r.status, String(r.body), r.headers['x-react-native-project-root']], [200, 'packager-status:running', realpathSync(app)])
    assert.deepEqual([r.headers['cross-origin-resource-policy'], r.headers['x-content-type-options']], ['same-origin', 'nosniff'])
  })

  it('builds the bundle a URL names: for its platform, dev unless told, polyfills and setup-env before the entry', async () => {
    const ios = await fetchRaw(bundleUrl())
    assert.equal(ios.status, 200)
    assert.match(ios.headers['content-type'], /^application\/javascript/u)
    const code = String(ios.body)
    assert.ok(code.startsWith("var __BUNDLE_START_TIME__=globalThis.nativePerformanceNow?nativePerformanceNow():Date.now(),__DEV__=true,process=globalThis.process||{},__METRO_GLOBAL_PREFIX__='';"))
    assert.ok(code.endsWith(`//# sourceMappingURL=${server.url}/index.map?platform=ios\n//# sourceURL=${server.url}/index.bundle//&platform=ios\n`))
    const { result } = run(code)
    assert.deepEqual({ ...result, logo: result.logo.httpServerLocation }, { where: 'ios', dev: true, env: 'development', order: ['polyfill', 'setup-env'], logo: '/assets/img', started: 'number' })
    const android = run(String((await fetchRaw(bundleUrl('platform=android&dev=false'))).body)).result
    assert.deepEqual([android.where, android.dev, android.env], ['android', false, 'production'])
    const minified = String((await fetchRaw(bundleUrl('platform=ios&minify=true'))).body)
    assert.ok(minified.length < code.length)
    assert.match(server.output(), /built \.\/index for ios, dev in \d+\.\d s/u)
  })

  it('streams a bundle to a client that takes multipart/mixed (the app), as Metro does: its progress, then it, or its error and status', async () => {
    const BOUNDARY = '3beqjf3apnqeu3h5jqorms4i'
    const parts = async (url) => {
      const { status, headers, body } = await fetchRaw(url, { headers: { Accept: 'multipart/mixed' } })
      assert.deepEqual([status, headers['content-type']], [200, `multipart/mixed; boundary="${BOUNDARY}"`])
      const text = String(body)
      assert.ok(text.endsWith(`\r\n--${BOUNDARY}--\r\n`))
      return text.slice(0, -`\r\n--${BOUNDARY}--\r\n`.length).split(`\r\n--${BOUNDARY}\r\n`).slice(1).map((part) => {
        const at = part.indexOf('\r\n\r\n')
        return { headers: Object.fromEntries(part.slice(0, at).split('\r\n').map((line) => line.split(': '))), body: part.slice(at + 4) }
      })
    }
    // Bundles not built yet: in the module format, and minified, by esbuild.
    for (const query of ['platform=android', 'platform=android&minify=true']) {
      const built = await parts(bundleUrl(query))
      const progress = built.slice(0, -1).map(({ headers, body }) => [headers['Content-Type'], JSON.parse(body)])
      assert.ok(progress.length > 0, query)
      for (const [type, { done, total, percent }] of progress) assert.ok(type === 'application/json' && done <= total && percent >= 0 && percent < 100, query)
      const { headers, body } = built.at(-1)
      assert.deepEqual([headers['Content-Type'], Number(headers['Content-Length']), headers['X-Http-Status']], ['application/javascript; charset=UTF-8', Buffer.byteLength(body), undefined])
      assert.equal(run(body).result.where, 'android')
    }
    const [missing] = await parts(`${server.url}/missing.bundle?platform=ios`)
    assert.deepEqual([missing.headers['X-Http-Status'], JSON.parse(missing.body).type], ['404', 'NotFoundError'])
  })

  it('serves its source map, each source named as Metro names it: by its absolute path', async () => {
    const r = await fetchRaw(`${server.url}/index.map?platform=ios`)
    assert.equal(r.status, 200)
    assert.equal(r.headers['access-control-allow-origin'], 'devtools://devtools')
    const { sources, sourcesContent } = JSON.parse(String(r.body))
    assert.ok(sources.includes(join(realpathSync(app), 'index.js')) && sourcesContent.length === sources.length, String(sources))
  })

  it('with sourcePaths=url-server and excludeSource, as the app asks where RN DevTools are on: each source at a path it serves it at, as Metro does, no contents', async () => {
    const query = 'platform=ios&dev=true&excludeSource=true&sourcePaths=url-server'
    await fetchRaw(bundleUrl(query))
    const map = JSON.parse(String((await fetchRaw(`${server.url}/index.map?${query}`)).body))
    const polyfill = '/[metro-project]/node_modules/@react-native/metro-config/node_modules/@react-native/js-polyfills/polyfill.js'
    assert.ok(['/[metro-project]/index.js', polyfill].every((source) => map.sources.includes(source)) && !('sourcesContent' in map), String(map.sources))
    assert.ok(map.x_google_ignoreList.includes(map.sources.indexOf(polyfill)) && !map.x_google_ignoreList.includes(map.sources.indexOf('/[metro-project]/index.js')))
    const source = await fetchRaw(`${server.url}/[metro-project]/index.js`)
    assert.deepEqual([source.status, source.headers['content-type'], source.headers['access-control-allow-origin'], String(source.body)], [200, 'text/plain; charset=UTF-8', 'devtools://devtools', APP['index.js']])
    assert.equal(String((await fetchRaw(`${server.url}${polyfill}`)).body), APP['node_modules/@react-native/metro-config/node_modules/@react-native/js-polyfills/polyfill.js'])
  })

  it("serves an asset of a bundle it built: the scale asked for, the next up, else the largest; and a range", async () => {
    await fetchRaw(bundleUrl())
    const asset = (path, headers) => fetchRaw(`${server.url}/assets/${path}?platform=ios&hash=x`, { headers })
    const one = await asset('img/logo.png')
    assert.deepEqual([one.status, one.headers['content-type'], one.body], [200, 'image/png', Buffer.from(APP['img/logo.png'])])
    assert.deepEqual((await asset('img/logo@2x.png')).body, Buffer.from(APP['img/logo@2x.png']))
    assert.deepEqual((await asset('img/logo@3x.png')).body, Buffer.from(APP['img/logo@2x.png']))
    const range = await asset('img/logo.png', { Range: 'bytes=0-7' })
    assert.deepEqual([range.status, range.headers['content-range'], range.body], [206, 'bytes 0-7/33', Buffer.from(APP['img/logo.png']).subarray(0, 8)])
  })

  it('serves no other file: no asset of no bundle, nothing out of the project', async () => {
    for (const path of ['/assets/secret.yml', '/assets/package.json', '/assets/../package.json', '/assets/img/../../outside.js', '/package.json', '/index.js', '/assets/%2e%2e/outside.js', '/[metro-project]/secret.yml', '/[metro-project]/linked.js', '/[metro-project]/../outside.js', '/[metro-project]/..%2Foutside.js', '/[metro-watchFolders]/0/secret.yml', '/[metro-watchFolders]/1/outside.js']) {
      assert.equal((await fetchRaw(`${server.url}${path}?platform=ios`)).status, 404, path)
    }
    // A request for another origin's URL is no request of ours.
    assert.equal((await fetchRaw(server.url, { path: 'http://evil.example/index.bundle?platform=ios' })).status, 400)
    for (const entry of ['/..%2Foutside.bundle', '/linked.bundle', '/nowhere.bundle', '/index.bundle?bundleEntry=../outside.bundle']) {
      const r = await fetchRaw(`${server.url}${entry}${entry.includes('?') ? '&' : '?'}platform=ios`)
      assert.equal(r.status, 404, entry)
      assert.equal(JSON.parse(String(r.body)).type, 'NotFoundError')
    }
  })

  it('symbolicates a frame of a bundle it built, with a code frame', async () => {
    const code = String((await fetchRaw(bundleUrl())).body)
    const frame = { file: `${server.url}/index.bundle//&platform=ios`, methodName: 'boom', ...positionOf(code, 'throw new Error("boom")') }
    const r = await fetchRaw(`${server.url}/symbolicate`, { method: 'POST', body: JSON.stringify({ stack: [frame, { file: 'http://elsewhere/x.bundle', lineNumber: 1, column: 1 }] }) })
    assert.equal(r.status, 200)
    const { stack, codeFrame } = JSON.parse(String(r.body))
    assert.deepEqual(stack[0], { file: join(realpathSync(app), 'index.js'), lineNumber: 6, column: 2, methodName: 'boom', collapse: false })
    assert.deepEqual(stack[1], { file: 'http://elsewhere/x.bundle', lineNumber: 1, column: 1, collapse: false })
    assert.deepEqual(codeFrame.location, { row: 6, column: 2 })
    assert.match(codeFrame.content, /^>6 \| {3}throw new Error\('boom'\)\n {3}\| {3}\^$/mu)
    const bad = await fetchRaw(`${server.url}/symbolicate`, { method: 'POST', body: '{"stack":[1]}' })
    assert.deepEqual([bad.status, JSON.parse(String(bad.body)).error], [400, 'Bad frame at line 0: Expected frame to be a JSON object'])
    assert.equal((await fetchRaw(`${server.url}/symbolicate`, { method: 'POST', body: 'x'.repeat(2 * 1024 * 1024) }).catch(() => ({ status: 413 }))).status, 413)
  })

  it('refuses webpages: another site, another origin, a rebound name, over HTTP and WebSocket', async () => {
    const port = new URL(server.url).port
    for (const headers of [{ 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }, { Origin: 'https://evil.example' }, { Origin: `http://localhost:${Number(port) + 1}` }, { Host: `attacker.example:${port}` }]) {
      const r = await fetchRaw(bundleUrl(), { headers })
      assert.deepEqual([r.status, r.headers['content-type']], [403, 'text/plain; charset=UTF-8'], JSON.stringify(headers))
      assert.equal((await fetchRaw(`${server.url}/reload`, { method: 'POST', headers })).status, 403)
      for (const path of ['/message', '/hot']) assert.equal(await upgradeStatus(`${server.url}${path}`, headers), 403, `${path} ${JSON.stringify(headers)}`)
    }
    assert.equal((await fetchRaw(bundleUrl(), { headers: { Origin: server.url, 'Sec-Fetch-Site': 'same-origin' } })).status, 200)
    assert.equal(await upgradeStatus(`${server.url}/message`, { Origin: server.url }), 101)
  })

  it('reloads the apps on a change, and shows them a build error', async () => {
    await fetchRaw(bundleUrl())
    const message = await socket(`${server.url}/message?device=d&app=a`)
    const hot = await socket(`${server.url}/hot?bundleEntry=index.bundle&platform=ios`)
    hot.ws.send(JSON.stringify({ type: 'register-entrypoints', entryPoints: [bundleUrl()] }))
    await until(() => hot.messages.length === 3, 'bundle-registered')
    // An Android app, which an error of iOS's alone is none of.
    const android = await socket(`${server.url}/hot?bundleEntry=index.bundle&platform=android`)
    android.ws.send(JSON.stringify({ type: 'register-entrypoints', entryPoints: [bundleUrl('platform=android')] }))
    await until(() => android.messages.length === 3, "Android's bundle-registered")
    assert.deepEqual(hot.messages, [{ type: 'update-start', body: { isInitialUpdate: true } }, { type: 'update-done', body: {} }, { type: 'bundle-registered' }])
    const where = join(app, 'lib/where.ios.js')
    writeFileSync(where, "export const where = 'ios, changed'\n")
    await until(() => message.messages.length > 0, 'a reload')
    assert.deepEqual(message.messages, [{ version: 2, method: 'reload' }])
    assert.equal(run(String((await fetchRaw(bundleUrl())).body)).result.where, 'ios, changed')
    writeFileSync(where, "export const where = 'ios\n")
    await until(() => hot.messages.length > 3, 'a build error')
    await sleep(200)
    // One, though two bundles (dev, and minified) fail; none to Android.
    assert.equal(hot.messages.length, 4)
    assert.equal(android.messages.length, 3)
    const { type, body } = hot.messages[3]
    assert.deepEqual([type, body.type, body.filename, body.lineNumber], ['error', 'TransformError', where, 1])
    assert.match(body.message, /lib\/where\.ios\.js: Unexpected token/u)
    const failed = await fetchRaw(bundleUrl())
    assert.deepEqual([failed.status, JSON.parse(String(failed.body)).filename], [500, where])
    writeFileSync(where, APP['lib/where.ios.js'])
    await until(() => message.messages.length > 1, 'a reload once fixed')
    message.ws.close()
    hot.ws.close()
    android.ws.close()
  })

  it('reloads each app on /reload, as the CLI does', async () => {
    const message = await socket(`${server.url}/message`)
    assert.equal(String((await fetchRaw(`${server.url}/reload`)).body), 'OK')
    await until(() => message.messages.length === 1, 'a reload')
    message.ws.close()
  })

  it("prints each app's console as Metro's terminal does, by default: each line labelled by its level, of its mode where not the bridge", async () => {
    const hot = await socket(`${server.url}/hot?bundleEntry=index.bundle&platform=ios`)
    try {
      const send = (level, mode, ...data) => hot.ws.send(JSON.stringify({ type: 'log', level, mode, data }))
      send('warn', 'BRIDGE', 'careful', '1')
      send('log', 'NOBRIDGE', 'hello  ')
      const printed = () => stripVTControlCharacters(server.output())
      await until(() => /^ \(NOBRIDGE\) LOG {2}hello$/mu.test(printed()), "the app's console")
      assert.match(printed(), /^ WARN {2}careful 1$/mu)
    } finally {
      hot.ws.close()
    }
  })

  it('leaves a port another dev server has, as RN does', () => {
    const port = new URL(server.url).port
    const same = spawnSync(process.execPath, [BIN, `--port=${port}`], { cwd: app, encoding: 'utf8' })
    assert.deepEqual([same.status, same.stdout.trim()], [0, `rn-serve: a dev server for this project is running on port ${port} already`])
    const other = spawnSync(process.execPath, [BIN, `--port=${port}`], { cwd: root, encoding: 'utf8' })
    assert.equal(other.status, 1)
    assert.match(other.stderr, /a dev server for .*app is running on port/u)
  })
})

describe('rn-serve, of a manifest edited', () => {
  const { root, cleanup } = writeTree({
    'package.json': { name: 'app' },
    'index.js': "globalThis.result = require('dep')\n",
    'node_modules/dep/package.json': { name: 'dep', main: 'a.js' },
    'node_modules/dep/a.js': "module.exports = 'a'\n",
    'node_modules/dep/b.js': "module.exports = 'b'\n",
    // An import of a module not there yet, beside a file no build reads.
    'later.js': "globalThis.result = require('./src/later')\n",
    'src/other.txt': '',
  })
  let server
  before(async () => {
    server = await serve(root)
  })
  after(async () => {
    await server?.stop()
    cleanup()
  })

  it('builds anew and reloads the apps where a package.json the resolver read is edited in place', async () => {
    const bundleUrl = `${server.url}/index.bundle?platform=ios`
    assert.equal(run(String((await fetchRaw(bundleUrl)).body)).result, 'a')
    const message = await socket(`${server.url}/message`)
    writeFileSync(join(root, 'node_modules/dep/package.json'), JSON.stringify({ name: 'dep', main: 'b.js' }))
    await until(() => message.messages.length > 0, 'a reload')
    assert.equal(run(String((await fetchRaw(bundleUrl)).body)).result, 'b')
    message.ws.close()
  })

  it('builds the entry the URL names now, and reloads the apps, where a platform file is added or removed beside it', async () => {
    const bundleUrl = `${server.url}/index.bundle?platform=ios`
    await fetchRaw(bundleUrl)
    const message = await socket(`${server.url}/message`)
    writeFileSync(join(root, 'index.ios.js'), "globalThis.result = 'ios'\n")
    await until(() => message.messages.length > 0, 'a reload for index.ios.js')
    assert.equal(run(String((await fetchRaw(bundleUrl)).body)).result, 'ios')
    rmSync(join(root, 'index.ios.js'))
    await until(() => message.messages.length > 1, 'a reload for index.js again')
    assert.equal(run(String((await fetchRaw(bundleUrl)).body)).result, 'b')
    message.ws.close()
  })

  it('builds anew and reloads the apps where a module an import names is made', async () => {
    const bundleUrl = `${server.url}/later.bundle?platform=ios`
    assert.equal((await fetchRaw(bundleUrl)).status, 500)
    const message = await socket(`${server.url}/message`)
    writeFileSync(join(root, 'src/later.js'), "module.exports = 'later'\n")
    await until(() => message.messages.length > 0, 'a reload for src/later.js')
    assert.equal(run(String((await fetchRaw(bundleUrl)).body)).result, 'later')
    message.ws.close()
  })
})

describe('rn-serve, of an app in a workspace', () => {
  // node_modules hoisted to the workspace's root, and an asset of a package
  // beside the app, out of its root: at /assets/../shared.
  const { root, cleanup } = writeTree({
    'node_modules/react-native/package.json': APP['node_modules/react-native/package.json'],
    'node_modules/react-native/src/asset-registry.js': APP['node_modules/react-native/src/asset-registry.js'],
    'node_modules/react-native/src/setup-env.js': '',
    'shared/logo.png': png(20, 10),
    'app/package.json': { name: 'app' },
    'app/index.js': "const { getAssetByID } = require('react-native/asset-registry')\nglobalThis.result = getAssetByID(require('../shared/logo.png')).httpServerLocation\n",
  })
  let server
  before(async () => {
    server = await serve(join(root, 'app'))
  })
  after(async () => {
    await server?.stop()
    cleanup()
  })

  it('serves an asset out of the project root that a bundle has, at the path the bundle names', async () => {
    assert.equal(run(String((await fetchRaw(`${server.url}/index.bundle?platform=ios`)).body)).result, '/assets/../shared')
    const r = await fetchRaw(server.url, { path: '/assets/../shared/logo.png?platform=ios&hash=x' })
    assert.deepEqual([r.status, r.body], [200, Buffer.from(png(20, 10))])
    assert.equal((await fetchRaw(server.url, { path: '/assets/../shared/other.png?platform=ios' })).status, 404)
  })
})

describe('rn-serve, with a Babel config', () => {
  const BABEL_APP = {
    'package.json': { name: 'app' },
    'babel.config.js': [
      "const { appendFileSync } = require('node:fs')",
      "const { basename, join } = require('node:path')",
      'module.exports = (api) => {',
      '  api.cache(true)',
      "  const logged = () => ({ pre(file) { appendFileSync(join(__dirname, 'transformed.log'), `${basename(file.opts.filename)}\\n`) } })",
      "  return { plugins: ['@babel/plugin-transform-react-jsx', logged] }",
      '}',
      '',
    ].join('\n'),
    'index.ts': "import { fail } from './lib/fail'\nimport { other } from './lib/other'\ntype T = { a: number }\nconst t: T = { a: 1 }\n;(globalThis as any).result = [t, other]\n;(globalThis as any).fail = fail\n",
    'lib/fail.ts': [
      '// A comment, and a type, which esbuild takes off before Babel.',
      'type Reason = string',
      '',
      "export function fail(reason: Reason = 'typed'): never {",
      '  throw new Error(reason)',
      '}',
      '',
    ].join('\n'),
    'lib/other.js': "export const other = 'other'\n",
    'node_modules/@babel/core': linked('@babel/core'),
    'node_modules/@babel/plugin-transform-react-jsx': linked('@babel/plugin-transform-react-jsx'),
  }
  const { root, cleanup } = writeTree(BABEL_APP)
  let server
  before(async () => {
    server = await serve(root)
  })
  after(async () => {
    await server?.stop()
    cleanup()
  })
  const log = () => readFileSync(join(root, 'transformed.log'), 'utf8').trim().split('\n').toSorted()

  it('maps each frame through esbuild and Babel to its source', async () => {
    const code = String((await fetchRaw(`${server.url}/index.bundle?platform=ios`)).body)
    assert.deepEqual(run(code).result, [{ a: 1 }, 'other'])
    const frame = { file: `${server.url}/index.bundle//&platform=ios`, ...positionOf(code, 'throw new Error(reason)') }
    const { stack } = JSON.parse(String((await fetchRaw(`${server.url}/symbolicate`, { method: 'POST', body: JSON.stringify({ stack: [frame] }) })).body))
    assert.deepEqual(stack[0], { file: join(root, 'lib/fail.ts'), lineNumber: 5, column: 2, collapse: false })
  })

  it('keeps each transform in memory: a change transforms the changed file alone', async () => {
    await fetchRaw(`${server.url}/index.bundle?platform=ios`)
    assert.deepEqual(log(), ['fail.ts', 'index.ts', 'other.js'])
    writeFileSync(join(root, 'lib/other.js'), "export const other = 'changed'\n")
    await until(() => log().length === 4, 'the change built')
    assert.deepEqual(log(), ['fail.ts', 'index.ts', 'other.js', 'other.js'])
    assert.deepEqual(run(String((await fetchRaw(`${server.url}/index.bundle?platform=ios`)).body)).result, [{ a: 1 }, 'changed'])
    assert.equal(log().length, 4)
    // Another target is another transform.
    await fetchRaw(`${server.url}/index.bundle?platform=android`)
    assert.equal(log().length, 7)
  })
})

// The bundle run as an app runs it, with metro-runtime's require. -> {
// context, inject(update) }: its global object, and an update injected as
// metro-runtime's HMRClient does.
const runApp = (code) => {
  const warnings = []
  const context = { console: { log: () => {}, warn: (...args) => warnings.push(args.join(' ')), error: () => {} }, setTimeout, clearTimeout, warnings }
  context.globalThis = context
  runInNewContext(code, context)
  return { context, inject: ({ added, modified }) => [...added, ...modified].forEach(({ module: [, text] }) => runInNewContext(text, context)) }
}

describe('rn-serve, with Fast Refresh', () => {
  const HOT_APP = {
    ...APP,
    'node_modules/metro-runtime': linked('metro-runtime'),
    'node_modules/react-refresh': linked('react-refresh'),
    'babel.config.js': 'module.exports = {}\n',
    'Greeting.js': "export function Greeting() {\n  return 'hi'\n}\n",
    'greeting.js': "import { Greeting } from './Greeting'\nglobalThis.result = Greeting()\n",
    'node_modules/@babel/core': linked('@babel/core'),
  }
  const { root, cleanup } = writeTree(HOT_APP)
  let server
  let babel
  before(async () => {
    ;[server, babel] = await Promise.all([serve(root), serve(root)])
  })
  after(async () => {
    await Promise.all([server?.stop(), babel?.stop()])
    cleanup()
  })
  const bundleUrl = (query = 'platform=ios') => `${server.url}/index.bundle?${query}`

  it("serves a dev bundle in Metro's module format, which runs as the other did", async () => {
    // No debugger is there to mount, and none is tried.
    assert.doesNotMatch(server.output(), /dev-middleware fails/u)
    const code = String((await fetchRaw(bundleUrl())).body)
    assert.match(code, /^__d\(function \(global, _\$\$_REQUIRE/mu)
    const { context } = runApp(code)
    assert.deepEqual(JSON.parse(JSON.stringify([context.result.where, context.result.dev, context.result.order, context.result.logo.name])), ['ios', true, ['polyfill', 'setup-env'], 'logo'])
    // A release bundle, as rn-bundle builds it.
    assert.doesNotMatch(String((await fetchRaw(bundleUrl('platform=ios&dev=false'))).body), /__d\(function/u)
  })

  it('symbolicates a frame of the bundle, and of a module as an update names it', async () => {
    const code = String((await fetchRaw(bundleUrl())).body)
    const frame = { file: `${server.url}/index.bundle//&platform=ios`, ...positionOf(code, 'throw new Error("boom")') }
    const moduleUrl = `${server.url}/lib/where.ios.js.bundle//&platform=ios&dev=true&minify=false&modulesOnly=true&runModule=false&shallow=true`
    const where = { file: moduleUrl, ...positionOf(String((await fetchRaw(moduleUrl)).body), 'var where') }
    const { stack, codeFrame } = JSON.parse(String((await fetchRaw(`${server.url}/symbolicate`, { method: 'POST', body: JSON.stringify({ stack: [frame, where] }) })).body))
    assert.deepEqual(stack.map(({ file, lineNumber }) => [file, lineNumber]), [[join(root, 'index.js'), 6], [join(root, 'lib/where.ios.js'), 1]])
    assert.equal(codeFrame.fileName, join(root, 'index.js'))
  })

  it('sends each app what changed, in place of a reload: the module, at its own URL, with its map', async () => {
    const { inject, context } = runApp(String((await fetchRaw(bundleUrl())).body))
    await fetchRaw(bundleUrl('platform=ios&dev=false'))
    const message = await socket(`${server.url}/message`)
    const hot = await socket(`${server.url}/hot?bundleEntry=index.bundle&platform=ios`)
    hot.ws.send(JSON.stringify({ type: 'register-entrypoints', entryPoints: [bundleUrl('platform=ios&dev=true&lazy=true')] }))
    await until(() => hot.messages.length === 3, 'bundle-registered')
    const where = join(root, 'lib/where.ios.js')
    try {
      writeFileSync(where, "export const where = 'ios, changed'\n")
      await until(() => hot.messages.length === 6, 'an update')
      const [start, { type, body }, done] = hot.messages.slice(3)
      assert.deepEqual([start, type, done], [{ type: 'update-start', body: { isInitialUpdate: false } }, 'update', { type: 'update-done', body: {} }])
      assert.deepEqual([body.isInitialUpdate, body.added, body.deleted, body.modified.length], [false, [], [], 1])
      const [{ sourceURL, sourceMappingURL }] = body.modified
      assert.equal(sourceURL, `${server.url}/lib/where.ios.js.bundle//&platform=ios&dev=true&lazy=true&minify=false&modulesOnly=true&runModule=false&shallow=true`)
      inject(body)
      // The entry is no boundary, and nothing set React Refresh up: metro-runtime can't refresh.
      assert.deepEqual(context.warnings, ['Could not reload the application after an edit.'])
      const moduleCode = String((await fetchRaw(sourceURL)).body)
      assert.match(moduleCode, /^__d\(function .*"ios, changed"/su)
      const map = JSON.parse(String((await fetchRaw(sourceMappingURL)).body))
      assert.deepEqual(map.sources, [join(realpathSync(root), 'lib/where.ios.js')])
      // The release bundle's app reloads, as before.
      await until(() => message.messages.length > 0, "the release bundle's reload")
      assert.equal(context.result.where, 'ios')
      // A build error, then what changed from the build the app has.
      writeFileSync(where, "export const where = 'ios\n")
      await until(() => hot.messages.some(({ type: kind }) => kind === 'error'), 'a build error')
      writeFileSync(where, "export const where = 'ios, fixed'\n")
      await until(() => hot.messages.filter(({ type: kind }) => kind === 'update').length === 2, 'an update once fixed')
      assert.match(hot.messages.findLast(({ type: kind }) => kind === 'update').body.modified[0].module[1], /"ios, fixed"/u)
      // Fixed as it was: an update of nothing, which takes the error off the app.
      writeFileSync(where, "export const where = 'ios\n")
      await until(() => hot.messages.filter(({ type: kind }) => kind === 'error').length === 2, 'a second build error')
      writeFileSync(where, "export const where = 'ios, fixed'\n")
      await until(() => hot.messages.filter(({ type: kind }) => kind === 'update').length === 3, 'an update of nothing once fixed as it was')
      const { added, modified, deleted } = hot.messages.findLast(({ type: kind }) => kind === 'update').body
      assert.deepEqual([added, modified, deleted, hot.messages.at(-1)], [[], [], [], { type: 'update-done', body: {} }])
    } finally {
      writeFileSync(where, APP['lib/where.ios.js'])
      message.ws.close()
      hot.ws.close()
    }
  })

  it('reloads the apps where a polyfill changes, which no update defines anew', async () => {
    const alone = await serve(root)
    const polyfill = join(root, 'node_modules/@react-native/metro-config/node_modules/@react-native/js-polyfills/polyfill.js')
    try {
      await fetchRaw(`${alone.url}/index.bundle?platform=ios`)
      const message = await socket(`${alone.url}/message`)
      const hot = await socket(`${alone.url}/hot?bundleEntry=index.bundle&platform=ios`)
      hot.ws.send(JSON.stringify({ type: 'register-entrypoints', entryPoints: [`${alone.url}/index.bundle?platform=ios`] }))
      await until(() => hot.messages.length === 3, 'bundle-registered')
      writeFileSync(polyfill, `${APP['node_modules/@react-native/metro-config/node_modules/@react-native/js-polyfills/polyfill.js']};(global.order ??= []).push('again')\n`)
      await until(() => message.messages.length > 0, 'a reload')
      assert.deepEqual([message.messages, hot.messages.length], [[{ version: 2, method: 'reload' }], 3])
      message.ws.close()
      hot.ws.close()
    } finally {
      writeFileSync(polyfill, APP['node_modules/@react-native/metro-config/node_modules/@react-native/js-polyfills/polyfill.js'])
      await alone.stop()
    }
  })

  it('with a Babel config, has each component of the project register for Fast Refresh, as react-refresh\'s plugin does', async () => {
    const code = String((await fetchRaw(`${babel.url}/greeting.bundle?platform=ios`)).body)
    const greeting = code.split('\n__d(').find((text) => text.includes('"Greeting.js"'))
    assert.match(greeting, /\$RefreshReg\$\(_c, "Greeting"\)/u)
    assert.equal(runApp(code).context.result, 'hi')
  })
})

describe("rn-serve, of rn.config.json's assetExts and sourceExts", () => {
  const { root, cleanup } = writeTree({
    ...APP,
    'rn.config.json': { assetExts: ['riv'], sourceExts: ['mjs'] },
    'lists.js': "import { getAssetByID } from 'react-native/asset-registry'\nglobalThis.result = { later: require('./later').later, spin: getAssetByID(require('./anim/spin.riv')).type }\n",
    'later.mjs': "export const later = 'mjs'\n",
    'anim/spin.riv': 'RIVE',
  })
  let server
  before(async () => {
    server = await serve(root)
  })
  after(async () => {
    await server?.stop()
    cleanup()
  })

  it('builds each bundle of them, as rn-bundle does, and serves the assets', async () => {
    assert.deepEqual(run(String((await fetchRaw(`${server.url}/lists.bundle?platform=ios`)).body)).result, { later: 'mjs', spin: 'riv' })
    const asset = await fetchRaw(`${server.url}/assets/anim/spin.riv?platform=ios&hash=x`)
    assert.deepEqual([asset.status, String(asset.body)], [200, 'RIVE'])
  })
})

describe('rn-serve --esm', () => {
  const { root, cleanup } = writeTree({
    ...APP,
    'node_modules/metro-runtime': linked('metro-runtime'),
    'babel.config.js': "module.exports = { plugins: ['@babel/plugin-transform-modules-commonjs'] }\n",
    'esm.js': "import make, { named } from './lib/cjs'\nimport { used } from './lib/named'\nconst esm = require('./lib/esm')\nglobalThis.result = { made: make(), named, used, esm: [esm.default, esm.value] }\n",
    'lib/cjs.js': "module.exports = () => 'made'\nmodule.exports.named = 'named'\n",
    'lib/named.js': "export const used = 'used'\nexport const unused = 'UNUSED-EXPORT'\n",
    'lib/esm.js': "export default 'default'\nexport const value = 'value'\n",
    'node_modules/@babel/core': linked('@babel/core'),
    'node_modules/@babel/plugin-transform-modules-commonjs': linked('@babel/plugin-transform-modules-commonjs'),
  })
  let server
  before(async () => {
    server = await serve(root, ['--esm'])
  })
  after(async () => {
    await server?.stop()
    cleanup()
  })
  const OUT = { made: 'made', named: 'named', used: 'used', esm: ['default', 'value'] }

  it('leaves import and export to esbuild: which makes each module of a dev bundle CommonJS, and links those of one of no dev, dropping what is unused', async () => {
    const dev = String((await fetchRaw(`${server.url}/esm.bundle?platform=ios`)).body)
    const named = dev.split('\n__d(').find((text) => text.includes('"lib/named.js"'))
    // esbuild's exports, not Babel's CommonJS plugin's.
    assert.ok(named.includes('__export(') && !named.includes('exports.used ='), named)
    assert.deepEqual(JSON.parse(JSON.stringify(runApp(dev).context.result)), OUT)
    const release = String((await fetchRaw(`${server.url}/esm.bundle?platform=ios&dev=false`)).body)
    assert.ok(!release.includes('UNUSED-EXPORT'))
    assert.deepEqual(run(release).result, OUT)
  })

  it('takes --esm only where Babel runs', () => {
    const plain = writeTree({ 'package.json': { name: 'plain' } })
    try {
      const r = spawnSync(process.execPath, [BIN, '--esm'], { cwd: plain.root, encoding: 'utf8' })
      assert.deepEqual([r.status, r.stderr], [1, "rn-serve: --esm keeps ES modules through the project's Babel config, and it has none\n"])
    } finally {
      plain.cleanup()
    }
  })
})

describe('rn-serve, its cache of each file as it loads', () => {
  const config = (comment) => [
    `// ${comment}`,
    "const { appendFileSync } = require('node:fs')",
    "const { basename, join } = require('node:path')",
    'module.exports = (api) => {',
    '  api.cache(true)',
    "  const logged = () => ({ pre(file) { appendFileSync(join(__dirname, 'transformed.log'), `${basename(file.opts.filename)}\\n`) } })",
    "  return { plugins: ['@babel/plugin-transform-modules-commonjs', logged] }",
    '}',
    '',
  ].join('\n')
  const { root, cleanup } = writeTree({
    'package.json': { name: 'app' },
    'babel.config.js': config('A config.'),
    'index.js': "import { other } from './lib/other'\nglobalThis.result = other\n",
    'lib/other.js': "export const other = 'other'\n",
    'node_modules/@babel/core': linked('@babel/core'),
    'node_modules/@babel/plugin-transform-modules-commonjs': linked('@babel/plugin-transform-modules-commonjs'),
  })
  const tmp = mkdtempSync(join(tmpdir(), 'rn-serve-tmp-'))
  after(() => {
    cleanup()
    rmSync(tmp, { recursive: true, force: true })
  })
  const transformed = () => (existsSync(join(root, 'transformed.log')) ? readFileSync(join(root, 'transformed.log'), 'utf8').trim().split('\n').length : 0)
  // A run of rn-serve, of a bundle: -> its result, how many files Babel
  // transformed, and the cache's status it logs on its build's line.
  const served = async (args = []) => {
    const count = transformed()
    const server = await serve(root, args, tmp)
    try {
      const code = String((await fetchRaw(`${server.url}/index.bundle?platform=ios`)).body)
      const logged = await until(() => /rn-serve: built \S+ for ios, dev in \d+\.\d s, cache \d+\.\d s: ([^\n]*)\n/u.exec(server.output()), 'the build logged')
      return [run(code).result, transformed() - count, logged[1]]
    } finally {
      await server.stop()
    }
  }

  it('keeps each file as it loads in the OS\'s temporary directory, across runs, while the Babel config and the plugins left out of it are the same, and logs on its line its time, hits and misses', async () => {
    assert.deepEqual(await served(), ['other', 2, '0 hits, 2 misses'])
    assert.deepEqual(readdirSync(tmp).filter((name) => name.startsWith('rn-serve-cache')), [`rn-serve-cache-${process.getuid()}`])
    assert.deepEqual(await served(), ['other', 0, '2 hits, 0 misses'])
    // Without the config's CommonJS plugin, which esbuild does for it.
    assert.deepEqual(await served(['--esm']), ['other', 2, '0 hits, 2 misses'])
    assert.deepEqual(await served(['--esm']), ['other', 0, '2 hits, 0 misses'])
    assert.deepEqual(await served(), ['other', 0, '2 hits, 0 misses'])
    writeFileSync(join(root, 'babel.config.js'), config('A config, changed.'))
    assert.deepEqual(await served(), ['other', 2, '0 hits, 2 misses'])
    assert.deepEqual(await served(['--reset-cache']), ['other', 2, '0 hits, 2 misses'])
    assert.deepEqual(await served(), ['other', 0, '2 hits, 0 misses'])
  })

  it('removes, once it has built, the packs no run has used for a week, and the entries of the layout before', async () => {
    const cache = join(tmp, `rn-serve-cache-${process.getuid()}`)
    const stale = join(cache, 'packs', 'stale')
    mkdirSync(stale, { recursive: true })
    writeFileSync(join(stale, 'a.pack'), '')
    const week = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    utimesSync(stale, week, week)
    mkdirSync(join(cache, 'ab'))
    writeFileSync(join(cache, 'ab', 'cd'), '{}')
    const kept = readdirSync(join(cache, 'packs')).filter((name) => name !== 'stale').toSorted()
    assert.deepEqual(await served(), ['other', 0, '2 hits, 0 misses'])
    assert.deepEqual([existsSync(stale), existsSync(join(cache, 'ab')), readdirSync(join(cache, 'packs')).toSorted(), readdirSync(join(cache, 'entries')).length], [false, false, kept, 1])
  })

  it('builds, as it starts, the bundles an app asked for of its last run, ahead of the app, which then has its bundle at once', async () => {
    const server = await serve(root, [], tmp, { warm: true })
    try {
      await until(() => /rn-serve: built \.\/index for ios, dev in \d+\.\d s, cache [^\n]*: 2 hits, 0 misses\n/u.test(server.output()), 'the bundle built ahead of the app')
      assert.match(server.output(), /rn-serve: building \.\/index for ios, dev ahead of the app, as its last run did\n/u)
      assert.equal(run(String((await fetchRaw(`${server.url}/index.bundle?platform=ios`)).body)).result, 'other')
      assert.equal(server.output().match(/rn-serve: built /gu).length, 1)
    } finally {
      await server.stop()
    }
  })

  it("builds, as it starts, of no run before, the project's one bundle, for iOS on a Mac, else for Android", async () => {
    const fresh = mkdtempSync(join(tmpdir(), 'rn-serve-tmp-'))
    const platform = process.platform === 'darwin' ? 'ios' : 'android'
    const server = await serve(root, [], fresh, { warm: true })
    try {
      await until(() => new RegExp(`rn-serve: built \\./index for ${platform}, dev in \\d+\\.\\d s`, 'u').test(server.output()), 'the bundle built ahead of the app')
      assert.match(server.output(), new RegExp(`rn-serve: building \\./index for ${platform}, dev ahead of the app, the project's one bundle\n`, 'u'))
    } finally {
      await server.stop()
      rmSync(fresh, { recursive: true, force: true })
    }
  })

  it('keeps none in a directory another may write in', async () => {
    const shared = mkdtempSync(join(tmpdir(), 'rn-serve-tmp-'))
    try {
      mkdirSync(join(shared, `rn-serve-cache-${process.getuid()}`), { mode: 0o777 })
      chmodSync(join(shared, `rn-serve-cache-${process.getuid()}`), 0o777)
      const server = await serve(root, [], shared)
      await server.stop()
      assert.match(server.output(), /rn-serve: keeping no files across runs: \S+ is not this user's alone/u)
    } finally {
      rmSync(shared, { recursive: true, force: true })
    }
  })

  it('is of rn-serve alone: rn-bundle keeps none', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'rn-serve-tmp-'))
    try {
      const bundled = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/rn-bundle.js', import.meta.url)), '--platform=ios', `--output=${join(fresh, 'out.js')}`, 'index.js'], { cwd: root, env: envOf(fresh), encoding: 'utf8' })
      assert.equal(bundled.status, 0, bundled.stderr)
      assert.deepEqual(readdirSync(fresh).filter((name) => name.startsWith('rn-serve-cache')), [])
    } finally {
      rmSync(fresh, { recursive: true, force: true })
    }
  })
})

describe('rn-serve, with @react-native/dev-middleware', () => {
  // As react-native has it: its middleware answers what rn-serve's routes don't.
  const { root, cleanup } = writeTree({
    ...APP,
    'node_modules/@react-native/dev-middleware/package.json': { name: '@react-native/dev-middleware', main: 'index.js' },
    'node_modules/@react-native/dev-middleware/index.js': "exports.createDevMiddleware = () => ({ middleware: (request, response, next) => (request.url === '/json/list' ? response.end('[]') : next()), websocketEndpoints: {} })\n",
  })
  after(cleanup)

  it('mounts the debugger, though no metro-runtime is there for Fast Refresh', async () => {
    const server = await serve(root)
    try {
      assert.equal(String((await fetchRaw(`${server.url}/json/list`)).body), '[]')
      assert.match(server.output(), /no metro-runtime/u)
    } finally {
      await server.stop()
    }
  })
})

describe("rn-serve, with @react-native/dev-middleware and rn.config.json's devTools", () => {
  // A dev-middleware of its inspector's sockets, `ws`'s as rn-serve has them,
  // and of each /open-debugger asked (GET /test/opened).
  const DEV_MIDDLEWARE = [
    "const { EventEmitter } = require('node:events')",
    `const { acceptWebSocket } = require(${JSON.stringify(fileURLToPath(new URL('../src/websocket.js', import.meta.url)))})`,
    'const endpoint = () => {',
    '  const server = new EventEmitter()',
    '  server.handleUpgrade = (request, socket, head, done) => {',
    '    const ws = new EventEmitter()',
    "    if (acceptWebSocket(request, socket, head, { onMessage: (text) => ws.emit('message', Buffer.from(text)), onClose: () => ws.emit('close') }) !== null) done(ws)",
    '  }',
    '  return server',
    '}',
    'const opened = []',
    'exports.createDevMiddleware = () => ({',
    '  middleware: (request, response, next) => {',
    "    if (request.method === 'POST' && request.url.startsWith('/open-debugger')) opened.push(request.url)",
    "    else if (request.url === '/test/opened') return response.end(JSON.stringify(opened))",
    '    else return next()',
    '    response.end()',
    '  },',
    "  websocketEndpoints: { '/inspector/device': endpoint(), '/inspector/debug': endpoint() },",
    '})',
    '',
  ].join('\n')
  const { root, cleanup } = writeTree({
    ...APP,
    'rn.config.json': { devTools: true },
    'node_modules/@react-native/dev-middleware/package.json': { name: '@react-native/dev-middleware', main: 'index.js' },
    'node_modules/@react-native/dev-middleware/index.js': DEV_MIDDLEWARE,
  })
  after(cleanup)
  const PAGES = JSON.stringify({ event: 'getPages', payload: [{ id: '1', title: 'App (iPhone)', app: 'com.app', capabilities: { nativePageReloads: true } }] })
  const connect = async (server, path) => {
    const ws = new WebSocket(`${server.url.replace(/^http/u, 'ws')}${path}`)
    await once(ws, 'open')
    return ws
  }
  // An app's runtime connecting, and listing its page.
  const launch = async (server) => {
    const device = await connect(server, '/inspector/device?device=phone&name=iPhone&app=com.app')
    device.send(PAGES)
    return device
  }
  const opened = async (server) => JSON.parse(String((await fetchRaw(`${server.url}/test/opened`)).body))

  it('opens DevTools of each app as it connects, unless DevTools are connected to its device', async () => {
    const server = await serve(root)
    try {
      const device = await launch(server)
      assert.deepEqual(await until(async () => (await opened(server)).length > 0 && opened(server), 'DevTools opened'), ['/open-debugger?device=phone'])
      // DevTools connected, the app relaunched: none opened again.
      const debug = await connect(server, '/inspector/debug?device=phone&page=1')
      device.close()
      const again = await launch(server)
      await sleep(300)
      assert.deepEqual(await opened(server), ['/open-debugger?device=phone'])
      // Closed, the app relaunched: opened again.
      debug.close()
      again.close()
      await sleep(100)
      ;(await launch(server)).close()
      assert.equal((await until(async () => (await opened(server)).length > 1 && opened(server), 'DevTools opened again')).length, 2)
    } finally {
      await server.stop()
    }
  })

  it('opens none with --no-dev-tools', async () => {
    const server = await serve(root, ['--no-dev-tools'])
    try {
      ;(await launch(server)).close()
      await sleep(300)
      assert.deepEqual(await opened(server), [])
    } finally {
      await server.stop()
    }
  })
})

describe('rn-serve, with @react-native/dev-middleware: its logger', () => {
  // As dev-middleware calls it: a format string and its arguments.
  const { root, cleanup } = writeTree({
    ...APP,
    'node_modules/@react-native/dev-middleware/package.json': { name: '@react-native/dev-middleware', main: 'index.js' },
    'node_modules/@react-native/dev-middleware/index.js': "exports.createDevMiddleware = (options) => {\n  options.logger.warn('a %s b %s', 'x', 'y')\n  return { middleware: (request, response, next) => next(), websocketEndpoints: {} }\n}\n",
  })
  after(cleanup)

  it('prints what it logs formatted, as console does', async () => {
    const server = await serve(root)
    try {
      // Logged after the debugger's mounted, as rn-serve starts.
      await until(() => server.output().includes('no metro-runtime'), 'rn-serve to start')
      assert.match(server.output(), /^a x b y$/mu)
    } finally {
      await server.stop()
    }
  })
})

describe('rn-serve --launch=ios, of rn.config.json\'s launch and ios', () => {
  // Xcode's commands, on PATH alone: each logs
  // its arguments, and answers as Xcode's would.
  const LIST = { devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [{ udid: 'UDID-17', name: 'iPhone 17', state: 'Shutdown', isAvailable: true }] } }
  const fake = (name, body = '') => `#!${process.execPath}\nrequire('node:fs').appendFileSync(process.env.FAKE_LOG, JSON.stringify([${JSON.stringify(name)}, ...process.argv.slice(2)]) + '\\n')\nconst args = process.argv.slice(2)\n${body}\n`
  const FAKES = {
    'xcode/bin/xcrun': fake('xcrun', `if (args.join(' ') === '--find simctl') console.log('/xcode/simctl')\nelse if (args.join(' ') === 'simctl list devices available --json') console.log(${JSON.stringify(JSON.stringify(LIST))})`),
    'xcode/bin/xcode-select': fake('xcode-select', 'console.log(process.env.FAKE_DEVELOPER)'),
    'xcode/bin/open': fake('open'),
    'xcode/bin/plutil': fake('plutil', "console.log(JSON.stringify(args[1] === 'CFBundleIdentifier' ? 'com.example.app' : ['iPhoneSimulator']))"),
    'xcode/Developer/Applications/Simulator.app/Contents/Info.plist': '',
    // Xcode 27's: DeviceHub.app in the Xcode app's Applications, and no Simulator.app.
    'xcode27/Contents/Developer/usr/bin/.keep': '',
    'xcode27/Contents/Applications/DeviceHub.app/Contents/Info.plist': '',
  }
  const { root, cleanup } = writeTree({
    ...APP,
    ...FAKES,
    'rn.config.json': { launch: 'ios', ios: { simulator: 'iPhone 17', binaryPath: 'build/App.app' } },
    'build/App.app/Info.plist': '',
  })
  for (const name of ['xcrun', 'xcode-select', 'open', 'plutil']) chmodSync(join(root, 'xcode/bin', name), 0o755)
  const log = join(root, 'commands.log')
  const env = { PATH: join(root, 'xcode/bin'), FAKE_LOG: log, FAKE_DEVELOPER: join(root, 'xcode/Developer') }
  // PATH of none of Xcode's commands.
  const bare = { ...env, PATH: join(root, 'build') }
  const commands = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [])
  const refused = (args, given = env) => {
    const r = spawnSync(process.execPath, [BIN, '--port=0', '--no-warm', ...args], { cwd: root, encoding: 'utf8', env: { ...envOf(TMP), ...given } })
    return [r.status, r.stderr]
  }
  after(cleanup)

  it("launches the app of its ios as it starts, and builds iOS's bundle ahead of it", async () => {
    rmSync(log, { force: true })
    const server = await serve(root, [], TMP, { warm: true, env })
    try {
      await until(() => server.output().includes('rn-serve: launched com.example.app on iPhone 17'), 'the app launched')
      const app = join(root, 'build/App.app')
      assert.deepEqual(commands(), [
        ['xcrun', '--find', 'simctl'],
        ['plutil', '-extract', 'CFBundleIdentifier', 'json', '-o', '-', join(app, 'Info.plist')],
        ['plutil', '-extract', 'CFBundleSupportedPlatforms', 'json', '-o', '-', join(app, 'Info.plist')],
        ['xcrun', 'simctl', 'list', 'devices', 'available', '--json'],
        ['xcode-select', '-p'],
        ['open', join(root, 'xcode/Developer/Applications/Simulator.app'), '--args', '-CurrentDeviceUDID', 'UDID-17'],
        ['xcrun', 'simctl', 'bootstatus', 'UDID-17', '-b'],
        ['xcrun', 'simctl', 'install', 'UDID-17', app],
        ['xcrun', 'simctl', 'launch', '--terminate-running-process', 'UDID-17', 'com.example.app', '-RCT_jsLocation', new URL(server.url).host],
      ])
      // Of no run before, iOS's, of any system.
      assert.match(server.output(), /rn-serve: building \.\/index for ios, dev ahead of the app, the project's one bundle/u)
    } finally {
      await server.stop()
    }
  })

  it("opens Xcode 27's DeviceHub on the simulator, where Xcode has no Simulator.app", async () => {
    rmSync(log, { force: true })
    const server = await serve(root, [], TMP, { env: { ...env, FAKE_DEVELOPER: join(root, 'xcode27/Contents/Developer') } })
    try {
      await until(() => server.output().includes('rn-serve: launched com.example.app'), 'the app launched')
      assert.deepEqual(commands().filter(([name]) => name === 'open'), [['open', 'devices://device/open?id=UDID-17']])
    } finally {
      await server.stop()
    }
  })

  it('launches none of --no-launch', async () => {
    rmSync(log, { force: true })
    const server = await serve(root, ['--no-launch'], TMP, { env })
    try {
      await sleep(200)
      assert.deepEqual([commands(), server.output().includes('launch')], [[], false])
    } finally {
      await server.stop()
    }
  })

  it("leaves its launch, saying so, where Xcode's simctl isn't; refuses --launch=ios there", async () => {
    const server = await serve(root, [], TMP, { env: bare })
    try {
      assert.match(server.output(), /rn-serve: no Xcode's simctl \(xcrun --find simctl\): rn\.config\.json's launch launches nothing here/u)
    } finally {
      await server.stop()
    }
    assert.deepEqual(refused(['--launch=ios'], bare), [1, "rn-serve: --launch=ios needs Xcode's simctl (xcrun --find simctl)\n"])
  })

  it('refuses a launch of another platform, of no app, and --simulator or --binary-path with none', () => {
    assert.deepEqual(refused(['--launch=android']), [1, 'rn-serve: --launch takes ios, not android\n'])
    assert.deepEqual(refused(['--binary-path=build/None.app']), [1, 'rn-serve: --binary-path: no app at build/None.app, an .app of its Info.plist\n'])
    assert.deepEqual(refused(['--no-launch', '--simulator=iPhone 17']), [1, 'rn-serve: --simulator and --binary-path are of --launch=ios\n'])
  })
})

describe('rn-serve, with @react-native/dev-middleware and Fast Refresh: the Network panel', () => {
  const REACT_NATIVE = APP['node_modules/react-native/package.json']
  // A dev-middleware of its options and rn-serve's handler alone, which the
  // test drives as a DevTools and its app's runtime would: GET
  // /test/<route>?m=<message>.
  const DEV_MIDDLEWARE = [
    'const sent = []',
    'const toDevice = []',
    'let options = null',
    'let handler = null',
    'exports.createDevMiddleware = (given) => {',
    '  options = given',
    '  const routes = {',
    "    '/test/options': () => ({ experiments: options.unstable_experiments, handler: typeof options.unstable_customInspectorMessageHandler }),",
    "    '/test/connect': () => {",
    "      handler = options.unstable_customInspectorMessageHandler({ page: { id: '1' }, device: { appId: 'com.app', id: 'phone', name: 'Phone', sendMessage: (message) => toDevice.push(message) }, debugger: { userAgent: null, sendMessage: (message) => sent.push(message) } })",
    '      return null',
    '    },',
    "    '/test/debugger': (message) => handler.handleDebuggerMessage(message) === true,",
    "    '/test/device': (message) => handler.handleDeviceMessage(message) === true,",
    "    '/test/sent': () => sent,",
    "    '/test/toDevice': () => toDevice,",
    '  }',
    '  const middleware = (request, response, next) => {',
    "    const url = new URL(request.url, 'http://localhost')",
    '    if (!Object.hasOwn(routes, url.pathname)) return next()',
    "    response.end(JSON.stringify(routes[url.pathname](JSON.parse(url.searchParams.get('m') ?? 'null'))))",
    '  }',
    '  return { middleware, websocketEndpoints: {} }',
    '}',
    '',
  ].join('\n')
  const { root, cleanup } = writeTree({
    ...APP,
    'node_modules/metro-runtime': linked('metro-runtime'),
    'node_modules/@react-native/dev-middleware/package.json': { name: '@react-native/dev-middleware', main: 'index.js' },
    'node_modules/@react-native/dev-middleware/index.js': DEV_MIDDLEWARE,
    // As react-native 0.88 has them: its Libraries/ exported.
    'node_modules/react-native/package.json': { ...REACT_NATIVE, exports: { ...REACT_NATIVE.exports, './Libraries/*': './Libraries/*.js' } },
    'node_modules/react-native/Libraries/Core/Devtools/getDevServer.js': "module.exports = () => {\n  ;(globalThis.order ??= []).push('reporter')\n  return globalThis.devServer\n}\n",
    'node_modules/react-native/Libraries/Core/Devtools/parseErrorStack.js': 'module.exports = () => []\n',
  })
  let server
  before(async () => {
    server = await serve(root)
  })
  after(async () => {
    await server?.stop()
    cleanup()
  })
  const bundleUrl = (query = 'platform=ios') => `${server.url}/index.bundle?${query}`
  const ask = async (route, message = null) => JSON.parse(String((await fetchRaw(`${server.url}/test/${route}?m=${encodeURIComponent(JSON.stringify(message))}`)).body))

  it("has dev-middleware show the Network panel, each DevTools' messages through rn-serve's handler", async () => {
    assert.deepEqual(await ask('options'), { experiments: { enableNetworkInspector: true }, handler: 'function' })
  })

  it("runs its reporter in each dev bundle, after setup-env, before the entry, its imports react-native's, as the entry's", async () => {
    const code = String((await fetchRaw(bundleUrl())).body)
    assert.match(code, /app\/network\.js"\);/u)
    const sockets = []
    class WebSocket {
      constructor(url) {
        sockets.push(url)
      }
      addEventListener() {}
    }
    class XMLHttpRequest {}
    const { result } = run(code, { setTimeout, WebSocket, XMLHttpRequest, devServer: { url: `${server.url}/`, bundleLoadedFromServer: true } })
    assert.deepEqual([result.order, sockets], [['polyfill', 'setup-env', 'reporter'], [`${server.url.replace('http', 'ws')}/network`]])
    assert.ok(Object.hasOwn(XMLHttpRequest.prototype, 'send'))
    // Not in a bundle of no dev.
    assert.doesNotMatch(String((await fetchRaw(bundleUrl('platform=ios&dev=false'))).body), /app\/network\.js/u)
  })

  it('shows the panel each request its app reports, where its runtime fails Network.enable', async () => {
    await ask('connect')
    assert.equal(await ask('device', { method: 'Debugger.scriptParsed', params: { scriptId: '3', url: bundleUrl() } }), false)
    assert.equal(await ask('debugger', { id: 1, method: 'Network.enable', params: {} }), false)
    assert.equal(await ask('device', { id: 1, error: { code: -32_601, message: "Unsupported method 'Network.enable'" } }), true)
    const { ws, messages } = await socket(`${server.url}/network`)
    try {
      ws.send(JSON.stringify({ type: 'hello', reporter: 'r1' }))
      // The runtime asked which reporter it has, as rn-serve serves it and as the reporter says hello.
      const asked = await until(async () => {
        const all = await ask('toDevice')
        return all.length === 2 && all
      }, 'the runtime asked')
      assert.deepEqual(asked.map(({ method, params }) => [method, params.expression]), [['Runtime.evaluate', 'globalThis.__rnServeReporter'], ['Runtime.evaluate', 'globalThis.__rnServeReporter']])
      for (const { id } of asked) assert.equal(await ask('device', { id, result: { result: { type: 'string', value: 'r1' } } }), true)
      await until(() => messages.length > 0, 'the reporter told')
      assert.deepEqual(messages, [{ type: 'enable' }])
      for (const message of [
        { type: 'request', id: 1, url: 'https://api.example/user', method: 'GET', headers: {}, time: 1, wallTime: 1_700_000_000, stack: [{ methodName: 'loadUser', file: bundleUrl(), lineNumber: 3, column: 1 }] },
        { type: 'response', id: 1, url: 'https://api.example/user', status: 200, headers: {}, mimeType: 'application/json', time: 1.1 },
        { type: 'body', id: 1, at: 0, data: '{"id":42}', base64: false, more: false },
        { type: 'finished', id: 1, time: 1.2, size: 9 },
      ]) ws.send(JSON.stringify(message))
      const sent = await until(async () => {
        const all = await ask('sent')
        return all.some(({ method }) => method === 'Network.loadingFinished') && all
      }, 'the panel sent the request')
      assert.deepEqual(sent.map(({ id, method }) => method ?? id), [1, 'Network.requestWillBeSent', 'Network.responseReceived', 'Network.loadingFinished'])
      assert.equal(sent[1].params.initiator.stack.callFrames[0].scriptId, '3')
      assert.equal(await ask('debugger', { id: 2, method: 'Network.getResponseBody', params: { requestId: sent[1].params.requestId } }), true)
      assert.deepEqual((await ask('sent')).at(-1), { id: 2, result: { body: '{"id":42}', base64Encoded: false } })
    } finally {
      ws.close()
    }
  })
})

describe('rn-serve, with a Metro config of a minifier and transform options of its own', () => {
  const { root, cleanup } = writeTree({
    ...APP,
    'metro.config.js': "module.exports = { transformer: { minifierConfig: { mangle: false }, getTransformOptions: async (entries, { platform }) => ({ transform: { experimentalImportSupport: platform === 'android' } }) } }\n",
    'node_modules/metro-config': linked('metro-config'),
  })
  after(cleanup)

  it("serves a bundle, but no minified one, which esbuild would minify as the config doesn't have it", async () => {
    const server = await serve(root)
    try {
      assert.equal((await fetchRaw(`${server.url}/index.bundle?platform=ios`)).status, 200)
      const minified = await fetchRaw(`${server.url}/index.bundle?platform=ios&minify=true`)
      assert.equal(minified.status, 500)
      assert.match(JSON.parse(String(minified.body)).message, /transformer\.minifierConfig is \{"mangle":false\}: rn-serve does it as Metro's default alone/u)
    } finally {
      await server.stop()
    }
  })

  it('asks getTransformOptions of each bundle, as Metro does, failing one whose transform options it does not do', async () => {
    const server = await serve(root)
    try {
      const android = await fetchRaw(`${server.url}/index.bundle?platform=android`)
      assert.equal(android.status, 500)
      assert.match(JSON.parse(String(android.body)).message, /transformer\.getTransformOptions gives experimentalImportSupport true, Metro's own transform of import and export: rn-serve does it as Metro's default alone/u)
    } finally {
      await server.stop()
    }
  })
})

describe('rn-serve flags', () => {
  const { root, cleanup } = writeTree({ 'package.json': { name: 'app' }, 'aliases.json': {}, 'babel.config.js': 'module.exports = {}\n', 'node_modules/@babel/core': linked('@babel/core') })
  after(cleanup)
  const fails = (args) => spawnSync(process.execPath, [BIN, ...args], { cwd: root, encoding: 'utf8' })

  it('fails on what it cannot take', () => {
    assert.deepEqual([fails(['--port=x']).status, fails(['--port=x']).stderr], [1, 'rn-serve: --port takes a port, not x\n'])
    assert.deepEqual([fails(['--max-workers=x']).status, fails(['--max-workers=x']).stderr], [1, 'rn-serve: --max-workers takes a number of workers, not x\n'])
    assert.match(fails(['--babel-aliases=aliases.json']).stderr, /--babel-aliases maps the imports where no Babel runs/u)
    assert.match(fails(['--define=x']).stderr, /--define takes K=V, not x/u)
    // Babel runs where the project has a config, as Metro's transformer runs it.
    assert.match(fails(['--babel']).stderr, /Unknown option '--babel'/u)
  })
})
