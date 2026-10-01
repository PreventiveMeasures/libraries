import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parsePnpmLockfile } from '@preventive/lockfile/pnpm.js'
import { createHook } from '../src/pnpm/hook.js'
import * as OVERRIDES from '../src/pnpm/overrides.js'
import { checkProjects, readManifests } from '../src/pnpm/projects.js'
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
const check = (manifest, { lockfile = LOCKFILE, hook = createHook({ overrides: [], ignored: [] }), host = { ...HOST, major: 10 }, ...settings } = {}) => {
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
    const local = createHook({ overrides: listOverrides({ q: 'link:vendor/q' }, {}), ignored: [] })
    assert.throws(() => check(MANIFEST, { hook: local }), /the specifiers differ: "q" is "\^1\.0\.0" in the lockfile and "link:vendor\/q" in package\.json/u)
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

  // pnpm 10 links what the lockfile says, but a lockfile pnpm writes links
  // a directory the package.json names there.
  it('refuses a link to another directory than the package.json names', () => {
    const lockfile = structuredClone(LOCKFILE)
    Object.setPrototypeOf(lockfile.importers, null)
    lockfile.importers['.'].devDependencies.l = 'link:../m'
    assert.throws(() => check(MANIFEST, { lockfile }), /^DeptreeError: manifests\["\."\]: the lockfile is not up to date with this package\.json, which a frozen install refuses: l is linked to "\.\.\/m", which is not where "link:\.\.\/l" leads$/u)
  })

  it('refuses a version the importer resolved outside its range', () => {
    const lockfile = structuredClone(LOCKFILE)
    Object.setPrototypeOf(lockfile.importers, null)
    lockfile.importers['.'].specifiers.q = '^2.0.0'
    assert.throws(() => check({ ...MANIFEST, dependencies: { ...MANIFEST.dependencies, q: '^2.0.0' } }, { lockfile }), /dependencies\.q resolved to "1\.2\.0", which is not in "\^2\.0\.0"/u)
  })
})

// What pnpm 11's frozen install holds a project to beyond pnpm 10's.
describe('checkProjects for pnpm 11', () => {
  const HOST_11 = { ...HOST, pnpm: '11.28.2', major: 11 }
  const check11 = (manifest, options) => check(manifest, { host: HOST_11, ...options })

  it('lets an optional dependency the importer has no specifier for go unresolved', () => {
    const manifest = { ...MANIFEST, optionalDependencies: { gone: '1.0.0' } }
    check11(manifest)
    assert.throws(() => check(manifest), /"gone" is nothing in the lockfile and "1\.0\.0" in package\.json/u, 'pnpm 10 refuses it')
  })

  it('takes git specifiers of one repository and commit alike', () => {
    const lockfile = structuredClone(LOCKFILE)
    Object.setPrototypeOf(lockfile.importers, null)
    lockfile.importers['.'].specifiers.r = 'github:o/r#v1'
    const manifest = (r) => ({ ...MANIFEST, dependencies: { ...MANIFEST.dependencies, r } })
    for (const same of ['o/r#v1', 'git+https://github.com/o/r.git#v1', 'https://github.com/o/r#v1', 'git://GitHub.com/o/r.git#v1']) check11(manifest(same), { lockfile })
    for (const other of ['o/r#v2', 'o/s#v1', 'git+https://example.com/o/r#v1']) assert.throws(() => check11(manifest(other), { lockfile }), /the specifiers differ/u, other)
    assert.throws(() => check(manifest('o/r#v1'), { lockfile }), /the specifiers differ/u, 'pnpm 10 takes only the same spelling')
  })

  it('holds a packageManager, or devEngines.packageManager, to what pnpm 11 runs', () => {
    check11({ ...MANIFEST, packageManager: 'pnpm@11.28.2' })
    assert.throws(() => check11({ ...MANIFEST, packageManager: 'pnpm@10.33.4' }), /packageManager: the project is installed by pnpm 10\.33\.4/u)
    check11({ ...MANIFEST, packageManager: 'pnpm@10.33.4' }, { pmOnFail: 'ignore' })
    check11({ ...MANIFEST, packageManager: 'yarn@4.0.0' }, { pmOnFail: 'warn' })
    const engine = (onFail) => ({ ...MANIFEST, devEngines: { packageManager: { name: 'pnpm', version: '^11.0.0', onFail } } })
    assert.throws(() => check11(engine('download')), /devEngines\.packageManager: not supported/u)
    assert.throws(() => check11(engine(undefined)), /devEngines\.packageManager: not supported/u)
    check11(engine('warn'))
    check11(engine('error'), { pmOnFail: 'ignore' })
    check11({ ...MANIFEST, devEngines: { packageManager: [{ name: 'pnpm' }, { name: 'yarn' }] } }, { pmOnFail: undefined })
  })

  it('checks the Node a root engines.runtime asks for with onFail error', () => {
    const runtime = (version, onFail = 'error') => ({ ...MANIFEST, engines: { runtime: { name: 'node', version, onFail } } })
    check11(runtime('>=24'))
    check11(runtime('<24', 'warn'))
    assert.throws(() => check11(runtime('<24')), /engines\.runtime: Node 24\.15\.0 is not in "<24", which pnpm 11 refuses/u)
    check11(runtime('<24'), { runtimeOnFail: 'ignore' })
    check(runtime('<24'))
    assert.throws(() => check11({ ...MANIFEST, devEngines: { runtime: { name: 'bun', version: '1', onFail: 'error' } } }), /the bun it runs on is checked by pnpm 11/u)
  })

  it('holds the importer\'s linkDirectory to publishConfig', () => {
    const lockfile = structuredClone(LOCKFILE)
    Object.setPrototypeOf(lockfile.importers, null)
    lockfile.importers['.'].publishDirectory = 'dist'
    const manifest = (linkDirectory) => ({ ...MANIFEST, publishConfig: { directory: 'dist', linkDirectory } })
    check11(manifest(undefined), { lockfile })
    assert.throws(() => check11(manifest(false), { lockfile }), /linkDirectory is true in the lockfile and publishConfig\.linkDirectory false/u)
    check(manifest(false), { lockfile })
  })
})

