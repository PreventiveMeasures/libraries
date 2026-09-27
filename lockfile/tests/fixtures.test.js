import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { parsePnpmLockfile } from '../pnpm.js'

// The baseline: real lockfiles, written by pnpm 9, 10, 11 and 12 from one
// workspace that pulls in every kind of dependency a v9 lockfile records;
// by pnpm 11 and 12 once more with a config dependency, and under pnpm 12
// the package manager pinned, which lead the file with an env document;
// and by pnpm 12 for a bare project given a config dependency and nothing
// installed, which leaves the env document alone. scripts/record-pnpm.js
// builds them; its header says what is in them.

const FIXTURES = new URL('fixtures/', import.meta.url)
const read = (name) => parsePnpmLockfile(readFileSync(new URL(`${name}.yaml`, FIXTURES), 'utf8'))
const VERSIONS = ['pnpm-9', 'pnpm-10', 'pnpm-11', 'pnpm-11-config', 'pnpm-12', 'pnpm-12-env']

// Records come back with a null prototype, which strict deepEqual holds
// against a literal; structuredClone gives them Object.prototype back and
// changes nothing else.
const plain = (value) => structuredClone(value)

// A package by name and version, whatever its key, for comparing lockfiles
// whose keys differ.
const byName = (lock, name, version) => Object.values(lock.packages).filter((pkg) => pkg.name === name && pkg.version === version)

describe('every version reads to the same workspace', () => {
  const files = Object.fromEntries(VERSIONS.map((name) => [name, read(name)]))
  const locks = Object.fromEntries(VERSIONS.map((name) => [name, files[name].lockfile]))

  it('the same packages, by name and version', () => {
    const list = (lock) => Object.values(lock.packages).map((pkg) => `${pkg.name}@${pkg.version ?? pkg.resolution.directory}`).sort()
    const expected = list(locks['pnpm-10'])
    assert.equal(expected.length, 25)
    for (const name of VERSIONS) assert.deepEqual(list(locks[name]), expected, name)
  })

  it('the same importers, asking for the same things', () => {
    for (const name of VERSIONS) {
      assert.deepEqual(Object.keys(locks[name].importers), ['.', 'packages/ws-a', 'packages/ws-b'], name)
      for (const id of ['.', 'packages/ws-a', 'packages/ws-b']) {
        assert.deepEqual(plain(locks[name].importers[id].specifiers), plain(locks['pnpm-10'].importers[id].specifiers), `${name} ${id}`)
      }
    }
  })

  it('the patch under the hash each version computes, in the shape each writes', () => {
    assert.deepEqual(plain(locks['pnpm-9'].patchedDependencies), { 'is-number@7.0.0': { hash: 'zrvjrhdgfsy5o3tngjlyoyyjce', path: 'patches/is-number@7.0.0.patch' } })
    const hash = '25beca4d543c6a7ba195f72529648450abd9451553893a0dfa5a5fda314bf342'
    assert.deepEqual(plain(locks['pnpm-10'].patchedDependencies), { 'is-number@7.0.0': { hash, path: 'patches/is-number@7.0.0.patch' } })
    for (const name of ['pnpm-11', 'pnpm-11-config', 'pnpm-12', 'pnpm-12-env']) {
      assert.deepEqual(plain(locks[name].patchedDependencies), { 'is-number@7.0.0': { hash, path: undefined } }, name)
    }
    for (const name of VERSIONS) {
      const lock = locks[name]
      const [patched] = byName(lock, 'is-number', '7.0.0')
      assert.equal(patched.patchHash, lock.patchedDependencies['is-number@7.0.0'].hash, name)
      assert.equal(byName(lock, 'is-number', '6.0.0')[0].patchHash, undefined, name)
    }
  })

  it('an env document leads only where there is something to lock beside the project', () => {
    for (const name of ['pnpm-9', 'pnpm-10', 'pnpm-11', 'pnpm-12']) assert.equal(files[name].env, undefined, name)
    for (const name of ['pnpm-11-config', 'pnpm-12-env']) assert.notEqual(files[name].env, undefined, name)
  })

  it('and leaves the project\'s lockfile as it would be without', () => {
    assert.deepEqual(plain(locks['pnpm-11-config']), plain(locks['pnpm-11']))
    assert.deepEqual(plain(locks['pnpm-12-env']), plain(locks['pnpm-12']))
  })
})

