import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import esbuild from 'esbuild'

import { bundleRequest, toJscSafeUrl, toNormalUrl } from '../src/bundle-url.js'
import { createGate } from '../src/gate.js'
import { indexMappings } from '../src/mappings.js'
import { drawCodeFrame, stackOf, symbolicate } from '../src/symbolicate.js'
import { createDevBundler } from '../src/dev-bundler.js'
import { moduleUrls } from '../src/hot.js'
import { createWatcher } from '../src/watch.js'
import { writeTree } from './fixtures.js'

describe('the gate', () => {
  const gate = createGate({ hostnames: ['my-mac', 'my-mac.local'] })
  const asks = (headers) => gate({ headers })

  it('lets the app and its tools in: IP literals, localhost, the machine\'s own names; no Origin or its own', () => {
    for (const host of ['127.0.0.1:8081', 'localhost:8081', 'LOCALHOST', '10.0.2.2:8081', '192.168.1.5:8081', '[::1]:8081', 'my-mac:8081', 'my-mac.local', '0x7f.1:8081']) assert.equal(asks({ host }), null, host)
    assert.equal(asks({ host: 'localhost:8081', origin: 'http://localhost:8081' }), null)
    assert.equal(asks({ host: '10.0.2.2:8081', origin: 'http://10.0.2.2:8081', 'sec-fetch-site': 'same-origin' }), null)
    assert.equal(asks({ host: 'localhost:8081', 'sec-fetch-site': 'none' }), null)
  })

  it('keeps webpages out: another site, another origin, a rebound name', () => {
    for (const site of ['cross-site', 'same-site']) assert.match(asks({ host: 'localhost:8081', 'sec-fetch-site': site }), /request/u)
    for (const origin of ['https://evil.example', 'http://localhost:3000', 'http://127.0.0.1:8081', 'null', 'devtools://devtools', 'https://localhost:8081']) assert.notEqual(asks({ host: 'localhost:8081', origin }), null, origin)
    for (const host of ['evil.example:8081', '127.0.0.1.nip.io:8081', 'my-mac.evil.example', 'localhost.evil.example']) assert.match(asks({ host }), /isn't this server's/u, host)
  })

  it('takes a Host only as a host and a port', () => {
    for (const host of [undefined, '', 'evil.example@127.0.0.1', '127.0.0.1@evil.example', '127.0.0.1/x', '127.0.0.1 evil', '127.0.0.1#x', '127.0.0.1?x']) assert.notEqual(asks({ host }), null, String(host))
  })
})

describe('bundle URLs', () => {
  it('reads a bundle request as Metro does', () => {
    const request = bundleRequest(new URL('http://localhost:8081/index.bundle?platform=ios&dev=false&minify=1&lazy=true'))
    assert.deepEqual(request, {
      kind: 'bundle',
      entryFile: './index',
      platform: 'ios',
      dev: false,
      minify: true,
      shallow: false,
      modulesOnly: false,
      sourceUrl: 'http://localhost:8081/index.bundle//&platform=ios&dev=false&minify=1&lazy=true',
      sourceMapUrl: 'http://localhost:8081/index.map?platform=ios&dev=false&minify=1&lazy=true',
    })
  })

  it('takes the platform off the file name, bundleEntry over the path, dev on and minify off by default', () => {
    const named = bundleRequest(new URL('http://h/src/App.android.bundle'))
    assert.deepEqual([named.kind, named.entryFile, named.platform, named.dev, named.minify], ['bundle', './src/App.android', 'android', true, false])
    assert.equal(bundleRequest(new URL('http://h/x.other.bundle')).platform, null)
    assert.equal(bundleRequest(new URL('http://h/hot.map?bundleEntry=main.bundle&platform=ios')).entryFile, './main')
    assert.equal(bundleRequest(new URL('http://h/index.map?platform=ios')).kind, 'map')
    assert.equal(bundleRequest(new URL('http://h/a%20b.bundle')).entryFile, './a b')
    assert.equal(bundleRequest(new URL('http://h/index.js')), null)
    assert.throws(() => bundleRequest(new URL('http://h/%E0%A4%A.bundle')), URIError)
  })

  it('moves the query into the path for JSC, and back', () => {
    const url = 'http://localhost:8081/index.bundle?platform=ios&dev=true#x'
    assert.equal(toJscSafeUrl(url), 'http://localhost:8081/index.bundle//&platform=ios&dev=true#x')
    assert.equal(toNormalUrl(toJscSafeUrl(url)), url)
    assert.equal(toNormalUrl('/index.bundle//&platform=ios?dev=true'), '/index.bundle?platform=ios&dev=true')
    assert.equal(toJscSafeUrl('http://h/index.bundle'), 'http://h/index.bundle')
    assert.equal(toNormalUrl('http://h/a?x=//&y'), 'http://h/a?x=//&y')
  })
})

