import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { request } from 'node:http'
import { readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

import { png, writeTree } from './fixtures.js'

const BIN = fileURLToPath(new URL('../bin/rn-serve.js', import.meta.url))
const linked = (name) => ({ link: realpathSync(fileURLToPath(new URL(`../node_modules/${name}`, import.meta.url))) })
const under = (dir, tree) => Object.fromEntries(Object.entries(tree).map(([path, content]) => [`${dir}/${path}`, content]))

const until = async (get, what, ms = 15_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) {
    const value = get()
    if (value) return value
  }
  throw new Error(`timed out waiting for ${what}`)
}

// rn-serve on a free port, in `cwd`. -> { url, output(), stop() }
async function serve(cwd, args = []) {
  const child = spawn(process.execPath, [BIN, '--port=0', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
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
const run = (code) => {
  const context = { console: { log: () => {} } }
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
    assert.match(server.output(), /built \.\/index for ios, dev in \d+ ms/u)
  })

  it('serves its source map', async () => {
    const r = await fetchRaw(`${server.url}/index.map?platform=ios`)
    assert.equal(r.status, 200)
    assert.equal(r.headers['access-control-allow-origin'], 'devtools://devtools')
    assert.ok(JSON.parse(String(r.body)).sources.includes('index.js'))
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
    for (const path of ['/assets/secret.yml', '/assets/package.json', '/assets/../package.json', '/assets/img/../../outside.js', '/package.json', '/index.js', '/assets/%2e%2e/outside.js']) {
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

describe('rn-serve --babel', () => {
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
    server = await serve(root, ['--babel'])
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
    ;[server, babel] = await Promise.all([serve(root), serve(root, ['--babel'])])
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
    const moduleUrl = `${server.url}/lib/where.ios.bundle//&platform=ios&dev=true&minify=false&modulesOnly=true&runModule=false&shallow=true`
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
      assert.equal(sourceURL, `${server.url}/lib/where.ios.bundle//&platform=ios&dev=true&lazy=true&minify=false&modulesOnly=true&runModule=false&shallow=true`)
      inject(body)
      // The entry is no boundary, and nothing set React Refresh up: metro-runtime can't refresh.
      assert.deepEqual(context.warnings, ['Could not reload the application after an edit.'])
      const moduleCode = String((await fetchRaw(sourceURL)).body)
      assert.match(moduleCode, /^__d\(function .*"ios, changed"/su)
      const map = JSON.parse(String((await fetchRaw(sourceMappingURL)).body))
      assert.deepEqual(map.sources, ['lib/where.ios.js'])
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

  it('with --babel, has each component of the project register for Fast Refresh, as react-refresh\'s plugin does', async () => {
    const code = String((await fetchRaw(`${babel.url}/greeting.bundle?platform=ios`)).body)
    const greeting = code.split('\n__d(').find((text) => text.includes('"Greeting.js"'))
    assert.match(greeting, /\$RefreshReg\$\(_c, "Greeting"\)/u)
    assert.equal(runApp(code).context.result, 'hi')
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

describe('rn-serve flags', () => {
  const { root, cleanup } = writeTree({ 'package.json': { name: 'app' }, 'aliases.json': {} })
  after(cleanup)
  const fails = (args) => spawnSync(process.execPath, [BIN, ...args], { cwd: root, encoding: 'utf8' })

  it('fails on what it cannot take', () => {
    assert.deepEqual([fails(['--port=x']).status, fails(['--port=x']).stderr], [1, 'rn-serve: --port takes a port, not x\n'])
    assert.match(fails(['--babel', '--babel-aliases=aliases.json']).stderr, /pass one/u)
    assert.match(fails(['--babel']).stderr, /--babel needs a babel\.config/u)
    assert.match(fails(['--define=x']).stderr, /--define takes K=V, not x/u)
  })
})
