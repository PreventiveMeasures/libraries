import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Vfs } from '@preventive/vfs'
import { DeptreeError } from '../src/error.js'
import { writeFiles, writeLink } from '../src/mount.js'
import { fetchTarball, ownTarball, tarballUrl, withDirs } from '../src/tarball.js'
import { stubRegistry } from './registry.js'

// What each builder holds a tarball's names and a package's place to before
// it writes, held to again where it writes: none of these is reached through
// a builder, whose own checks refuse each first.

const encoder = new TextEncoder()
const file = (text) => ({ data: encoder.encode(text), mode: 0o644 })
const refused = (run, message) => assert.throws(run, (error) => error instanceof DeptreeError && error.message === message)

// As a builder writes a package: its directory made first, then the
// directories its files are in.
function write(root, paths, vfs = new Vfs()) {
  if (root !== '') vfs.mkdir(`/${root}`, { recursive: true })
  writeFiles(vfs, root, withDirs(new Map(paths.map((path) => [path, file(path)])), 'w'), { files: 0, bytes: 0 })
  return vfs
}

describe('a package\'s files', () => {
  it('within its directory', () => {
    for (const path of ['../x', 'a/../../x', './x', 'a//x', '', 'a/.', '..']) refused(() => write('node_modules/a', [path]), `${JSON.stringify(`node_modules/a/${path}`)}: is not a path within the package`)
    for (const root of ['../x', 'node_modules/../../x', '', 'node_modules/./a']) refused(() => write(root, ['x']), `${JSON.stringify(`${root}/x`)}: is not a path within the package`)
    assert.equal(write('node_modules/a', ['x', 'lib/..x', '.npmrc']).readText('/node_modules/a/lib/..x'), 'lib/..x')
  })

  it('written to the directory it spells, through no link, and over none', () => {
    const vfs = new Vfs()
    vfs.mkdir('/elsewhere')
    vfs.mkdir('/node_modules')
    vfs.symlink('../elsewhere', '/node_modules/a')
    refused(() => write('node_modules/a', ['x'], vfs), '"node_modules/a/x": would be written through a link')
    vfs.mkdir('/node_modules/b/lib', { recursive: true })
    vfs.symlink('../../../elsewhere/y', '/node_modules/b/lib/x')
    refused(() => write('node_modules/b', ['lib/x'], vfs), '"node_modules/b/lib/x": would be written through a link')
    assert.deepEqual(vfs.readdir('/elsewhere'), [])
  })
})

describe('a link', () => {
  it('at a place within the tree, under directories it spells', () => {
    for (const path of ['../x', 'node_modules/../../x', '', '/node_modules/a']) refused(() => writeLink(new Vfs(), path, 'x'), `${JSON.stringify(path)}: is not a place within the tree`)
    const vfs = new Vfs()
    vfs.mkdir('/elsewhere')
    vfs.symlink('elsewhere', '/node_modules')
    refused(() => writeLink(vfs, 'node_modules/a', '../w'), '"node_modules/a": would be linked through a link')
    assert.deepEqual(vfs.readdir('/elsewhere'), [])
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
    await assert.rejects(fetchTarball('../x', '1.0.0', I, 'w'), /^DeptreeError: w: "\.\.\/x@1\.0\.0" is no package the registry's URL names as it is$/u)
    for (const integrity of ['sha1-2jmj7l5rSw0yVb/vlWAYkK/YBwk=', `${I} sha1-2jmj7l5rSw0yVb/vlWAYkK/YBwk=`, undefined, `sha512-${'A'.repeat(85)}==`]) {
      await assert.rejects(fetchTarball('a', '1.0.0', integrity, 'w'), /^DeptreeError: w: a tarball with no sha512 integrity is not supported$/u)
    }
    assert.deepEqual(calls, [])
  })
})