describe('source map lookups', () => {
  it('finds the source position of each generated one, as esbuild maps them', async () => {
    const source = ['// two', '', 'function first(a) {', '  return a + 1', '}', 'const second = () => first(2)', 'second()', ''].join('\n')
    const { code, map } = await esbuild.transform(source, { loader: 'ts', sourcemap: 'external', sourcefile: 'in.ts', minifyWhitespace: true })
    const index = indexMappings(JSON.parse(map).mappings)
    const lines = code.split('\n')
    const at = (token) => {
      const line = lines.findIndex((text) => text.includes(token))
      return index.originalPositionFor(line + 1, lines[line].indexOf(token))
    }
    assert.deepEqual(at('return'), { source: 0, line1: 4, column0: 2 })
    assert.deepEqual(at('second()'), { source: 0, line1: 7, column0: 0 })
    assert.equal(index.originalPositionFor(lines.length + 5, 0), null)
    assert.equal(index.originalPositionFor(0, 0), null)
  })

  it('reads negative deltas, long values and segments with no source', () => {
    // Line 1: col 0 -> (0, 10, 4); col 5 -> no source. Line 2: col 3 ->
    // (1, 0, 0), relative to line 1's state. Line 3: col 0 -> (1, 1000, 0).
    const index = indexMappings('AAUI,K;GCVJ;AAw+BA')
    assert.deepEqual(index.originalPositionFor(1, 0), { source: 0, line1: 11, column0: 4 })
    assert.deepEqual(index.originalPositionFor(1, 4), { source: 0, line1: 11, column0: 4 })
    assert.equal(index.originalPositionFor(1, 9), null)
    assert.deepEqual(index.originalPositionFor(2, 3), { source: 1, line1: 1, column0: 0 })
    assert.equal(index.originalPositionFor(2, 2), null)
    assert.deepEqual(index.originalPositionFor(3, 7), { source: 1, line1: 1001, column0: 0 })
    assert.throws(() => indexMappings('A!'), SyntaxError)
  })
})

describe('symbolication', () => {
  it('draws a code frame as @babel/code-frame does, uncolored', () => {
    const source = ['one', 'two', 'three', '\tfour()', 'five', 'six', 'seven', 'eight', 'nine', 'ten'].join('\n')
    assert.equal(drawCodeFrame(source, 4, 2), [' 2 | two', ' 3 | three', '>4 | \tfour()', '   | \t ^', ' 5 | five', ' 6 | six', ' 7 | seven'].join('\n'))
    assert.equal(drawCodeFrame(source, 9, null).split('\n').at(2), '> 9 | nine')
    assert.equal(drawCodeFrame(source, 9, null).split('\n').at(-1), ' 10 | ten')
  })

  it('takes a stack as Metro does, and refuses what it does not', () => {
    const normal = (url) => url.replace('//&', '?')
    assert.deepEqual(stackOf({ stack: [{ file: 'http://h/index.bundle//&platform=ios', lineNumber: 1, column: 2, methodName: 'f' }, {}] }, normal), [{ file: 'http://h/index.bundle?platform=ios', lineNumber: 1, column: 2, methodName: 'f' }, { file: undefined }])
    assert.throws(() => stackOf({ frames: [] }, normal), /expected object with stack array/u)
    assert.throws(() => stackOf({ stack: [{ lineNumber: '1' }] }, normal), /Bad frame at line 0: Expected lineNumber to be number or nullish/u)
    assert.throws(() => stackOf({ stack: [null] }, normal), /Expected frame to be a JSON object/u)
  })

  it("collapses React Native's own frames, and frames it has no map of stay", () => {
    const { stack, codeFrame } = symbolicate([
      { file: '/app/node_modules/react-native/Libraries/Core/ExceptionsManager.js', lineNumber: 1, column: 0 },
      { file: 'http://h/other.bundle', lineNumber: 3, column: 4, methodName: 'm' },
    ], new Map(), () => null)
    assert.deepEqual(stack.map(({ collapse }) => collapse), [true, false])
    assert.deepEqual(stack[1], { file: 'http://h/other.bundle', lineNumber: 3, column: 4, methodName: 'm', collapse: false })
    assert.equal(codeFrame, null)
  })
})