// pnpm 12 checks of a project only the root's engines.node, with
// engineStrict, whatever its os; and holds a project the lockfile has no
// importer for to none where it has no dependencies, peers aside.
describe('checkProjects for pnpm 12', () => {
  const HOST_12 = { ...HOST, pnpm: '12.8.1', major: 12 }
  const check12 = (manifest, options) => check(manifest, { host: HOST_12, ...options })

  it('holds the root alone to its engines.node, with engineStrict alone', () => {
    check12({ ...MANIFEST, engines: { pnpm: '>=13', node: '<10' } })
    assert.throws(() => check12({ ...MANIFEST, os: ['win32'], engines: { node: '<10' } }, { engineStrict: true }), /^DeptreeError: manifests\["\."\]: its engines\.node, "<10", does not take Node 24\.15\.0, which engineStrict refuses$/u)
    assert.throws(() => check12({ ...MANIFEST, engines: { node: 'node >= 0.8' } }, { engineStrict: true }), /pnpm 12 reads otherwise than npm's semver/u)
    const lockfile = structuredClone(LOCKFILE)
    Object.setPrototypeOf(lockfile.importers, null)
    const manifests = readManifests({ '.': JSON.stringify(MANIFEST), 'packages/x': JSON.stringify({ engines: { node: '<10', pnpm: '>=13' } }) }, lockfile)
    checkProjects(lockfile, manifests, { hook: createHook({ overrides: [], ignored: [] }), host: HOST_12, settings: { ...SETTINGS, engineStrict: true } })
  })

  it('takes a project the lockfile has no importer for where it has no dependencies, peers aside', () => {
    const run = (project, settings = {}) => {
      const lockfile = structuredClone(LOCKFILE)
      Object.setPrototypeOf(lockfile.importers, null)
      const manifests = readManifests({ '.': JSON.stringify(MANIFEST), 'packages/x': JSON.stringify(project) }, lockfile)
      checkProjects(lockfile, manifests, { hook: createHook({ overrides: [], ignored: [] }), host: HOST_12, settings: { ...SETTINGS, ...settings } })
    }
    run({ peerDependencies: { q: '^1.0.0' } })
    run({ optionalDependencies: { gone: '1.0.0' } }, { ignoredOptionalDependencies: ['gone'] })
    for (const kind of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      assert.throws(() => run({ [kind]: { q: '^1.0.0' } }), /^DeptreeError: manifests\["packages\/x"\]: the lockfile has no importer for this project, which has dependencies, and pnpm 12 refuses it$/u, kind)
    }
  })
})
