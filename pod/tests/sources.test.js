import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { crc32, deflateRawSync } from 'node:zlib'

import { compress } from '@preventive/archive/compression.js'
import { pack } from '@preventive/archive/tar.js'
import { zip } from '@preventive/archive/zip.js'

import { expandBraces, fnmatch } from '../src/fnmatch.js'
import { archiveOf } from '../src/sources/archive.js'
import { installPod, planPod } from '../src/sources/clean.js'
import { readPodspec } from '../src/sources/podspec.js'
import { layoutPods } from '../src/sources/sources.js'

// Stage 2's reading of a download: what installPod keeps, fnmatch and expandBraces, what archiveOf makes of a tar
// or a zip, and layoutPods from the archive's URL to Pods/.

// A zip with every field as given, as zip.js would not write one: `system` the maker, `attributes` the external
// ones, `internal`, `version`, `flags` and `extra` as they are.
function rawZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const data = Buffer.from(entry.data ?? '')
    const extra = entry.extra ?? Buffer.alloc(0)
    const system = entry.system ?? 3
    const attributes = entry.attributes ?? (entry.mode ?? (name.at(-1) === 0x2f ? 0o40755 : 0o100644)) * 0x10000
    const crc = crc32(data) >>> 0
    const body = entry.deflate ? deflateRawSync(data) : data
    const method = entry.deflate ? 8 : 0
    const size = entry.size ?? data.length
    const version = entry.version ?? 20
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(version, 4); local.writeUInt16LE(entry.flags ?? 0, 6); local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0x21, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(size, 22)
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(extra.length, 28)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE((system << 8) | 30, 4); central.writeUInt16LE(version, 6); central.writeUInt16LE(entry.flags ?? 0, 8); central.writeUInt16LE(method, 10)
    central.writeUInt16LE(0x21, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(size, 24)
    central.writeUInt16LE(name.length, 28); central.writeUInt16LE(extra.length, 30); central.writeUInt16LE(entry.internal ?? 0, 36); central.writeUInt32LE(attributes >>> 0, 38); central.writeUInt32LE(offset, 42)
    const whole = Buffer.concat([local, name, extra, body])
    locals.push(whole)
    centrals.push(Buffer.concat([central, name, extra]))
    offset += whole.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return new Uint8Array(Buffer.concat([...locals, directory, end]))
}

describe('installPod', () => {
  // A download of Foo.h and `Alias.h` linking to `foo.h`, each a source file of the root, unless `files` and `links`
  // say otherwise; `spec` what the root has beside its name and version.
  const FOO = { 'Foo.h': 'foo' }
  const ALIAS = { 'Alias.h': 'foo.h' }
  const HEADERS = { source_files: '*.h' }
  const install = ({ folded = false, files = FOO, links = ALIAS, spec = HEADERS }) => {
    const podspec = readPodspec(Buffer.from(JSON.stringify({ name: 'Pod', version: '1.0.0', ...spec })))
    const contents = { dirs: [], files: new Map(Object.entries(files).map(([path, data]) => [path, { data: Buffer.from(data), mode: 0o644 }])), links: new Map(Object.entries(links)) }
    const out = installPod(contents, planPod(podspec, [podspec], 'ios'), { folded, where: 'pod' })
    return Object.fromEntries([...[...out.files].map(([path, { mode }]) => [path, mode.toString(8)]), ...out.links])
  }

  it('keeps what a spec uses, and makes its source files read-only', () => {
    const files = { 'Foo.h': 'foo', 'unused.txt': 'x', 'res/a.png': 'a', 'res/b.txt': 'b', LICENSE: 'MIT', 'README.md': 'r' }
    const spec = { source_files: '*.h', resources: 'res/*.png', license: { type: 'MIT' } }
    assert.deepEqual(install({ files, links: {}, spec }), { 'Foo.h': '444', 'res/a.png': '644', LICENSE: '644', 'README.md': '644' })
  })

  it('follows a link on macOS to a name of another case, as its filesystem finds one', () => {
    assert.deepEqual(install({ folded: true }), { 'Foo.h': '444', 'Alias.h': 'foo.h' })
    assert.throws(() => install({}), /the source file "Alias\.h" links to nothing/u)
  })

  it('refuses on macOS a download with two names that are one there, whatever is kept of it', () => {
    const files = { 'Foo.h': 'foo', 'A.txt': 'a', 'a.TXT': 'b' }
    assert.throws(() => install({ folded: true, files, links: {} }), /"A\.txt" and "a\.TXT" are one name on macOS/u)
    assert.deepEqual(install({ files, links: {} }), { 'Foo.h': '444' })
  })

  it('takes a link to nothing at all as one that leads nowhere', () => {
    assert.throws(() => install({ links: { 'Alias.h': '' } }), /the source file "Alias\.h" links to nothing/u)
  })

  it('gives up on a chain of links where the system does: after 40 on Linux, 32 on macOS', () => {
    // c1.h to c35.h, each a link to the next, the last to Foo.h.
    const links = Object.fromEntries(Array.from({ length: 35 }, (_, i) => [`c${i + 1}.h`, i === 34 ? 'Foo.h' : `c${i + 2}.h`]))
    assert.equal(install({ links })['Foo.h'], '444')
    assert.throws(() => install({ folded: true, links }), /the source file "c1\.h" links to nothing/u)
  })

  it('refuses a pod that takes too many matches to clean, before making them', () => {
    const files = Object.fromEntries(Array.from({ length: 50_000 }, (_, i) => [`f${i}.h`, '']))
    const spec = { source_files: Array.from({ length: 12 }, (_, i) => `{a${i},b${i}}`).join('') }
    const started = Date.now()
    assert.throws(() => install({ files, links: {}, spec }), /its file patterns take over 200000000 matches/u)
    assert.ok(Date.now() - started < 10_000)
  })
})

