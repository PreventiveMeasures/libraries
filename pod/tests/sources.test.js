import assert from 'node:assert/strict'
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

// Stage 2's own reading of a download, as deptree's tests hold deptree's to it: what installPod keeps, fnmatch and
// expandBraces, and what archiveOf makes of a tar or a zip.

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
  // A download of Foo.h and `Alias.h` linking to `foo.h`, each a source
  // file of the root, unless `files` and `links` say otherwise; `spec`
  // what the root has beside its name and version.
  const FOO = { 'Foo.h': 'foo' }
  const ALIAS = { 'Alias.h': 'foo.h' }
  const HEADERS = { source_files: '*.h' }
  const install = ({ folded = false, keepsGit = false, files = FOO, links = ALIAS, spec = HEADERS }) => {
    const podspec = readPodspec(Buffer.from(JSON.stringify({ name: 'Pod', version: '1.0.0', ...spec })), 'Pod', '1.0.0', 'pod')
    const contents = { dirs: [], files: new Map(Object.entries(files).map(([path, data]) => [path, { data: Buffer.from(data), mode: 0o644 }])), links: new Map(Object.entries(links)) }
    const out = installPod(contents, planPod(podspec, [podspec], undefined, 'pod'), { folded, keepsGit, where: 'pod' })
    return Object.fromEntries([...[...out.files].map(([path, { mode }]) => [path, mode.toString(8)]), ...out.links])
  }

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

  it("refuses, before CocoaPods 1.16, a pod whose patterns keep the clone's .git", () => {
    const spec = { source_files: '*.h', preserve_paths: '.*' }
    assert.throws(() => install({ keepsGit: true, links: {}, spec }), /keep the \.git of the clone/u)
    assert.deepEqual(install({ links: {}, spec }), { 'Foo.h': '444' })
    assert.deepEqual(install({ keepsGit: true, links: {} }), { 'Foo.h': '444' })
  })

  it('refuses a name or a path longer than the system takes, and a letter Ruby releases case otherwise', () => {
    assert.throws(() => install({ files: { [`${'a'.repeat(256)}.h`]: '' }, links: {} }), /longer than a path or a name can be/u)
    const deep = { [`${'d/'.repeat(600)}x.h`]: '' }
    assert.deepEqual(Object.keys(install({ files: deep, links: {} })), [])
    assert.throws(() => install({ folded: true, files: deep, links: {} }), /longer than a path or a name can be/u)
    assert.throws(() => install({ files: { '\u{10D50}.h': '' }, links: {} }), /a letter whose case each release of Ruby maps otherwise/u)
  })

  it('refuses a pod that takes too many matches to clean, before making them', () => {
    const files = Object.fromEntries(Array.from({ length: 50_000 }, (_, i) => [`f${i}.h`, '']))
    const spec = { source_files: Array.from({ length: 12 }, (_, i) => `{a${i},b${i}}`).join('') }
    const started = Date.now()
    assert.throws(() => install({ files, links: {}, spec }), /take more than 200000000 matches/u)
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
  const archive = async (entries, gzip = true) => {
    const tar = pack(entries)
    return gzip ? await compress(tar, 'gzip') : tar
  }
  const extract = async (entries, source = tgz) => {
    const { dirs, files, links } = await archiveOf(await archive(entries), source, 'pod')
    return { dirs: [...dirs].sort(), files: Object.fromEntries([...files].map(([path, { mode }]) => [path, mode.toString(8)])), links: Object.fromEntries(links) }
  }

  it('extracts as a user other than root, flattening one directory, and copies hard links', async () => {
    const out = await extract([
      { name: 'Pod-1.0/', type: 'directory', mode: 0o700 },
      { name: 'Pod-1.0/a.h', data: Buffer.from('a'), mode: 0o666 },
      { name: 'Pod-1.0/b.h', type: 'hardlink', linkname: 'Pod-1.0/a.h' },
      { name: 'Pod-1.0/sub/run', data: Buffer.from('#!'), mode: 0o775 },
      { name: 'Pod-1.0/c.h', type: 'symlink', linkname: 'a.h' },
    ])
    assert.deepEqual(out, { dirs: [], files: { 'a.h': '644', 'b.h': '644', 'sub/run': '755' }, links: { 'c.h': 'a.h' } })
    assert.deepEqual((await extract([{ name: 'Pod-1.0/a.h', data: Buffer.from('a') }], { archive: 'tgz', file: 'file.tgz', flatten: false })).files, { 'Pod-1.0/a.h': '644' })
    assert.deepEqual((await extract([{ name: 'Pod-1.0/a.h', data: Buffer.from('a') }, { name: 'README', data: Buffer.from('r') }])).files, { 'Pod-1.0/a.h': '644', README: '644' }, 'two things are not flattened')
    assert.deepEqual((await archiveOf(await archive([{ name: 'x/a.h', data: Buffer.from('a') }], false), tgz, 'pod')).files.get('a.h').mode, 0o644, 'a tar not gzipped')
  })

  it('refuses what tar would make otherwise on another machine, or what the moves would meet', async () => {
    for (const [entries, message] of [
      [[{ name: 'x/run', data: Buffer.from(''), mode: 0o4755 }], /a mode of 4755, with a bit tar sets or drops/u],
      [[{ name: 'x/', type: 'directory', mode: 0o555 }, { name: 'x/a', data: Buffer.from('') }], /a directory of mode 555, which its owner cannot list and write in/u],
      [[{ name: 'x/a', data: Buffer.from(''), mode: 0o200 }], /a file of mode 200, which its owner cannot read/u],
      [[{ name: 'x/._a', data: Buffer.from('') }], /a name starting with `\._`/u],
      [[{ name: 'x/.git/config', data: Buffer.from('') }], /a path with a \.git in it/u],
      [[{ name: 'x/fifo', type: 'fifo' }], /a fifo, which a pod's download cannot hold/u],
      [[{ name: 'file.tgz', data: Buffer.from('') }], /the archive holds "file\.tgz", the name RemoteFile downloads it under/u],
      [[{ name: 'x', type: 'symlink', linkname: 'y' }], /the one thing in the archive is a link/u],
      [[{ name: 'x./a', data: Buffer.from('') }], /has a name ending in `\.`/u],
      [[{ name: 'x/x.tmp', data: Buffer.from('') }], /holds "x\.tmp", the name it is moved to/u],
    ]) await assert.rejects(extract(entries), (error) => error.name === 'PodError' && message.test(error.message), JSON.stringify(entries))
    await assert.rejects(archiveOf(Buffer.from('BZh91AY&SY'), tgz, 'pod'), /compressed with bzip2, which is not read here/u)
    await assert.rejects(archiveOf(Buffer.from('not a tar at all'), tgz, 'pod'), /its archive cannot be read/u)
    await assert.rejects(archiveOf(rawZip([{ name: 'a', data: '' }]), tgz, 'pod'), /its archive is a zip, which bsdtar extracts for `tar xf` and GNU tar does not/u)
    await assert.rejects(archiveOf(rawZip([]), tgz, 'pod'), /its archive is a zip/u)
  })

  const zipSource = { archive: 'zip', file: 'file.zip', flatten: false }
  const unzipped = async (bytes, source = zipSource) => {
    const { dirs, files, links } = await archiveOf(bytes, source, 'pod')
    return { dirs: [...dirs].sort(), files: Object.fromEntries([...files].map(([path, { mode }]) => [path, mode.toString(8)])), links: Object.fromEntries(links) }
  }
  const U = (mode) => mode * 0x10000

  it('extracts a zip as unzip does, a Unix maker\'s modes as they are but for the special bits, flattened only where asked', async () => {
    const made = await zip([
      { name: 'Pod-1.0/', type: 'directory', mode: 0o700 },
      { name: 'Pod-1.0/a.h', data: Buffer.from('a'), mode: 0o664 },
      { name: 'Pod-1.0/sub/run', data: Buffer.from('#!'), mode: 0o4755 },
      { name: 'Pod-1.0/c.h', type: 'symlink', linkname: 'a.h' },
    ])
    assert.deepEqual(await unzipped(made), { dirs: ['Pod-1.0'], files: { 'Pod-1.0/a.h': '664', 'Pod-1.0/sub/run': '755' }, links: { 'Pod-1.0/c.h': 'a.h' } })
    assert.deepEqual(await unzipped(made, { ...zipSource, flatten: true }), { dirs: [], files: { 'a.h': '664', 'sub/run': '755' }, links: { 'c.h': 'a.h' } })
    assert.deepEqual((await unzipped(await zip([{ name: 'x/a.h', data: Buffer.from('a') }], { method: 'store' }))).files, { 'x/a.h': '644' })
    await assert.rejects(archiveOf(await archive([{ name: 'x/a.h', data: Buffer.from('a') }]), zipSource, 'pod'), /its archive cannot be read: no end of central directory record/u)
  })

  it('reads the attributes as unzip does, by the system an entry was made on, and a directory\'s where unzip makes it', async () => {
    const out = await unzipped(rawZip([
      { name: 'plain', data: 'x', system: 0, attributes: 0 },
      { name: 'readonly', data: 'x', system: 0, attributes: 1 },
      { name: 'pkzip', data: 'x', system: 0, attributes: U(0o100664) },
      { name: 'pkzip-ro', data: 'x', system: 0, attributes: U(0o100400) | 1 },
      { name: 'exec-by-dos', data: 'x', system: 0, attributes: U(0o100755) },
      { name: 'ntfs', data: 'x', system: 11, attributes: U(0o100600) },
      { name: 'later', data: 'x', system: 99, attributes: U(0o100600) | 1 },
      { name: 'dos-dir/', system: 0, attributes: 0x10 },
      { name: 'dos-dir/in', data: 'x', system: 0, attributes: 0 },
      { name: 'unix', data: 'x', system: 3, attributes: U(0o100600) },
      { name: 'unix-untyped', data: 'x', system: 3, attributes: U(0o640) },
      { name: 'unix-sgid', data: 'x', system: 3, attributes: U(0o102755) },
      { name: 'beos', data: 'x', system: 16, attributes: U(0o100664) },
      { name: 'qdos-link', data: 'x', system: 12, attributes: U(0o120777) },
      { name: 'late/f', data: 'x' },
      { name: 'late/', attributes: U(0o040555) | 0x10 },
      { name: 'late/', attributes: U(0o040555) | 0x10 },
      { name: './', attributes: U(0o040755) | 0x10 },
      { name: 'x;1/', attributes: U(0o040755) | 0x10 },
      { name: 'x;1/a;1b', data: '' },
      { name: '__MACOSX/._plain', data: 'Mac OS X' },
      { name: 'pk45', data: 'x', version: 45 },
      { name: 'label', data: 'x', system: 0, attributes: U(0o100644) | 8 },
      { name: 'labelled/', system: 11, attributes: 0x18 },
      { name: 'labelled/in', data: 'x', system: 0, attributes: 0 },
      { name: 'unix-label-bit', data: 'x', system: 3, attributes: U(0o100600) | 8 },
      { name: 'controlled', data: 'x', system: 0, attributes: U(0o100664), internal: 4 },
    ]))
    assert.deepEqual(out, {
      dirs: ['dos-dir', 'late', 'x;1'],
      files: { plain: '644', readonly: '444', pkzip: '664', 'pkzip-ro': '400', 'exec-by-dos': '644', ntfs: '644', later: '444', 'dos-dir/in': '644', unix: '600', 'unix-untyped': '640', 'unix-sgid': '755', beos: '664', 'qdos-link': '777', 'late/f': '644', 'x;1/a;1b': '644', '__MACOSX/._plain': '644', pk45: '644', 'labelled/in': '644', 'unix-label-bit': '600', controlled: '644' },
      links: {},
    })
  })

  it('refuses what unzip asks about or writes otherwise than it is read here, and what CocoaPods would fail on', async () => {
    const asi = Buffer.concat([Buffer.from([0x6e, 0x75, 14, 0]), Buffer.alloc(14)])
    for (const [entries, message] of [
      [[], /an empty archive, which unzip warns of, and CocoaPods fails on the warning/u],
      [[{ name: 'a', data: '', version: 46 }], /"a": needs PKZIP 4\.6 to extract, past the 4\.5 an unzip built without bzip2 takes/u],
      [[{ name: 'a', data: '', version: 20 | (2 << 8) }], /marked as stored in VMS format, which unzip asks before extracting/u],
      [[{ name: 'a', data: '', system: 1 }], /made on Amiga or THEOS, whose attributes unzip reads by that system/u],
      [[{ name: 'a', data: '', system: 18 }], /made on Amiga or THEOS/u],
      [[{ name: 'a', data: '', system: 3, attributes: 0, extra: asi }], /attributes with no mode, and an extra field unzip reads one from/u],
      [[{ name: 'a', data: '', system: 3, attributes: 0 }], /a file of mode 0, which its owner cannot read/u],
      [[{ name: 'a', data: '', system: 3, attributes: U(0o100200) }], /a file of mode 200, which its owner cannot read/u],
      [[{ name: 'a', data: '', system: 3, attributes: U(0o100644), internal: 4 }], /a file of mode 0, which its owner cannot read/u],
      [[{ name: 'a', data: '', system: 0, attributes: 8, version: 46 }], /needs PKZIP 4\.6/u],
      [[{ name: 'a', data: 'x' }, { name: 'a', data: 'x', system: 0, attributes: 8 }, { name: 'a', data: 'x' }], /"a": a name again/u],
      [[{ name: 'l', data: 'a', system: 0, attributes: U(0o120600) }, { name: 'a', data: '' }], /"l": a symlink by the attributes of a maker that is not Unix, which unzip makes a link of/u],
      [[{ name: 'l', data: 'a', system: 16, attributes: U(0o120777) }, { name: 'a', data: '' }], /a symlink by the attributes of a maker that is not Unix/u],
      [[{ name: 'a', data: 'x' }, { name: 'a', data: 'x' }], /"a": a name again, which unzip asks whether to replace/u],
      [[{ name: 'a', data: 'x' }, { name: './a', data: 'x' }], /"\.\/a": a name again/u],
      [[{ name: 'l', data: 'a', attributes: U(0o120777) }, { name: 'l', data: 'a', attributes: U(0o120777) }, { name: 'a', data: '' }], /a name again/u],
      [[{ name: 'ü', data: '', flags: 0x800 }], /a name with a character outside ASCII, which unzip writes by the machine's locale and its own build/u],
      [[{ name: 'x/.', data: '' }], /a name ending in a `\.` segment, which unzip writes as `_`/u],
      [[{ name: 'x;1', data: '' }], /a name ending in `;` and digits, which unzip takes for a VMS version and drops/u],
      [[{ name: 'x;', data: '' }], /a name ending in `;` and digits/u],
      [[{ name: 'l;12', data: 'a', attributes: U(0o120777) }, { name: 'a', data: '' }], /a name ending in `;` and digits/u],
      [[{ name: 'd/', attributes: U(0o040555) | 0x10 }, { name: 'd/a', data: '' }], /"d\/": a directory of mode 555, which its owner cannot list and write in/u],
      [[{ name: 'd/', system: 0, attributes: 0x11 }], /a directory of mode 555/u],
      [[{ name: 'x/.git/config', data: '' }], /a path with a \.git in it/u],
      [[{ name: 'file.zip', data: '' }], /the archive holds "file\.zip", the name RemoteFile downloads it under/u],
      [[{ name: 'x', data: 'y', attributes: U(0o120777) }], /the one thing in the archive is a link/u],
      [[{ name: 'a', data: '', extra: Buffer.from([0x75, 0x70, 1, 0, 1]) }], /its archive cannot be read: .*Unicode path extra field/u],
    ]) await assert.rejects(unzipped(rawZip(entries), { ...zipSource, flatten: true }), (error) => error.name === 'PodError' && message.test(error.message), JSON.stringify(entries))
  })
})

describe('layoutPods', () => {
  const COMMIT = 'c'.repeat(40)
  const dirs = []
  after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })
  // Acme from GitHub by a commit, as GitHub serves the tarball of its tree; `history` is the commits its default
  // branch has. Returns what is written of it, by path and mode, and what GitHub was asked.
  async function layout(history = [COMMIT]) {
    const top = 'acme-acme-ccccccc'
    const tarball = await compress(pack([
      { name: `${top}/`, type: 'directory', mode: 0o755 },
      { name: `${top}/Acme.h`, data: Buffer.from('int acme;\n'), mode: 0o644 },
      { name: `${top}/run.sh`, data: Buffer.from('#!/bin/sh\n'), mode: 0o755 },
      { name: `${top}/unused.txt`, data: Buffer.from('x\n'), mode: 0o644 },
    ]), 'gzip')
    const asked = []
    const github = {
      getRepo: ({ repo }) => Promise.resolve({ full_name: repo, default_branch: 'main' }),
      compareCommits: ({ base }) => Promise.resolve({ status: history.includes(base) ? 'ahead' : 'diverged' }),
      getCommitTree: ({ sha }) => asked.push(`tree of ${sha}`) && Promise.resolve('d'.repeat(40)),
      getRepoTreeTarball: ({ tree }) => asked.push(`tarball of ${tree}`) && Promise.resolve(tarball),
    }
    const podspec = Buffer.from(JSON.stringify({ name: 'Acme', version: '1.0.0', source: { git: 'https://github.com/acme/acme.git', commit: COMMIT }, source_files: '*.h', preserve_paths: 'run.sh' }))
    const root = mkdtempSync(join(tmpdir(), 'pod-sources-test-'))
    dirs.push(root)
    const sandbox = join(root, 'Pods')
    const pod = { name: 'Acme', version: '1.0.0', checksum: '0'.repeat(40), specs: ['Acme'], dir: join(sandbox, 'Acme'), local: false, external: false, repo: 'trunk', checkout: false, podspec }
    const downloaded = await layoutPods({ sandbox, cocoapods: '1.16.2', platforms: ['ios'], pods: [pod] }, github, () => assert.fail('no prepare_command'))
    const files = Object.fromEntries(readdirSync(join(sandbox, 'Acme')).map((name) => [name, (lstatSync(join(sandbox, 'Acme', name)).mode & 0o777).toString(8)]))
    return { downloaded, files, asked }
  }

  it('checks a pod out of GitHub by its commit, and keeps of it what CocoaPods keeps', async () => {
    const { downloaded, files, asked } = await layout()
    assert.deepEqual(downloaded, ['Acme'])
    assert.deepEqual(files, { 'Acme.h': '444', 'run.sh': '755' })
    assert.deepEqual(asked, [`tree of ${COMMIT}`, `tarball of ${'d'.repeat(40)}`])
  })

  it('refuses a commit the default branch does not have', async () => {
    await assert.rejects(layout([]), (error) => error.name === 'PodError' && /pods\["Acme"\]: c{40} is not in the history of the repository's default branch/u.test(error.message))
  })
})