describe('watching', () => {
  // fs.watch, as a record of what is watched, and a way to fire a change.
  const fakeWatch = () => {
    const watched = new Map()
    const watch = (dir, { recursive }, listener) => {
      const watcher = { close: () => watched.delete(dir), on: () => watcher }
      watched.set(dir, { recursive, listener })
      return watcher
    }
    return { watch, watched, fire: (dir, name, event = 'change') => watched.get(dir).listener(event, name) }
  }
  const files = ['/app/index.js', '/app/src/a/b.js', '/app/node_modules/pkg/lib/x.js', '/store/dep/lib/y.js']

  it('watches the directory of each file read and those above it in the project, and each outside it', () => {
    const fake = fakeWatch()
    const changes = []
    const watcher = createWatcher('/app', (path) => changes.push(path), { watch: fake.watch, recursive: false })
    watcher.update(files)
    assert.deepEqual([...fake.watched.keys()].toSorted(), ['/app', '/app/node_modules', '/app/node_modules/pkg', '/app/node_modules/pkg/lib', '/app/src', '/app/src/a', '/store/dep/lib'])
    assert.ok([...fake.watched.values()].every(({ recursive }) => recursive === false))
    fake.fire('/app/src/a', 'b.ios.js', 'rename')
    fake.fire('/app/src/a', 'b.js')
    // A log beside them, written to.
    fake.fire('/app', 'rn-serve.log')
    assert.deepEqual(changes, ['/app/src/a/b.ios.js', '/app/src/a/b.js'])
    watcher.update(['/app/index.js'])
    assert.deepEqual([...fake.watched.keys()], ['/app'])
    watcher.close()
    assert.equal(fake.watched.size, 0)
  })

  it('watches the project root at once where that is cheap, its changes taken where a build read', () => {
    const fake = fakeWatch()
    const changes = []
    const watcher = createWatcher('/app', (path) => changes.push(path), { watch: fake.watch, recursive: true })
    watcher.update(files)
    assert.deepEqual([...fake.watched.keys()].toSorted(), ['/app', '/store/dep/lib'])
    assert.deepEqual([fake.watched.get('/app').recursive, fake.watched.get('/store/dep/lib').recursive], [true, false])
    fake.fire('/app', 'src/a/b.js')
    for (const name of ['node_modules/pkg/package.json', 'node_modules/new-pkg', 'ios/build/x.o', '.git/index']) fake.fire('/app', name, 'rename')
    fake.fire('/app', 'rn-serve.log')
    fake.fire('/store/dep/lib', 'y.js')
    assert.deepEqual(changes, ['/app/src/a/b.js', '/app/node_modules/pkg/package.json', '/app/node_modules/new-pkg', '/store/dep/lib/y.js'])
  })
})

describe('the dev bundler', () => {
  const { root, cleanup } = writeTree({ 'index.js': 'globalThis.result = 1\n', 'other.js': 'globalThis.result = 2\n' })
  after(cleanup)
  const request = (entryFile, platform = 'ios') => ({ kind: 'bundle', entryFile, platform, dev: true, minify: false })

  it('builds each bundle asked for at once, though more than it keeps', async () => {
    const devBundler = createDevBundler({ projectRoot: root, esbuild, targetOptions: () => ({ define: {} }), maxBuilds: 1 })
    try {
      const outcomes = await Promise.all([request('./index'), request('./other'), request('./index', 'android')].map((asked) => devBundler.get(asked)))
      assert.deepEqual(outcomes.map(({ ok, js }) => [ok, /result = (\d)/u.exec(js)?.[1]]), [[true, '1'], [true, '2'], [true, '1']])
    } finally {
      await devBundler.dispose()
    }
  })
})

describe('the dev bundler, in the module format', () => {
  // The app in a workspace, a module of which is out of it.
  const { root, cleanup } = writeTree({ 'app/index.js': "import { shared } from '../shared/Shared'\nglobalThis.result = shared\n", 'shared/Shared.js': "export const shared = 'shared'\n" })
  after(cleanup)
  const projectRoot = join(root, 'app')
  const runtime = createRequire(import.meta.url).resolve('metro-runtime/src/polyfills/require.js')

  it('serves a module out of the project root, alone, at the URL an update names it by', async () => {
    const devBundler = createDevBundler({ projectRoot, esbuild, runtime, targetOptions: () => ({ define: {} }) })
    try {
      const outcome = await devBundler.get({ kind: 'bundle', entryFile: './index', platform: 'ios', dev: true, minify: false })
      const record = [...outcome.modules.values()].find(({ name }) => name === '../shared/Shared.js')
      const { sourceURL } = moduleUrls('http://localhost:8081/index.bundle?platform=ios', record.name)
      const shallow = await devBundler.get(bundleRequest(new URL(toNormalUrl(sourceURL))))
      assert.ok(shallow?.js.startsWith('__d(function'), sourceURL)
      assert.ok(shallow.js.includes(`,${record.id},[],"../shared/Shared.js");`))
      assert.deepEqual(shallow.index().sources, [join(root, 'shared/Shared.js')])
    } finally {
      await devBundler.dispose()
    }
  })
})