describe('fnmatch', () => {
  // Each as Ruby's File.fnmatch has it, with FNM_CASEFOLD | FNM_PATHNAME.
  it('matches as Ruby does, its bracket quirk with it', () => {
    for (const [pattern, path, expected] of [
      ['**/*.m', 'a/b/f.m', true], ['**/*.m', 'f.m', true], ['a/**/f.m', 'a/f.m', true], ['*', '.h', false], ['**/*', 'a/.h/x', false],
      ['**/b', '.x/b', false], ['.*', '.x', true], ['[.]x', '.x', false], ['A*', 'abc', true], ['\u00E9', '\u00C9', false],
      ['[a]', 'A', false], ['[ba]', 'A', true], ['[ab]', 'B', true], ['[a-c]', 'B', true], ['[!a]', 'A', true], ['a?b', 'a/b', false],
      ['[/]', '/', false], ['\\*', '*', true], ['*', '', true], ['[]a]', ']', false], ['[a-]', '-', true],
    ]) assert.equal(fnmatch(pattern, path), expected, `${pattern} ${path}`)
  })
})

describe('expandBraces', () => {
  it('expands as PathList does: each set by its text, values split as Ruby splits them', () => {
    assert.deepEqual(expandBraces('a/**/b'), ['a/**/b', 'a/b'])
    assert.deepEqual(expandBraces('{a,b}/{c,d}'), ['a/c', 'a/d', 'b/c', 'b/d'])
    assert.deepEqual(expandBraces('{a,b}/{a,b}'), ['a/a', 'b/b'])
    assert.deepEqual(expandBraces('x{}'), [])
    assert.deepEqual(expandBraces('x{,}'), [])
    assert.deepEqual(expandBraces('x{,a,}'), ['x', 'xa'])
    assert.deepEqual(expandBraces('{a{b}'), ['ab'])
    assert.equal(expandBraces('{a\\b,c}'), undefined)
  })
})

