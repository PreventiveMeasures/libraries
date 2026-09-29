import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parsePnpmLockfile } from '@preventive/lockfile/pnpm.js'
import { createHook } from '../src/pnpm/hook.js'
import * as OVERRIDES from '../src/pnpm/overrides.js'
import { checkProjects } from '../src/pnpm/projects.js'
import { HOST } from './registry.js'

// A project against its importer, as `pnpm install --frozen-lockfile`
// holds it (satisfiesPackageManifest): one importer, `.`, of a registry
// package `q` and an alias `r` of it, checked against package.json edits.

const I = 'sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg=='

const LOCKFILE = parsePnpmLockfile(`lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      q:
        specifier: ^1.0.0
        version: 1.2.0
      r:
        specifier: npm:q@1.2.0
        version: q@1.2.0
    devDependencies:
      l:
        specifier: link:../l
        version: link:../l

packages:

  q@1.2.0:
    resolution: {integrity: ${I}}

snapshots:

  q@1.2.0: {}
`).lockfile

const MANIFEST = { dependencies: { q: '^1.0.0', r: 'npm:q@1.2.0' }, devDependencies: { l: 'link:../l' } }
const SETTINGS = { autoInstallPeers: true, engineStrict: false }
const check = (manifest, { lockfile = LOCKFILE, hook = createHook({ overrides: [], ignored: [] }), host = HOST, ...settings } = {}) => {
  checkProjects(lockfile, new Map([['.', manifest]]), { hook, host, settings: { ...SETTINGS, ...settings } })
}

describe('checkProjects', () => {
  it('takes a package.json that asks for what the importer records', () => {
    check(MANIFEST)
    check({ ...MANIFEST, peerDependencies: { q: '^1.0.0' } })
    check({ ...MANIFEST, peerDependencies: { z: '1' } }, { autoInstallPeers: false })
  })

  const refused = [
    ['a changed specifier', { ...MANIFEST, dependencies: { ...MANIFEST.dependencies, q: '^1.1.0' } }, /the specifiers differ: "q" is "\^1\.0\.0" in the lockfile and "\^1\.1\.0" in package\.json/u],
    ['a dependency of another kind', { dependencies: { q: '^1.0.0' }, devDependencies: { ...MANIFEST.devDependencies, r: 'npm:q@1.2.0' } }, /dependencies in the lockfile do not match/u],
    ['a peer listed nowhere else', { ...MANIFEST, peerDependencies: { z: '1' } }, /"z" is nothing in the lockfile and "1" in package\.json/u],
    ['a publish directory', { ...MANIFEST, publishConfig: { directory: 'dist' } }, /publishDirectory/u],
    ['dependenciesMeta', { ...MANIFEST, dependenciesMeta: { q: { injected: true } } }, /dependenciesMeta differs/u],
    ['a specifier that is not a string', { ...MANIFEST, dependencies: { ...MANIFEST.dependencies, q: 1 } }, /^DeptreeError: manifests\["\."\]\.dependencies: expected a mapping of names to specifiers$/u],
    ['dependencies that are not a mapping', { ...MANIFEST, dependencies: ['q'] }, /^DeptreeError: manifests\["\."\]\.dependencies: expected a mapping of names to specifiers$/u],
  ]
  for (const [what, manifest, pattern] of refused) {
    it(`refuses ${what}`, () => assert.throws(() => check(manifest), pattern))
  }

  // pnpm reads a project's package.json through its read-package hook
  // before holding it to its importer: an override of a direct dependency
  // is what the importer records.
  it('holds an overridden or ignored direct dependency to the importer as pnpm reads it', () => {
    const { listOverrides } = OVERRIDES
    const hook = createHook({ overrides: listOverrides({ q: '^1.0.0', z: '-' }, {}), ignored: ['o'] })
    check({ ...MANIFEST, dependencies: { ...MANIFEST.dependencies, q: '^1.1.0', z: '1' }, optionalDependencies: { o: '1' } }, { hook })
    assert.throws(() => check({ ...MANIFEST, dependencies: { ...MANIFEST.dependencies, z: '1' } }), /"z" is nothing in the lockfile and "1" in package\.json/u)
    const local = createHook({ overrides: listOverrides({ q: 'link:../q' }, {}), ignored: [] })
    assert.throws(() => check(MANIFEST, { hook: local }), /the override "q" is to a local path/u)
  })

  it('refuses a packageManager other than this pnpm, exactly', () => {
    check({ ...MANIFEST, packageManager: `pnpm@${HOST.pnpm}` })
    check({ ...MANIFEST, packageManager: `pnpm@${HOST.pnpm}+sha512.abc` })
    for (const packageManager of ['pnpm@10.0.0', 'pnpm@10', 'yarn@4.0.0', 'pnpm', 'pnpm@https://example.com/pnpm.tgz', 7]) {
      assert.throws(() => check({ ...MANIFEST, packageManager }), /^DeptreeError: manifests\["\."\]\.packageManager: /u, String(packageManager))
    }
  })

  // pnpm's packageIsInstallable for a project: a platform that does not
  // match only warns, and is found first, so the engines are not looked at.
  it('holds a project to its engines as pnpm does', () => {
    check({ ...MANIFEST, engines: { pnpm: '^10.0.0', node: '<10' } })
    assert.throws(() => check({ ...MANIFEST, engines: { pnpm: '>=11' } }), /its engines\.pnpm, ">=11", does not take pnpm 10\.33\.4, which pnpm refuses/u)
    assert.throws(() => check({ ...MANIFEST, engines: { node: '<10' } }, { engineStrict: true }), /its engines\.node, "<10", does not take Node 24\.15\.0, which engineStrict refuses/u)
    check({ ...MANIFEST, os: ['win32'], engines: { pnpm: '>=11' } })
    check({ ...MANIFEST, os: 'linux' })
  })

  it('refuses a runtime pnpm would download', () => {
    assert.throws(() => check({ ...MANIFEST, devEngines: { runtime: { name: 'node', version: '24.0.0', onFail: 'download' } } }), /^DeptreeError: manifests\["\."\]\.devEngines\.runtime: a node runtime to download is not supported$/u)
    check({ ...MANIFEST, devEngines: { runtime: { name: 'node', version: '24.0.0', onFail: 'warn' } } })
  })

  it('refuses a version the importer resolved outside its range', () => {
    const lockfile = structuredClone(LOCKFILE)
    Object.setPrototypeOf(lockfile.importers, null)
    lockfile.importers['.'].specifiers.q = '^2.0.0'
    assert.throws(() => check({ ...MANIFEST, dependencies: { ...MANIFEST.dependencies, q: '^2.0.0' } }, { lockfile }), /dependencies\.q resolved to "1\.2\.0", which is not in "\^2\.0\.0"/u)
  })
})