describe('a pnpm 10 lockfile, spot-checked', () => {
  const lock = read('pnpm-10').lockfile
  const root = lock.importers['.']

  it('records have no prototype', () => {
    for (const record of [lock.importers, lock.packages, root.specifiers, root.dependencies, lock.catalogs, lock.overrides, lock.settings]) {
      assert.equal(Object.getPrototypeOf(record), null)
    }
  })

  it('the header', () => {
    assert.equal(lock.lockfileVersion, '9.0')
    assert.deepEqual(plain(lock.settings), { autoInstallPeers: true, excludeLinksFromLockfile: false })
    assert.deepEqual(plain(lock.catalogs), {
      default: { react: { specifier: '18.2.0', version: '18.2.0' } },
      legacy: { 'is-number': { specifier: '6.0.0', version: '6.0.0' } },
    })
    assert.deepEqual(plain(lock.overrides), { 'loose-envify': '1.4.0' })
  })

  it('an importer: specifiers, then a target for each alias under its kind', () => {
    assert.equal(root.specifiers['my-q'], 'npm:q@1.5.1')
    assert.equal(root.specifiers.react, 'catalog:')
    assert.deepEqual(plain(root.devDependencies), { mkdirp: 'mkdirp@1.0.4' })
    assert.deepEqual(plain(root.optionalDependencies), { '@img/sharp-linux-x64': '@img/sharp-linux-x64@0.33.5', fsevents: 'fsevents@2.3.3' })
    assert.deepEqual(plain(root.dependenciesMeta), { 'ws-a': { injected: true } })
    assert.equal(root.publishDirectory, undefined)
    assert.equal(root.linkDirectory, true)
    assert.deepEqual(Object.keys(root.specifiers).sort(), [...Object.keys(root.dependencies), ...Object.keys(root.devDependencies), ...Object.keys(root.optionalDependencies)].sort())
  })

  it('an alias leads to the package it names, a version to its own', () => {
    assert.equal(root.dependencies['my-q'], 'q@1.5.1')
    assert.equal(root.dependencies['is-odd'], 'is-odd@3.0.1')
    assert.equal(lock.packages['q@1.5.1'].name, 'q')
  })

  it('peers are in the key, nested, and among the dependencies', () => {
    const key = 'react-transition-group@4.4.5(react-dom@18.2.0(react@18.2.0))(react@18.2.0)'
    assert.equal(root.dependencies['react-transition-group'], key)
    const pkg = lock.packages[key]
    assert.equal(pkg.version, '4.4.5')
    assert.equal(pkg.dependencies['react-dom'], 'react-dom@18.2.0(react@18.2.0)')
    assert.equal(pkg.dependencies.react, 'react@18.2.0')
    assert.deepEqual(plain(pkg.peerDependencies), { react: '>=16.6.0', 'react-dom': '>=16.6.0' })
  })

  it('links come back from the lockfile\'s directory, whoever wrote them', () => {
    assert.equal(root.dependencies.linked, 'link:linked')
    assert.equal(root.dependencies['ws-b'], 'link:packages/ws-b')
    // Written `link:../ws-b` under packages/ws-a.
    assert.equal(lock.importers['packages/ws-a'].dependencies['ws-b'], 'link:packages/ws-b')
    // Written `link:packages/ws-b` in the injected copy's snapshot.
    assert.equal(lock.packages['ws-a@file:packages/ws-a(react@18.2.0)'].dependencies['ws-b'], 'link:packages/ws-b')
  })

  it('a registry package: its version from the key, no tarball URL', () => {
    const pkg = lock.packages['is-odd@3.0.1']
    assert.equal(pkg.name, 'is-odd')
    assert.equal(pkg.version, '3.0.1')
    assert.deepEqual(pkg.resolution, {
      type: 'tarball',
      integrity: 'sha512-CQpnWPrDwmP1+SMHXZhtLtJv90yiyVfluGsX5iNCVkrhQtU3TQHsUWPG9wkdk9Lgd5yNpAg9jQEo90CBaXgWMA==',
      tarball: undefined,
      path: undefined,
      gitHosted: false,
    })
    assert.deepEqual(plain(pkg.dependencies), { 'is-number': 'is-number@6.0.0' })
    assert.deepEqual(plain(pkg.engines), { node: '>=4' })
  })

  it('a local tarball and a local directory', () => {
    const tgz = lock.packages['local-tgz@file:vendor/local-tgz-1.0.0.tgz']
    assert.equal(tgz.version, '1.0.0')
    assert.equal(tgz.resolution.type, 'tarball')
    assert.equal(tgz.resolution.tarball, 'file:vendor/local-tgz-1.0.0.tgz')
    assert.match(tgz.resolution.integrity, /^sha512-/u)
    const dir = lock.packages['local-dir@file:local-dir']
    assert.equal(dir.version, undefined)
    assert.deepEqual(dir.resolution, { type: 'directory', directory: 'local-dir' })
  })

  it('an injected workspace package is a directory, with its peers', () => {
    const key = 'ws-a@file:packages/ws-a(react@18.2.0)'
    assert.equal(root.dependencies['ws-a'], key)
    assert.deepEqual(lock.packages[key].resolution, { type: 'directory', directory: 'packages/ws-a' })
    assert.equal(lock.packages[key].dependencies.react, 'react@18.2.0')
    // The project itself resolves its own peer range to the newest.
    assert.equal(lock.importers['packages/ws-a'].dependencies.react, 'react@18.3.1')
  })

  it('a git dependency: its version in a field, the commit in its resolution', () => {
    const key = root.dependencies.isarray
    assert.equal(key, 'isarray@git+ssh://git@github.com/juliangruber/isarray.git#63ea4ca0a0d6b0574d6a470ebd26880c3026db4a')
    assert.equal(lock.packages[key].version, '2.0.5')
    assert.deepEqual(lock.packages[key].resolution, {
      type: 'git',
      repo: 'git@github.com:juliangruber/isarray.git',
      commit: '63ea4ca0a0d6b0574d6a470ebd26880c3026db4a',
      path: undefined,
    })
  })

  it('optional packages and their platforms', () => {
    const sharp = lock.packages['@img/sharp-linux-x64@0.33.5']
    assert.equal(sharp.optional, true)
    assert.deepEqual([sharp.os, sharp.cpu, sharp.libc], [['linux'], ['x64'], ['glibc']])
    assert.deepEqual(plain(sharp.optionalDependencies), { '@img/sharp-libvips-linux-x64': '@img/sharp-libvips-linux-x64@1.0.4' })
    assert.equal(lock.packages['@img/sharp-libvips-linux-x64@1.0.4'].optional, true)
    assert.deepEqual(lock.packages['fsevents@2.3.3'].os, ['darwin'])
    assert.equal(lock.packages['fsevents@2.3.3'].cpu, undefined)
    assert.equal(lock.packages['is-odd@3.0.1'].optional, false)
  })

  it('what the manifest says, as pnpm records it', () => {
    assert.equal(lock.packages['loose-envify@1.4.0'].hasBin, true)
    assert.equal(lock.packages['react@18.2.0'].hasBin, false)
    assert.match(lock.packages['q@1.5.1'].deprecated, /^You or someone .* each other\.\n\n\(For a CapTP .*captp\)$/u)
    assert.equal(lock.packages['react@18.2.0'].deprecated, undefined)
    assert.equal(lock.packages['react@18.2.0'].bundledDependencies, undefined)
    assert.deepEqual(lock.packages['react@18.2.0'].transitivePeerDependencies, [])
  })

  it('every target is a package in it or a link', () => {
    const targets = [
      ...Object.values(lock.importers).flatMap((importer) => [importer.dependencies, importer.devDependencies, importer.optionalDependencies]),
      ...Object.values(lock.packages).flatMap((pkg) => [pkg.dependencies, pkg.optionalDependencies]),
    ].flatMap((map) => Object.values(map))
    assert.ok(targets.length > 40)
    for (const target of targets) assert.ok(target.startsWith('link:') || target in lock.packages, target)
  })
})

