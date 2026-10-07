import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { compress } from '@preventive/archive/compression.js'
import { Vfs } from '@preventive/vfs'
import { DeptreeError } from '../src/error.js'
import { writeFiles, writeLink } from '../src/mount.js'
import { fetchTarball, ownTarball, tarballUrl, withDirs } from '../src/tarball.js'
import { sri, stubRegistry, tarball } from './registry.js'

// What each builder holds a tarball's names and a package's place to before
// it writes, held to again where it writes: none of these is reached through
// a builder, whose own checks refuse each first.

const encoder = new TextEncoder()
const file = (text) => ({ data: encoder.encode(text), mode: 0o644 })
const refused = (run, message) => assert.throws(run, (error) => error instanceof DeptreeError && error.message === message)

// As a builder writes a package: the directories its files are in, unless
// `dirs` names others.
function write(root, paths, { vfs = new Vfs(), dirs } = {}) {
  const files = new Map(paths.map((path) => [path, file(path)]))
  writeFiles(vfs, root, dirs === undefined ? withDirs(files, 'w') : { files, dirs: new Set(dirs) }, { files: 0, bytes: 0 })
  return vfs
}

describe('a package\'s files', () => {
  it('within its directory', () => {
    for (const path of ['../x', 'a/../../x', './x', 'a//x', '', 'a/.', '..']) {
      const message = `${JSON.stringify(`node_modules/a/${path}`)}: is not a path within the package`
      refused(() => write('node_modules/a', [path], { dirs: [] }), message)
      refused(() => write('node_modules/a', ['x'], { dirs: [path] }), message)
    }
    for (const root of ['../x', 'node_modules/../../x', '', 'node_modules/./a']) refused(() => write(root, ['x']), `${JSON.stringify(root)}: is not a place within the tree`)
    const vfs = new Vfs()
    refused(() => write('node_modules/a', [], { vfs, dirs: ['../../src/x'] }), '"node_modules/a/../../src/x": is not a path within the package')
    assert.deepEqual(vfs.readdir('/'), ['node_modules'])
    assert.equal(write('node_modules/a', ['x', 'lib/..x', '.npmrc']).readText('/node_modules/a/lib/..x'), 'lib/..x')
  })

  it('made and written where it spells, through no link, and over none', () => {
    const vfs = new Vfs()
    vfs.mkdir('/elsewhere')
    vfs.mkdir('/node_modules')
    vfs.symlink('../elsewhere', '/node_modules/a')
    refused(() => write('node_modules/a', ['x'], { vfs }), '"node_modules/a": would be written through a link')
    vfs.mkdir('/node_modules/b/lib', { recursive: true })
    vfs.symlink('../../../elsewhere/y', '/node_modules/b/lib/x')
    refused(() => write('node_modules/b', ['lib/x'], { vfs }), '"node_modules/b/lib/x": would be written through a link')
    vfs.symlink('../../elsewhere', '/node_modules/b/sub')
    refused(() => write('node_modules/b', [], { vfs, dirs: ['sub/deeper'] }), '"node_modules/b/sub": would be written through a link')
    assert.deepEqual(vfs.readdir('/elsewhere'), [])
  })

  it('refused where it cannot be made', () => {
    const vfs = new Vfs()
    vfs.writeFile('/node_modules', '')
    refused(() => write('node_modules/a', ['x'], { vfs }), '"node_modules": cannot be made: /node_modules: File exists')
    assert.throws(() => write('node_modules/a', ['x'], { dirs: ['y'.repeat(300)] }), (error) => error instanceof DeptreeError && error.message.endsWith(': File name too long'))
  })
})

