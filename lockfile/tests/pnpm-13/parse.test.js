import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import { LockfileError, YamlError, parsePnpmLockfile } from '../../pnpm.js'

// A small lockfile of 13.0: a package of two sets of peers, `t`, one in
// each of two projects, beside a package of none and a patched one; then
// one edit at a time, each read as pnpm 12.20 and later read it, or
// refused with a message that says where and why.

const I = 'sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg=='
const P = '25beca4d543c6a7ba195f72529648450abd9451553893a0dfa5a5fda314bf342'

const base = () => ({
  lockfileVersion: '13.0',
  settings: { autoInstallPeers: true, catalogs: { default: { r: '18.0.0' } }, patchedDependencies: { 'd@1.0.0': P } },
  projects: {
    '.': {},
    'p/a': { dependencies: { d: '1.0.0', r: '17.0.0', t: '1.0.0' } },
    'p/b': { dependencies: { r: 'catalog:', t: { specifier: '^1.0.0', version: '1.0.0' } } },
  },
  packages: {
    'd@1.0.0': { integrity: I },
    'r@17.0.0': { integrity: I },
    'r@18.0.0': { integrity: I },
    't@1.0.0': {
      integrity: I,
      peerDependencies: { r: '*' },
      dependencies: { d: '1.0.0' },
      snapshots: [{ peerDependencies: { r: { version: '17.0.0' } } }, { peerDependencies: { r: { version: '18.0.0' } } }],
    },
  },
})

const write = (doc) => `${JSON.stringify(doc, null, '\t')}\n`
const read = (doc) => parsePnpmLockfile(write(doc)).lockfile
const edit = (change) => {
  const doc = base()
  change(doc)
  return doc
}
const plain = (value) => structuredClone(value)

function refuses(doc, message, where) {
  assert.throws(() => read(doc), (error) => {
    assert.ok(error instanceof LockfileError, error.stack)
    assert.equal(error.where, where)
    assert.equal(error.message, `${where}: ${message}`)
    return true
  })
}

describe('a lockfile of 13.0', () => {
  it('reads to the snapshots pnpm installs, keyed with their peers', () => {
    const lock = read(base())
    assert.equal(lock.lockfileVersion, '13.0')
    assert.deepEqual(Object.keys(lock.packages), [`d@1.0.0(patch_hash=${P})`, 'r@17.0.0', 'r@18.0.0', 't@1.0.0(r@17.0.0)', 't@1.0.0(r@18.0.0)'])
    assert.deepEqual(plain(lock.packages['t@1.0.0(r@17.0.0)'].dependencies), { d: `d@1.0.0(patch_hash=${P})`, r: 'r@17.0.0' })
    assert.deepEqual(plain(lock.importers['p/a'].dependencies), { d: `d@1.0.0(patch_hash=${P})`, r: 'r@17.0.0', t: 't@1.0.0(r@17.0.0)' })
    assert.deepEqual(plain(lock.importers['p/b'].dependencies), { r: 'r@18.0.0', t: 't@1.0.0(r@18.0.0)' })
    assert.deepEqual(plain(lock.importers['p/b'].specifiers), { r: 'catalog:', t: '^1.0.0' })
    assert.deepEqual(plain(lock.catalogs), { default: { r: { specifier: '18.0.0', version: '18.0.0' } } })
    assert.deepEqual(plain(lock.patchedDependencies), { 'd@1.0.0': { hash: P, path: undefined } })
    assert.equal(lock.packages['t@1.0.0(r@17.0.0)'].peerDependencies.r, '*')
    assert.equal(lock.packages['t@1.0.0(r@17.0.0)'].deprecated, undefined)
  })

  it('a snapshot named by its bindings, where the scope does not say', () => {
    const named = (doc) => (doc.projects['p/c'] = { dependencies: { t: { specifier: '1.0.0', with: { r: '18.0.0' } } } })
    assert.equal(read(edit(named)).importers['p/c'].dependencies.t, 't@1.0.0(r@18.0.0)')
    // With nothing in its scope, the first.
    assert.equal(read(edit((doc) => (doc.projects['p/c'] = { dependencies: { t: '1.0.0' } }))).importers['p/c'].dependencies.t, 't@1.0.0(r@17.0.0)')
    const below = edit((doc) => {
      doc.packages['u@1.0.0'] = { integrity: I, dependencies: { t: { version: '1.0.0', with: { r: '18.0.0' } } } }
      doc.projects['.'] = { dependencies: { u: '1.0.0' } }
    })
    assert.equal(read(below).packages['u@1.0.0'].dependencies.t, 't@1.0.0(r@18.0.0)')
  })

  it('the peers below that nothing binds, or as recorded', () => {
    const declared = edit((doc) => {
      doc.packages['u@1.0.0'] = { integrity: I, peerDependencies: { x: '*' } }
      doc.packages['v@1.0.0'] = { integrity: I, dependencies: { u: '1.0.0' } }
      doc.projects['.'] = { dependencies: { v: '1.0.0' } }
    })
    assert.deepEqual(read(declared).packages['v@1.0.0'].transitivePeerDependencies, ['x'])
    assert.deepEqual(read(declared).packages['u@1.0.0'].transitivePeerDependencies, [])
    declared.packages['v@1.0.0'].unboundPeerDependencies = ['y']
    assert.deepEqual(read(declared).packages['v@1.0.0'].transitivePeerDependencies, ['y'])
  })

  it('a peer bound below, passed down', () => {
    const lock = read(edit((doc) => {
      doc.packages['u@1.0.0'] = { integrity: I, dependencies: { t: '1.0.0' }, peerDependencies: { r: { version: '17.0.0', below: true } } }
      doc.projects['p/a'].dependencies.u = '1.0.0'
    }))
    assert.deepEqual(plain(lock.packages['u@1.0.0(r@17.0.0)']).transitivePeerDependencies, ['r'])
    assert.equal(lock.packages['u@1.0.0(r@17.0.0)'].dependencies.t, 't@1.0.0(r@17.0.0)')
  })

  it('peers past peersSuffixMaxLength as their hash, and under dedupePeers by name and version', () => {
    const hashed = read(edit((doc) => (doc.settings.peersSuffixMaxLength = 0)))
    const hash = (peers) => createHash('sha256').update(peers).digest('hex').slice(0, 32)
    assert.ok(`t@1.0.0(${hash('r@17.0.0')})` in hashed.packages)
    assert.ok(`t@1.0.0(${hash('r@18.0.0')})` in hashed.packages)
    const deduped = edit((doc) => {
      doc.settings.dedupePeers = true
      doc.packages['u@1.0.0'] = { integrity: I, peerDependencies: { t: { specifier: '*', version: '1.0.0' } } }
      doc.projects['p/a'].dependencies.u = '1.0.0'
    })
    assert.ok('u@1.0.0(t@1.0.0)' in read(deduped).packages)
  })
})

