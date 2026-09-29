import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parsePnpmLockfile } from '@preventive/lockfile/pnpm.js'
import { checkCatalogResolutions, checkLinkTargets, checkLinkedPackages, sameSpecifier } from '../src/pnpm/frozen.js'

// What pnpm 11's frozen install holds a project to beyond pnpm 10's, case
// by case.

describe('sameSpecifier', () => {
  it('takes two spellings of one git repository and commit alike for pnpm 11', () => {
    const alike = [
      ['github:o/r#v1', 'o/r#v1'],
      ['o/r', 'git+https://github.com/o/r.git'],
      ['gitlab:o/r#main', 'https://gitlab.com/o/r#main'],
      ['git://example.com/o/r.git#c', 'git+https://example.com/o/r#c'],
    ]
    for (const [a, b] of alike) {
      assert.equal(sameSpecifier(a, b, 11), true, `${a} ${b}`)
      assert.equal(sameSpecifier(a, b, 10), false, `${a} ${b}`)
    }
    const apart = [['o/r#v1', 'o/r#v2'], ['https://example.com/o/r', 'git+https://example.com/o/r.git'], ['^1.0.0', '1.x'], ['o/r#a#b', 'o/r#a#b '], ['o/r', undefined]]
    for (const [a, b] of apart) assert.equal(sameSpecifier(a, b, 11), false, `${a} ${b}`)
  })
})

const I = 'sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg=='

describe('checkCatalogResolutions', () => {
  const lockfile = (version) => parsePnpmLockfile(`lockfileVersion: '9.0'

catalogs:
  default:
    q:
      specifier: ^1.0.0
      version: ${version}

importers:

  .:
    dependencies:
      q:
        specifier: 'catalog:'
        version: 1.2.0

packages:

  q@1.2.0:
    resolution: {integrity: ${I}}

snapshots:

  q@1.2.0: {}
`).lockfile

  it('holds a catalog dependency to the version the catalog records', () => {
    const matching = lockfile('1.2.0')
    checkCatalogResolutions(matching.importers['.'], matching.catalogs, 'x')
    const stale = lockfile('1.3.0')
    assert.throws(() => checkCatalogResolutions(stale.importers['.'], stale.catalogs, 'x'), /^DeptreeError: x: "q" resolved to "1\.2\.0", and the lockfile's catalog "default" to "1\.3\.0"/u)
  })
})

describe('checkLinkedPackages', () => {
  // `b` asks for `a` as `spec`, and the lockfile resolves it to `version`.
  const check = (spec, version, { linkWorkspacePackages = false } = {}) => {
    const lockfile = parsePnpmLockfile(`lockfileVersion: '9.0'

importers:

  .: {}

  packages/a: {}

  packages/b:
    dependencies:
      a:
        specifier: '${spec}'
        version: ${version}
${version.startsWith('link:') ? '' : `
packages:

  a@1.2.0:
    resolution: {integrity: ${I}}

snapshots:

  a@1.2.0: {}
`}`).lockfile
    const b = { name: 'b', dependencies: { a: spec } }
    const projects = new Map([['.', { name: 'root' }], ['packages/a', { name: 'a', version: '1.2.0' }], ['packages/b', b], ['packages/x', { name: 'x', version: '1.2.0' }]])
    const importer = lockfile.importers['packages/b']
    checkLinkTargets({ id: 'packages/b', manifest: b, importer }, 'x')
    checkLinkedPackages({ manifest: b, importer, projects, linkWorkspacePackages }, 'x')
  }

  it('takes a workspace package linked where its version is in range, and one from the registry where it is not', () => {
    check('workspace:^1.0.0', 'link:../a')
    check('workspace:*', 'link:../a')
    check('workspace:../a', 'link:../a')
    check('link:../a', 'link:../a')
    check('../a', 'link:../a')
    check('./../a/', 'link:../a')
    check('^1.0.0', '1.2.0')
    check('^1.0.0', 'link:../a', { linkWorkspacePackages: true })
    check('^2.0.0', 'link:../a')
  })

  const refused = [
    ['a linked workspace package out of range', ['workspace:^2.0.0', 'link:../a'], /the linked workspace package a \(1\.2\.0\) is not in the range "workspace:\^2\.0\.0"/u],
    ['one linked out of range where workspace packages are linked', ['^2.0.0', 'link:../a', { linkWorkspacePackages: true }], /is not in the range "\^2\.0\.0"/u],
    ['a workspace package in range and not linked', ['^1.0.0', '1.2.0', { linkWorkspacePackages: true }], /the workspace package a \(1\.2\.0\) is in the range "\^1\.0\.0" and not linked/u],
    ['a link to another directory than the specifier', ['link:../c', 'link:../a'], /a is linked to "packages\/a", which is not where "link:\.\.\/c" leads/u],
    ['a link to another directory than a path alone', ['../c', 'link:../a'], /a is linked to "packages\/a", which is not where "\.\.\/c" leads/u],
    ['a link to another directory than a workspace: path', ['workspace:../c', 'link:../a'], /which is not where "workspace:\.\.\/c" leads/u],
    ['a link out of every workspace package of the name', ['workspace:^1.0.0', 'link:../x'], /a is linked to "packages\/x", which is in no workspace package named "a"/u],
    ['a link to a directory that is no project', ['^1.0.0', 'link:../../elsewhere', { linkWorkspacePackages: true }], /it is linked to "elsewhere", which is no project/u],
    ['a path from the home directory', ['link:~/a', 'link:../a'], /"~\/a" is not a path from the project, which is not supported/u],
    ['a path led by a backslash', ['\\a', 'link:../a'], /"\\\\a" is not a path from the project, which is not supported/u],
    ['a path from the home directory led by a backslash', ['~\\a', 'link:../a'], /"~\\\\a" is not a path from the project, which is not supported/u],
  ]
  for (const [what, [spec, version, options], pattern] of refused) {
    it(`refuses ${what}`, () => assert.throws(() => check(spec, version, options), pattern))
  }
})
