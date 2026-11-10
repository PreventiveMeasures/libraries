import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join, sep } from 'node:path'
import { after, describe, it } from 'node:test'
import { createContext, runInContext } from 'node:vm'

import esbuild from 'esbuild'

import { bundleRequest, toJscSafeUrl, toNormalUrl } from '../src/bundle-url.js'
import { createGate, hostnamesOf, isLoopback } from '../src/gate.js'
import { indexMappings } from '../src/mappings.js'
import { drawCodeFrame, stackOf, symbolicate } from '../src/symbolicate.js'
import { createClientLog, printable } from '../src/terminal.js'
import { createDevBundler } from '../src/dev-bundler.js'
import { moduleUrls } from '../src/hot.js'
import { servedSourceMap, sourceOfRequest, sourceRoutes } from '../src/source-map.js'
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

  it("refuses an IP address as Origin but the server's own (webpack-dev-server's CVE-2025-30360), and a page reaching it at 0.0.0.0", () => {
    for (const origin of ['http://192.168.1.5', 'http://192.168.1.5:8081', 'http://10.0.2.2:8081', 'http://[::1]:8081', 'http://0.0.0.0:8081', 'http://127.0.0.1']) assert.match(asks({ host: '127.0.0.1:8081', origin }), /request from/u, origin)
    // With no Origin or Sec-Fetch-Site too, as a browser sends an <img> or a navigation there.
    for (const host of ['0.0.0.0:8081', '0:8081', '[::]:8081', '[::ffff:127.0.0.1]:8081']) assert.match(asks({ host }), /isn't this server's/u, host)
  })

  // Argent's debugger: Origin http://127.0.0.1:8081 to ws://localhost:8081.
  it("takes localhost's Origin as the loopback address the connection came in on, and as no other, which may be another server's", () => {
    const via = (host, origin, localAddress) => gate({ headers: { host, origin }, socket: { localAddress, localPort: 8081 } })
    for (const [origin, address] of [['http://127.0.0.1:8081', '127.0.0.1'], ['http://127.0.0.1:8081', '::ffff:127.0.0.1'], ['http://[::1]:8081', '::1']]) assert.equal(via('localhost:8081', origin, address), null, `${origin} on ${address}`)
    for (const [host, origin, address] of [
      ['localhost:8081', 'http://127.0.0.1:8081', '::1'],
      ['localhost:8081', 'http://127.0.0.2:8081', '127.0.0.1'],
      ['localhost:8081', 'http://127.0.0.1:8082', '127.0.0.1'],
      ['localhost:8081', 'https://127.0.0.1:8081', '127.0.0.1'],
      ['localhost:8081', 'http://192.168.1.5:8081', '192.168.1.5'],
      // A forwarded port: 127.0.0.1:9000 is the forwarding machine's.
      ['localhost:9000', 'http://127.0.0.1:9000', '127.0.0.1'],
      // localhost's page may be another address's.
      ['127.0.0.1:8081', 'http://localhost:8081', '127.0.0.1'],
      ['[::1]:8081', 'http://127.0.0.1:8081', '127.0.0.1'],
    ]) assert.match(via(host, origin, address), /request from/u, `${host} ${origin} on ${address}`)
    // An upgrade's refusal isn't caught: none throws.
    for (const socket of [undefined, null, {}, { localAddress: null, localPort: 8081 }]) assert.match(gate({ headers: { host: 'localhost:8081', origin: 'http://127.0.0.1:8081' }, socket }), /request from/u, JSON.stringify(socket))
  })

  it("takes the machine's own names as a Host only of a server listening beyond loopback: a name the network answers for could be rebound", () => {
    for (const host of ['127.0.0.1', '127.1.2.3', '::1', '[::1]', '::ffff:127.0.0.1', 'localhost', 'LocalHost']) {
      assert.equal(isLoopback(host), true, host)
      assert.deepEqual(hostnamesOf(host, 'My-Mac.local'), [], host)
    }
    for (const host of ['0.0.0.0', '::', '192.168.1.5', 'fe80::1', '::ffff:192.168.1.5', 'my-mac.local', 'localhost.evil.example']) assert.equal(isLoopback(host), false, host)
    assert.deepEqual(hostnamesOf('0.0.0.0', 'My-Mac.local'), ['my-mac.local'])
    assert.deepEqual(hostnamesOf('::', 'my-mac'), ['my-mac', 'my-mac.local'])
    assert.deepEqual(hostnamesOf('Dev.example', 'my-mac'), ['my-mac', 'my-mac.local', 'dev.example'])
    const loopback = createGate({ hostnames: hostnamesOf('127.0.0.1', 'my-mac') })
    for (const host of ['my-mac:8081', 'my-mac.local:8081']) assert.match(loopback({ headers: { host } }), /isn't this server's/u, host)
    for (const host of ['localhost:8081', '127.0.0.1:8081', '[::1]:8081']) assert.equal(loopback({ headers: { host } }), null, host)
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
      sourcePaths: 'absolute',
      excludeSource: false,
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

  it("reads how its map names sources as Metro does: the app's sourcePaths=url-server and excludeSource where RN DevTools are on, else absolute", () => {
    const request = (query) => bundleRequest(new URL(`http://h/index.map?platform=ios&${query}`))
    assert.deepEqual([request('excludeSource=true&sourcePaths=url-server')].map(({ sourcePaths, excludeSource }) => [sourcePaths, excludeSource]), [['url-server', true]])
    for (const query of ['sourcePaths=absolute', 'sourcePaths=other', '']) assert.equal(request(query).sourcePaths, 'absolute', query)
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

describe("an app's console, as Metro's terminal prints it", () => {
  it('labels each line by its level, inverse, colored by it; of its mode where not the bridge; its data as console.log formats it', () => {
    const lines = []
    const log = createClientLog((line) => lines.push(line), (format, text) => `<${format.join(',')}>${text}</>`)
    log('log', 'BRIDGE', ['a', 1, { b: 2 }])
    log('warn', undefined, ['%s!', 'careful'])
    log('error', 'NOBRIDGE', ['bad  \n'])
    log('debug', 'BRIDGE', ['d'])
    log('trace', 'BRIDGE', ['t'])
    log('nonsense', 'BRIDGE', ['n'])
    log(1, 'BRIDGE', ['ignored'])
    log('log', 'BRIDGE', 'ignored')
    assert.deepEqual(lines, [
      '<inverse,white,bold> LOG </> a 1 { b: 2 }',
      '<inverse,yellow,bold> WARN </> careful!',
      '<inverse,red,bold> (NOBRIDGE) ERROR </> bad',
      '<inverse,white,bold> DEBUG </> d',
      '<inverse,white,bold> LOG </> t',
      '<inverse,white,bold> LOG </> n',
    ])
  })

  it('shows each control character of its data and mode escaped but its colors, which it resets', () => {
    const lines = []
    const log = createClientLog((line) => lines.push(line), (format, text) => `<${format.join(',')}>${text}</>`)
    log('log', 'BRIDGE', ['\u001B]52;c;ZWNobw==\u0007', '\u001B[32mok'])
    log('warn', 'NO\u001B[2JBRIDGE', ['%s', 'x\ry'])
    log('log', 'BRIDGE', [{ text: '\u001B[2J' }])
    assert.deepEqual(lines, [
      '<inverse,white,bold> LOG </> \\x1B]52;c;ZWNobw==\\x07 \u001B[32mok\u001B[0m',
      '<inverse,yellow,bold> (NO\\x1B[2JBRIDGE) WARN </> x\\x0Dy',
      "<inverse,white,bold> LOG </> { text: '\\x1B[2J' }",
    ])
  })

  it("indents a group's lines, its own too, and prints none of a collapsed one's", () => {
    const lines = []
    const log = createClientLog((line) => lines.push(line))
    log('group', 'BRIDGE', ['outer'])
    log('log', 'BRIDGE', ['in'])
    log('groupCollapsed', 'BRIDGE', ['hidden'])
    log('log', 'BRIDGE', ['hidden too'])
    log('groupEnd', 'BRIDGE', [])
    log('groupEnd', 'BRIDGE', [])
    log('log', 'BRIDGE', ['out'])
    assert.deepEqual(lines, [' GROUP    outer', ' LOG    in', ' LOG  out'])
  })
})

describe('text a client gave, as the terminal shows it', () => {
  const ESC = '\u001B'
  it('keeps its text, lines and tabs, a CRLF a line end; its colors, reset at its end where one is on', () => {
    assert.equal(printable('plain\ttext\nnext\r\nlast'), 'plain\ttext\nnext\nlast')
    assert.equal(printable(`${ESC}[31mred${ESC}[0m, ${ESC}[1;4mbold`), `${ESC}[31mred${ESC}[0m, ${ESC}[1;4mbold${ESC}[0m`)
    for (const reset of [`${ESC}[0m`, `${ESC}[m`, `${ESC}[00m`]) assert.equal(printable(`${ESC}[32mok${reset}`), `${ESC}[32mok${reset}`)
  })

  it('shows each other control character escaped: what would move the cursor, clear the screen, retitle, write the clipboard, link, ask a report', () => {
    for (const [text, shown] of [
      [`a${ESC}[2Jb`, 'a\\x1B[2Jb'],
      [`${ESC}[1A${ESC}[2Kover`, '\\x1B[1A\\x1B[2Kover'],
      ['before\rafter', 'before\\x0Dafter'],
      [`${ESC}]0;title\u0007`, '\\x1B]0;title\\x07'],
      [`${ESC}]52;c;ZWNobw==\u0007`, '\\x1B]52;c;ZWNobw==\\x07'],
      [`${ESC}]8;;https://evil.example${ESC}\\here${ESC}]8;;${ESC}\\`, '\\x1B]8;;https://evil.example\\x1B\\here\\x1B]8;;\\x1B\\'],
      [`${ESC}[21t${ESC}P$q m${ESC}\\`, '\\x1B[21t\\x1BP$q m\\x1B\\'],
      ['\u009B2J \u009D0;title\u009C', '\\x9B2J \\x9D0;title\\x9C'],
      ['\u0000\u0007[1m\b\u007F', '\\x00\\x07[1m\\x08\\x7F'],
    ]) assert.equal(printable(text), shown, JSON.stringify(text))
  })

  it('of no colors, shows those escaped too', () => {
    assert.equal(printable(`${ESC}[31mred`, { colors: false }), '\\x1B[31mred')
  })
})

describe('source maps, as Metro serves them', () => {
  const projectRoot = join(sep, 'work', 'app')
  const routes = sourceRoutes(projectRoot, [projectRoot, join(sep, 'work')])
  const map = JSON.stringify({ version: 3, sources: ['index.js', 'node_modules/x/a b.js', '../shared/s.js', join(sep, 'elsewhere', 'e.js'), 'metro-polyfill:node_modules/p/p.js', 'metro-main:index.js'], sourcesContent: ['1', '2', '3', '4', '5', '6'], names: [], mappings: 'AAAA' })

  it('names each source by its absolute path, those under node_modules ignored', () => {
    const served = JSON.parse(servedSourceMap(map, { projectRoot, routes }))
    assert.deepEqual(served.sources, [join(projectRoot, 'index.js'), join(projectRoot, 'node_modules/x/a b.js'), join(sep, 'work', 'shared', 's.js'), join(sep, 'elsewhere', 'e.js'), join(projectRoot, 'node_modules/p/p.js'), 'metro-main:index.js'])
    assert.deepEqual([served.sourcesContent, served.x_google_ignoreList], [['1', '2', '3', '4', '5', '6'], [1, 4]])
  })

  it('with sourcePaths=url-server, at a path of the server: of the project root, else of a watch folder, else absolute; with excludeSource, no contents', () => {
    const served = JSON.parse(servedSourceMap(map, { projectRoot, routes, urlServer: true, excludeSource: true }))
    assert.deepEqual(served.sources, ['/[metro-project]/index.js', '/[metro-project]/node_modules/x/a%20b.js', '/[metro-watchFolders]/1/shared/s.js', '/elsewhere/e.js', '/[metro-project]/node_modules/p/p.js', 'metro-main:index.js'])
    assert.equal('sourcesContent' in served, false)
  })

  it('reads a source request back to its file, inside its route alone', () => {
    assert.equal(sourceOfRequest('/[metro-project]/node_modules/x/a%20b.js', routes), join(projectRoot, 'node_modules/x/a b.js'))
    assert.equal(sourceOfRequest('/[metro-watchFolders]/1/shared/s.js', routes), join(sep, 'work', 'shared', 's.js'))
    for (const path of ['/[metro-project]/..%2Fother.js', '/[metro-project]/%2E%2E/other.js', '/[metro-project]/', '/[metro-project]/%E0%A4%A.js', '/[metro-watchFolders]/1/..%2F..%2Fetc%2Fpasswd']) assert.equal(sourceOfRequest(path, routes), null, path)
    for (const path of ['/index.js', '/[metro-watchFolders]/2/x.js', '/assets/x.png']) assert.equal(sourceOfRequest(path, routes), undefined, path)
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
    assert.deepEqual(stackOf({ stack: [{ file: 'http://h/index.bundle//&platform=ios', lineNumber: 1, column: 2, methodName: 'f' }, {}] }), [{ file: 'http://h/index.bundle?platform=ios', lineNumber: 1, column: 2, methodName: 'f' }, { file: undefined }])
    assert.throws(() => stackOf({ frames: [] }), /expected object with stack array/u)
    assert.throws(() => stackOf({ stack: [{ lineNumber: '1' }] }), /Bad frame at line 0: Expected lineNumber to be number or nullish/u)
    assert.throws(() => stackOf({ stack: [null] }), /Expected frame to be a JSON object/u)
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

  // Its patterns take time quadratic in a name's length.
  it("tests no name longer than a path for React Native's own", () => {
    const { stack } = symbolicate([{ file: `${'a'.repeat(4096)}/Libraries/Core/x.js` }], new Map(), () => null)
    assert.equal(stack[0].collapse, false)
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

  it("makes each bundle's target of the inline requires the Metro config gives it, though of one platform and dev", async () => {
    const given = []
    const metro = { assetExts: [], resolver: {}, blockList: null, polyfills: () => [], runBeforeMain: null, assetRegistryPath: null, minifyRefusal: null, transformRefusal: () => null, inlineRequires: (entryPath) => Promise.resolve(entryPath.endsWith('index.js') ? { of: 'index' } : null) }
    const targetOptions = ({ inlineRequires }) => {
      given.push(inlineRequires)
      return { define: {} }
    }
    const devBundler = createDevBundler({ projectRoot: root, esbuild, metro, targetOptions })
    try {
      for (const entry of ['./index', './other']) assert.equal((await devBundler.get(request(entry))).ok, true)
      assert.deepEqual(given, [{ of: 'index' }, null])
    } finally {
      await devBundler.dispose()
    }
  })
})

describe('the dev bundler, in the module format', () => {
  // The app in a workspace, a module of which is out of it.
  const { root, cleanup } = writeTree({
    'app/index.js': "import { shared } from '../shared/Shared'\nimport config, { of } from './config.json'\nimport { setup } from './config.js'\nimport { viaMjs } from './esm.mjs'\nimport { viaTyped } from './typed/user.js'\nglobalThis.result = [shared, config, of, setup, viaMjs, viaTyped]\n",
    // An ES module of Node's, by its extension or its package's type (one
    // with an import of nothing, built apart), and its default import.
    'app/def.js': "export default 'def'\n",
    'app/esm.mjs': "import def from './def.js'\nexport const viaMjs = def\n",
    'app/typed/package.json': { type: 'module' },
    'app/typed/user.js': "import def from '../def.js'\ntry {\n  require('not-installed')\n} catch {}\nexport const viaTyped = def\n",
    'app/config.js': "export const setup = 'js'\n",
    'app/config.json': '{ "of": "json" }\n',
    'shared/Shared.js': "export const shared = 'shared'\n",
  })
  after(cleanup)
  const projectRoot = join(root, 'app')
  const runtime = createRequire(import.meta.url).resolve('metro-runtime/src/polyfills/require.js')

  it("runs: each module's exports, a JSON file's too, as Metro wraps it; a default import as Babel's interop takes it, of an ES module of Node's too", async () => {
    const devBundler = createDevBundler({ projectRoot, esbuild, runtime, targetOptions: () => ({ define: {} }) })
    try {
      const outcome = await devBundler.get({ kind: 'bundle', entryFile: './index', platform: 'ios', dev: true, minify: false })
      const context = createContext({})
      runInContext(outcome.js, context)
      assert.deepEqual(JSON.parse(JSON.stringify(context.result)), ['shared', { of: 'json' }, 'json', 'js', 'def', 'def'])
      // Each mapped to its file, as it is named.
      const { sources } = outcome.index()
      assert.ok(sources.includes(join(projectRoot, 'esm.mjs')) && !sources.some((source) => source.endsWith('.mjs.js')), String(sources))
    } finally {
      await devBundler.dispose()
    }
  })

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

  it('tells modules of one name but their extension apart', async () => {
    const devBundler = createDevBundler({ projectRoot, esbuild, runtime, targetOptions: () => ({ define: {} }) })
    try {
      await devBundler.get({ kind: 'bundle', entryFile: './index', platform: 'ios', dev: true, minify: false })
      const shallow = async (name) => (await devBundler.get(bundleRequest(new URL(toNormalUrl(moduleUrls('http://localhost:8081/index.bundle?platform=ios', name).sourceURL))))).index().sources
      assert.deepEqual([await shallow('config.js'), await shallow('config.json')], [[join(projectRoot, 'config.js')], [join(projectRoot, 'config.json')]])
    } finally {
      await devBundler.dispose()
    }
  })

  it("serves a module of the bundle its URL's minify names, whichever was asked for last", async () => {
    const devBundler = createDevBundler({ projectRoot, esbuild, runtime, targetOptions: () => ({ define: {} }) })
    try {
      for (const minify of [false, true]) await devBundler.get({ kind: 'bundle', entryFile: './index', platform: 'ios', dev: true, minify })
      const shallow = (minify) => devBundler.get(bundleRequest(new URL(toNormalUrl(moduleUrls(`http://localhost:8081/index.bundle?platform=ios&minify=${minify}`, '../shared/Shared.js').sourceURL))))
      assert.match((await shallow(false)).js, /var shared = "shared";/u)
      assert.doesNotMatch((await shallow(true)).js, /var shared = /u)
    } finally {
      await devBundler.dispose()
    }
  })
})