describe('archiveOf', () => {
  const tgz = { archive: 'tgz', file: 'file.tgz', flatten: true }
  const listed = ({ dirs, files, links }) => ({ dirs: [...dirs].sort(), files: Object.fromEntries([...files].map(([path, { mode }]) => [path, mode.toString(8)])), links: Object.fromEntries(links) })
  const extract = async (entries, source = tgz) => listed(await archiveOf(await compress(pack(entries), 'gzip'), source, 'pod'))

  it('extracts a tar as tar does for a user other than root, flattening one directory, and copies hard links', async () => {
    const out = await extract([
      { name: 'Pod-1.0/', type: 'directory', mode: 0o700 },
      { name: 'Pod-1.0/a.h', data: Buffer.from('a'), mode: 0o666 },
      { name: 'Pod-1.0/b.h', type: 'hardlink', linkname: 'Pod-1.0/a.h' },
      { name: 'Pod-1.0/sub/run', data: Buffer.from('#!'), mode: 0o4775 },
      { name: 'Pod-1.0/c.h', type: 'symlink', linkname: 'a.h' },
    ])
    assert.deepEqual(out, { dirs: [], files: { 'a.h': '644', 'b.h': '644', 'sub/run': '755' }, links: { 'c.h': 'a.h' } })
    assert.deepEqual((await extract([{ name: 'Pod-1.0/a.h', data: Buffer.from('a') }], { ...tgz, flatten: false })).files, { 'Pod-1.0/a.h': '644' })
    assert.deepEqual((await extract([{ name: 'Pod-1.0/a.h', data: Buffer.from('a') }, { name: 'README', data: Buffer.from('r') }])).files, { 'Pod-1.0/a.h': '644', README: '644' }, 'two things are not flattened')
    assert.deepEqual((await archiveOf(pack([{ name: 'x/a.h', data: Buffer.from('a') }]), tgz, 'pod')).files.get('a.h').mode, 0o644, 'a tar not gzipped')
  })

  it('refuses what tar would make otherwise on another machine, or what the moves would meet', async () => {
    for (const [entries, message] of [
      [[{ name: 'x/._a', data: Buffer.from('') }], /a `\._` name, which bsdtar on macOS takes as metadata/u],
      [[{ name: 'x/.git/config', data: Buffer.from('') }], /a \.git, which CocoaPods 1\.16 drops/u],
      [[{ name: 'x/fifo', type: 'fifo' }], /a fifo entry/u],
      [[{ name: 'file.tgz', data: Buffer.from('') }], /the archive holds "file\.tgz", its own download's name/u],
      [[{ name: 'x', type: 'symlink', linkname: 'y' }], /"x": a link to flatten/u],
      [[{ name: 'x./a', data: Buffer.from('') }], /"x\.": a name ending in `\.` to flatten/u],
      [[{ name: 'x/x.tmp', data: Buffer.from('') }], /holds "x\.tmp", which flattening uses/u],
    ]) await assert.rejects(extract(entries), (error) => error.name === 'PodError' && message.test(error.message), JSON.stringify(entries))
    await assert.rejects(archiveOf(Buffer.from('not a tar at all'), tgz, 'pod'), /unreadable archive/u)
  })

  const zipSource = { archive: 'zip', file: 'file.zip', flatten: false }
  const unzipped = async (bytes, source = zipSource) => listed(await archiveOf(bytes, source, 'pod'))
  const U = (mode) => mode * 0x10000

  it('extracts a zip as unzip does, flattened only where asked', async () => {
    const made = await zip([
      { name: 'Pod-1.0/', type: 'directory', mode: 0o700 },
      { name: 'Pod-1.0/a.h', data: Buffer.from('a'), mode: 0o664 },
      { name: 'Pod-1.0/sub/run', data: Buffer.from('#!'), mode: 0o4755 },
      { name: 'Pod-1.0/c.h', type: 'symlink', linkname: 'a.h' },
    ])
    assert.deepEqual(await unzipped(made), { dirs: ['Pod-1.0'], files: { 'Pod-1.0/a.h': '664', 'Pod-1.0/sub/run': '755' }, links: { 'Pod-1.0/c.h': 'a.h' } })
    assert.deepEqual(await unzipped(made, { ...zipSource, flatten: true }), { dirs: [], files: { 'a.h': '664', 'sub/run': '755' }, links: { 'c.h': 'a.h' } })
  })

  it("takes a file's mode as unzip does: a Unix maker's as stored, any other's 0o644 or, read-only, 0o444", async () => {
    const out = await unzipped(rawZip([
      { name: 'unix', data: 'x', system: 3, attributes: U(0o100600) },
      { name: 'beos', data: 'x', system: 16, attributes: U(0o100664) },
      { name: 'plain', data: 'x', system: 0, attributes: 0 },
      { name: 'readonly', data: 'x', system: 0, attributes: 1 },
      { name: 'pkzip', data: 'x', system: 0, attributes: U(0o100664) },
      { name: 'exec-by-dos', data: 'x', system: 0, attributes: U(0o100755) },
      { name: 'ntfs', data: 'x', system: 11, attributes: U(0o100600) },
    ]))
    assert.deepEqual(out.files, { unix: '600', beos: '664', plain: '644', readonly: '444', pkzip: '664', 'exec-by-dos': '644', ntfs: '644' })
  })

  it('refuses what unzip asks about, and what CocoaPods would fail on', async () => {
    for (const [entries, message] of [
      [[], /an empty zip, which CocoaPods fails on/u],
      [[{ name: 'a', data: 'x' }, { name: 'a', data: 'x' }], /"a": a name twice, which unzip prompts on/u],
      [[{ name: 'x/.git/config', data: '' }], /a \.git, which CocoaPods 1\.16 drops/u],
      [[{ name: 'file.zip', data: '' }], /the archive holds "file\.zip", its own download's name/u],
      [[{ name: 'x', data: 'y', attributes: U(0o120777) }], /"x": a link to flatten/u],
      [[{ name: 'a', data: '', extra: Buffer.from([0x75, 0x70, 1, 0, 1]) }], /unreadable archive: .*Unicode path extra field/u],
    ]) await assert.rejects(unzipped(rawZip(entries), { ...zipSource, flatten: true }), (error) => error.name === 'PodError' && message.test(error.message), JSON.stringify(entries))
  })
})

// Acme's release, as a tar.gz and a zip of one directory: what CocoaPods keeps of it, and what it cleans away.
const ENTRIES = [
  { name: 'Acme/', type: 'directory', mode: 0o755 },
  { name: 'Acme/Acme.h', data: Buffer.from('int acme;\n'), mode: 0o644 },
  { name: 'Acme/run.sh', data: Buffer.from('#!/bin/sh\n'), mode: 0o755 },
  { name: 'Acme/unused.txt', data: Buffer.from('x\n'), mode: 0o644 },
]
const ARCHIVES = { tgz: await compress(pack(ENTRIES), 'gzip'), zip: await zip(ENTRIES) }

describe('layoutPods', () => {
  const RELEASE = 'https://github.com/acme/acme/releases/download/v1.0.0/Acme'
  const MAVEN = 'https://repo1.maven.org/maven2/com/facebook/acme/acme-artifacts/1.0.0/acme-artifacts-1.0.0'
  const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
  const dirs = []
  const served = globalThis.fetch
  after(() => {
    globalThis.fetch = served
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })
  // Acme by `source`, from an archive served at `url`, and the pods named `also` by its podspec: what is written of
  // Acme, by path and mode. What is fetched is kept in `asked`.
  async function layout(source, url = source.http, archive = ARCHIVES.tgz, asked = [], also = []) {
    globalThis.fetch = (input) => {
      asked.push(String(input))
      return Promise.resolve(String(input) === url ? new Response(archive) : new Response('Not Found', { status: 404 }))
    }
    const podspec = Buffer.from(JSON.stringify({ name: 'Acme', version: '1.0.0', source: { sha256: sha256(archive), ...source }, source_files: '*.h', preserve_paths: 'run.sh' }))
    const root = mkdtempSync(join(tmpdir(), 'pod-sources-test-'))
    dirs.push(root)
    const sandbox = join(root, 'Pods')
    const pod = { name: 'Acme', version: '1.0.0', checksum: '0'.repeat(40), specs: ['Acme'], dir: join(sandbox, 'Acme'), local: false, external: false, repo: 'trunk', checkout: false, podspec }
    const pods = [pod, ...also.map((name) => ({ ...pod, name, dir: join(sandbox, name) }))]
    const downloaded = await layoutPods({ sandbox, cocoapods: '1.16.2', platform: 'ios', pods }, () => assert.fail('no prepare_command'))
    const files = Object.fromEntries(readdirSync(join(sandbox, 'Acme')).map((name) => [name, (lstatSync(join(sandbox, 'Acme', name)).mode & 0o777).toString(8)]))
    return { downloaded, files }
  }
  const KEPT = { 'Acme.h': '444', 'run.sh': '755' }

  it("downloads a GitHub release's .tar.gz and .zip, and Maven Central's under com/facebook/, as CocoaPods keeps them", async () => {
    for (const [url, archive, flatten] of [[`${RELEASE}.tar.gz`, ARCHIVES.tgz], [`${RELEASE}.zip`, ARCHIVES.zip, true], [`${MAVEN}.tar.gz`, ARCHIVES.tgz], [`${MAVEN}.zip`, ARCHIVES.zip, true]]) {
      const asked = []
      const { downloaded, files } = await layout({ http: url, ...(flatten ? { flatten } : {}) }, url, archive, asked)
      assert.deepEqual([downloaded, files, asked], [['Acme'], KEPT, [url]], url)
    }
    // A zip is not flattened unless :flatten says so: its files stay under Acme/, which no pattern names, and go.
    assert.deepEqual((await layout({ http: `${RELEASE}.zip` }, `${RELEASE}.zip`, ARCHIVES.zip)).files, {})
    assert.deepEqual((await layout({ http: `${MAVEN}.tar.gz`, type: 'tgz' })).files, KEPT)
  })

  it('refuses any source but such an archive, held to its sha256, before fetching anything', async () => {
    for (const [source, message] of [
      [{ git: 'https://github.com/acme/acme.git', commit: 'c'.repeat(40) }, /pods\["Acme"\]: a :git source is not supported/u],
      [{ http: `${MAVEN}.tar.gz`.replace('/facebook/', '/facebookx/') }, /"https:\/\/repo1\.maven\.org\/maven2\/com\/facebookx\/.*" is not a GitHub URL, or a \.tar\.gz or \.zip under https:\/\/repo1\.maven\.org\/maven2\/com\/facebook\//u],
      [{ http: `${MAVEN}.jar` }, /\.jar" is not a GitHub URL/u],
      [{ http: `${MAVEN}.tar.gz`.replace('/facebook/', '/facebook/../google/') }, /\/\.\.\/google\/.*" is not a GitHub URL/u],
      [{ http: `${MAVEN}.tar.gz`, type: 'zip' }, /its :type "zip" is not its URL's tgz/u],
      [{ http: `${RELEASE}.tar.gz`, sha256: null, sha1: 'a'.repeat(40) }, /its source has no :sha256, only a :sha1/u],
    ]) {
      const asked = []
      await assert.rejects(layout(source, 'nowhere', ARCHIVES.tgz, asked), (error) => error.name === 'PodError' && message.test(error.message), JSON.stringify(source))
      assert.deepEqual(asked, [], JSON.stringify(source))
    }
  })

  it('refuses an archive that is not the one its sha256 is of', async () => {
    const url = `${MAVEN}.tar.gz`
    await assert.rejects(layout({ http: url, sha256: 'b'.repeat(64) }, url), (error) => error.name === 'PodError' && /pods\["Acme"\]: "https:\/\/repo1\.maven\.org\/maven2\/com\/facebook\/.*" has sha256 [\da-f]{64}, not b{64}/u.test(error.message))
  })

  it('refuses on macOS two pods whose directories are one there, before fetching anything', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    const url = `${RELEASE}.tar.gz`
    try {
      Object.defineProperty(process, 'platform', { value: 'linux' })
      const asked = []
      assert.deepEqual((await layout({ http: url }, url, ARCHIVES.tgz, asked, ['acme'])).downloaded, ['Acme', 'acme'])
      assert.deepEqual(asked, [url], 'one archive is fetched once')
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      asked.length = 0
      await assert.rejects(layout({ http: url }, url, ARCHIVES.tgz, asked, ['acme']), /pods\["acme"\]: "Acme" and "acme" are one name on macOS/u)
      assert.deepEqual(asked, [])
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
  })
})