describe('a lockfile of 13.0 is held to what pnpm writes', () => {
  it('in JSON, as pnpm reads it', () => {
    const text = write(base())
    assert.throws(() => parsePnpmLockfile(text.replace('"settings"', '"lockfileVersion": "13.0",\n\t"settings"')), { name: 'YamlError', message: 'the key "lockfileVersion" twice in one mapping at line 3' })
    assert.throws(() => parsePnpmLockfile(text.replace('{\n', '{\n,')), { name: 'YamlError', message: 'expected a key in double quotes, found "," at line 2' })
    assert.throws(() => parsePnpmLockfile(text.replace('"autoInstallPeers": true', '"autoInstallPeers": "\\/"')), YamlError)
    assert.throws(() => parsePnpmLockfile(text.replace('"autoInstallPeers": true', '"autoInstallPeers": 1.0')), YamlError)
    assert.throws(() => parsePnpmLockfile(`${text}x`), { name: 'YamlError', message: `expected the end of the document, found "x" at line ${text.split('\n').length}` })
    // A comma after the last entry, as pnpm writes one.
    assert.deepEqual(plain(parsePnpmLockfile(text.replace('"autoInstallPeers": true,', '"autoInstallPeers": true,\n\t\t"dedupePeers": false,')).lockfile.settings), { autoInstallPeers: true, dedupePeers: false })
  })

  it('of 13.0 in JSON alone, and the env document in YAML', () => {
    assert.throws(() => parsePnpmLockfile("lockfileVersion: '13.0'\n"), { message: 'lockfileVersion: unsupported version: expected "9.0", found the string "13.0", as a lockfile of 13.0 is written in JSON' })
    refuses(edit((doc) => (doc.lockfileVersion = '9.0')), 'unsupported version: expected "13.0", found the string "9.0", as pnpm writes a lockfile in JSON of 13.0 alone', 'lockfileVersion')
    assert.throws(() => parsePnpmLockfile(`---\n${write(base())}---\n${write(base())}`), { message: 'expected the env document in YAML, as pnpm 12 writes it, found one in JSON, which pnpm writes from pnpm 14' })
  })

  it('a dependency whose version follows from its specifier as the specifier alone', () => {
    refuses(edit((doc) => (doc.projects['p/a'].dependencies.d = { specifier: '1.0.0', version: '1.0.0' })), 'expected the specifier alone, as pnpm writes a dependency whose version follows from it', 'projects["p/a"].dependencies.d')
    refuses(edit((doc) => (doc.projects['p/a'].dependencies.d = '^1.0.0')), '"^1.0.0" leads to "d@^1.0.0", which is not in snapshots', 'projects["p/a"].dependencies.d.version')
    refuses(edit((doc) => (doc.projects['p/a'].dependencies.d = 'catalog:other')), 'no version follows from "catalog:other"', 'projects["p/a"].dependencies.d')
    refuses(edit((doc) => (doc.settings.catalogs.default.r = { specifier: '18.0.0', version: '18.0.0' })), 'expected the specifier alone, as pnpm writes an entry whose version follows from it', 'settings.catalogs.default.r')
  })

  it('a project\'s name where a workspace: dependency links to it, and nowhere else', () => {
    const linked = (doc) => {
      doc.projects['p/a'].dependencies.w = { specifier: 'workspace:*', version: 'link:../b' }
    }
    refuses(edit(linked), 'expected the name "w", which a workspace: dependency links it by', 'projects["p/b"].name')
    const named = edit((doc) => {
      doc.projects['p/a'].dependencies.w = 'workspace:*'
      doc.projects['p/b'].name = 'w'
    })
    assert.equal(read(named).importers['p/a'].dependencies.w, 'link:p/b')
    refuses(edit((doc) => (doc.projects['p/b'].name = 'w')), 'no workspace: dependency links to it by this name', 'projects["p/b"].name')
  })

  it('references with no peers in them', () => {
    refuses(edit((doc) => (doc.packages['t@1.0.0'].dependencies.d = '1.0.0(x@1.0.0)')), '"1.0.0(x@1.0.0)" carries a peer or patch group, which no reference does in lockfileVersion 13.0', 'packages["t@1.0.0"].dependencies.d')
    refuses(edit((doc) => (doc.projects['p/a'].dependencies.t = { specifier: '1.0.0', version: '1.0.0(r@17.0.0)' })), '"1.0.0(r@17.0.0)" carries a peer or patch group, which no reference does in lockfileVersion 13.0', 'projects["p/a"].dependencies.t.version')
  })

  it('what every snapshot shares, once, on the package', () => {
    const t = (doc) => doc.packages['t@1.0.0']
    refuses(edit((doc) => (t(doc).snapshots = [t(doc).snapshots[0]])), 'expected more than one snapshot, as pnpm writes a package of one with none listed', 'packages["t@1.0.0"].snapshots')
    refuses(edit((doc) => (t(doc).snapshots[0].dependencies = { d: '1.0.0' })), '"d" is on the package already', 'packages["t@1.0.0"].snapshots[0].dependencies.d')
    refuses(edit((doc) => {
      delete t(doc).dependencies
      for (const snapshot of t(doc).snapshots) snapshot.dependencies = { d: '1.0.0' }
    }), 'every snapshot has "d" alike, which pnpm writes once, on the package', 'packages["t@1.0.0"].snapshots[0].dependencies')
    refuses(edit((doc) => {
      for (const snapshot of t(doc).snapshots) snapshot.optional = true
    }), 'every snapshot is optional, which pnpm writes once, on the package', 'packages["t@1.0.0"].snapshots')
  })

  it('a resolution as pnpm splits it', () => {
    const d = (doc) => doc.packages['d@1.0.0']
    refuses(edit((doc) => (doc.packages['d@1.0.0'] = { resolution: { integrity: I } })), 'expected the integrity alone, as pnpm writes a registry package\'s resolution', 'packages["d@1.0.0"].resolution')
    refuses(edit((doc) => (d(doc).resolution = { tarball: 'https://example.com/d.tgz', integrity: I })), 'expected the integrity beside the resolution, as pnpm writes it', 'packages["d@1.0.0"].resolution.integrity')
    refuses(edit((doc) => (doc.packages['d@1.0.0'] = {})), 'records no resolution, and its key is no directory\'s', 'packages["d@1.0.0"]')
    refuses(edit((doc) => (d(doc).deprecated = 'no')), 'pnpm writes no deprecation in lockfileVersion 13.0', 'packages["d@1.0.0"].deprecated')
  })

  it('a peer as its range alone where nothing more is said of it', () => {
    refuses(edit((doc) => (doc.packages['t@1.0.0'].peerDependencies.r = { specifier: '*' })), 'expected the range alone, as pnpm writes a peer it says nothing more of', 'packages["t@1.0.0"].peerDependencies.r')
    refuses(edit((doc) => (doc.packages['t@1.0.0'].snapshots[0].peerDependencies.r.below = false)), 'expected true, the only value pnpm writes', 'packages["t@1.0.0"].snapshots[0].peerDependencies.r.below')
  })

  it('refused where the v9 document it reads as is, at the entry of the package', () => {
    refuses(edit((doc) => (doc.packages['t@1.0.0'].dependencies.d = '2.0.0')), '"2.0.0" leads to "d@2.0.0", which is not in snapshots', 'packages["t@1.0.0"]')
    refuses(edit((doc) => (doc.settings.patchedDependencies['x@1.0.0'] = P)), 'patches no package in the lockfile, which pnpm refuses to install with', 'settings.patchedDependencies["x@1.0.0"]')
    refuses(edit((doc) => (doc.packages['x@1.0.0'] = { integrity: I })), 'no importer depends on it, directly or not', 'packages["x@1.0.0"]')
  })
})