describe('a link', () => {
  it('at a place within the tree, under directories it spells', () => {
    for (const path of ['../x', 'node_modules/../../x', '', '/node_modules/a']) refused(() => writeLink(new Vfs(), path, 'x'), `${JSON.stringify(path)}: is not a place within the tree`)
    const vfs = new Vfs()
    vfs.mkdir('/elsewhere')
    vfs.symlink('elsewhere', '/node_modules')
    refused(() => writeLink(vfs, 'node_modules/a', '../w'), '"node_modules": would be written through a link')
    assert.deepEqual(vfs.readdir('/elsewhere'), [])
    assert.throws(() => writeLink(new Vfs(), `node_modules/${'y'.repeat(300)}`, 'x'), (error) => error instanceof DeptreeError && error.message.endsWith(': File name too long'))
    const made = new Vfs()
    writeLink(made, 'node_modules/@s/a', '../../w')
    assert.equal(made.readlink('/node_modules/@s/a'), '../../w')
  })
})

describe('the registry\'s tarball', () => {
  const I = `sha512-${'A'.repeat(86)}==`

  it('of a name and a version its URL holds as they are', () => {
    for (const [name, version] of [['../x', '1.0.0'], ['a/b/c', '1.0.0'], ['@s/..', '1.0.0'], ['.a', '1.0.0'], ['a%2f..', '1.0.0'], ['a', '1.0.0/../../x'], ['a', '1.0.0?x'], ['a', '1.0.0#x'], ['a', ''], ['kKoa', '1.0.0']]) {
      refused(() => ownTarball(tarballUrl(name, version), name, version, I, 'w'), `w: ${JSON.stringify(`${name}@${version}`)} is no package the registry's URL names as it is`)
    }
    assert.deepEqual(ownTarball(tarballUrl('@s/a', '1.0.0-rc.1+b'), '@s/a', '1.0.0-rc.1+b', I, 'w'), { name: '@s/a', version: '1.0.0-rc.1+b', integrity: I })
  })

  it('fetched by its name and version as such, and its sha512 alone, before anything is fetched', async () => {
    const calls = stubRegistry([])
    await assert.rejects(fetchTarball('../x', '1.0.0', I, 'w', {}), /^DeptreeError: w: "\.\.\/x@1\.0\.0" is no package the registry's URL names as it is$/u)
    for (const integrity of ['sha1-2jmj7l5rSw0yVb/vlWAYkK/YBwk=', `${I} sha1-2jmj7l5rSw0yVb/vlWAYkK/YBwk=`, `sha512-${'A'.repeat(85)}==`]) {
      await assert.rejects(fetchTarball('a', '1.0.0', integrity, 'w', {}), /^DeptreeError: w: a tarball with no sha512 integrity is not supported$/u)
    }
    assert.deepEqual(calls, [])
  })

  it('unpacked past zeros after its gzip stream, as Node\'s zlib stops there, and past nothing else', async () => {
    const { bytes } = await tarball('a', '1.0.0', { 'index.js': 'x' })
    // Its last bytes, the high ones of its output's length, are zeros too.
    assert.equal(bytes.at(-1), 0)
    const served = (tail, head = bytes) => {
      const padded = new Uint8Array([...head, ...tail])
      stubRegistry([{ name: 'a', version: '1.0.0', bytes: padded }])
      return fetchTarball('a', '1.0.0', sri(padded), 'w', {})
    }
    const { entries } = await served([])
    assert.deepEqual((await served(new Uint8Array(10240 - bytes.length))).entries, entries)
    assert.deepEqual((await served([0])).entries, entries)
    // An empty last member, as zlib writes one, ends nine bytes past its last that is not zero.
    const empty = await compress(new Uint8Array(), 'gzip')
    assert.deepEqual([...empty.subarray(-10)], [3, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    assert.deepEqual((await served([...empty, 0])).entries, entries)
    for (const tail of [[0, 1, 0], [1, 0, 0], [1], [0x1f, 0x8b, 0], [0, ...bytes, 0]]) await assert.rejects(served(tail), /^CompressionError: the data does not decompress$/u)
    // Its CRC, wrong.
    const corrupt = bytes.slice()
    corrupt[bytes.length - 8] ^= 1
    await assert.rejects(served([0, 0], corrupt), /^CompressionError: the data does not decompress$/u)
  })
})