describe('the pnpm 11 and 12 spellings', () => {
  it('a git dependency over https', () => {
    for (const name of ['pnpm-11', 'pnpm-12']) {
      const lock = read(name).lockfile
      const key = lock.importers['.'].dependencies.isarray
      assert.equal(key, 'isarray@git+https://github.com/juliangruber/isarray.git#63ea4ca0a0d6b0574d6a470ebd26880c3026db4a', name)
      assert.equal(lock.packages[key].resolution.repo, 'https://github.com/juliangruber/isarray.git', name)
    }
  })
})

describe('the env document', () => {
  it('pnpm 11 locks config dependencies in it', () => {
    const { env } = read('pnpm-11-config')
    assert.deepEqual(plain(env.importers), {
      '.': { specifiers: { 'is-number': '7.0.0' }, configDependencies: { 'is-number': 'is-number@7.0.0' }, packageManagerDependencies: {} },
    })
    assert.deepEqual(Object.keys(env.packages), ['is-number@7.0.0'])
    const [project] = byName(read('pnpm-11').lockfile, 'is-number', '7.0.0')
    assert.equal(env.packages['is-number@7.0.0'].resolution.integrity, project.resolution.integrity)
  })

  it('pnpm 12 locks the package manager a project pins in it too', () => {
    const { env } = read('pnpm-12-env')
    assert.equal(env.lockfileVersion, '9.0')
    assert.deepEqual(plain(env.importers['.']), {
      specifiers: { 'is-number': '7.0.0', pnpm: '12.6.0' },
      configDependencies: { 'is-number': 'is-number@7.0.0' },
      packageManagerDependencies: { pnpm: 'pnpm@12.6.0' },
    })
  })

  it('locks the package manager and its bindings like any package', () => {
    const { env } = read('pnpm-12-env')
    assert.equal(Object.keys(env.packages).length, 16)
    const pnpm = env.packages['pnpm@12.6.0']
    assert.equal(pnpm.version, '12.6.0')
    assert.equal(Object.keys(pnpm.optionalDependencies).length, 14)
    const linux = env.packages[pnpm.optionalDependencies['@pnpm/exe.linux-x64']]
    assert.deepEqual([linux.name, linux.os, linux.cpu, linux.libc, linux.optional], ['@pnpm/exe.linux-x64', ['linux'], ['x64'], ['glibc'], true])
  })

  it('alone, before anything is installed, is no lockfile for the project', () => {
    const { lockfile, env } = read('pnpm-12-env-only')
    assert.equal(lockfile, undefined)
    assert.deepEqual(plain(env.importers['.'].configDependencies), { 'is-number': 'is-number@7.0.0' })
    const [project] = byName(read('pnpm-12').lockfile, 'is-number', '7.0.0')
    assert.equal(env.packages['is-number@7.0.0'].resolution.integrity, project.resolution.integrity)
  })
})
