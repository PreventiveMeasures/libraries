import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parsePnpmLockfile } from '@preventive/lockfile/pnpm.js'
import { checkProjects } from '../src/pnpm/projects.js'

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
const check = (manifest, { autoInstallPeers = true, lockfile = LOCKFILE } = {}) => checkProjects(lockfile, new Map([['.', manifest]]), { autoInstallPeers })

describe('checkProjects', () => {
  it('takes a package.json that asks for what the importer records', () => {
    check(MANIFEST)
    check({ ...MANIFEST, peerDependencies: { q: '^1.0.0' } })
    check({ ...MANIFEST, peerDependencies: { z: '1' } }, { autoInstallPeers: false })
  })

  const refused = [
    ['a changed specifier', { ...MANIFEST, dependencies: { ...MANIFEST.dependencies, q: '^1.1.0' } }, /the specifiers differ: "q" is "\^1\.0\.0" in the lockfile and "\^1\.1\.0" in package\.json/u],
    ['a dependency of another kind', { dependencies: { q: '^1.0.0' }, devDependencies: { ...MANIFEST.devDependencies, r: 'npm:q@1.2.0' } }, /dependencies in the lockfile do not match/u],
    ['a peer listed nowhere else', { ...MANIFEST, peerDependencies: { z: '1' } }, /"z" is in package\.json and not in the lockfile/u],
    ['a publish directory', { ...MANIFEST, publishConfig: { directory: 'dist' } }, /publishDirectory/u],
    ['dependenciesMeta', { ...MANIFEST, dependenciesMeta: { q: { injected: true } } }, /dependenciesMeta differs/u],
    ['a specifier that is not a string', { ...MANIFEST, dependencies: { ...MANIFEST.dependencies, q: 1 } }, /"q" is "\^1\.0\.0" in the lockfile and "1" in package\.json/u],
    ['dependencies that are not a mapping', { ...MANIFEST, dependencies: ['q'] }, /^DeptreeError: manifests\["\."\]\.dependencies: expected a mapping$/u],
  ]
  for (const [what, manifest, pattern] of refused) {
    it(`refuses ${what}`, () => assert.throws(() => check(manifest), pattern))
  }

  it('refuses a version the importer resolved outside its range', () => {
    const lockfile = structuredClone(LOCKFILE)
    Object.setPrototypeOf(lockfile.importers, null)
    lockfile.importers['.'].specifiers.q = '^2.0.0'
    assert.throws(() => check({ ...MANIFEST, dependencies: { ...MANIFEST.dependencies, q: '^2.0.0' } }, { lockfile }), /dependencies\.q resolved to "1\.2\.0", which is not in "\^2\.0\.0"/u)
  })
})
