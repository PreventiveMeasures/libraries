import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { parsePylock } from '../../pylock.js'
import { parseUvLock } from '../../uv.js'

// Real lockfiles, as each tool writes a pylock.toml: uv's export of the
// workspace in ../uv/fixtures/, pip's `pip lock` of registry packages, a
// directory, a git commit and archives by URL, and PDM's export of a
// project with extras and groups. scripts/record-python.js records them;
// its header says how.

const FIXTURES = new URL('fixtures/', import.meta.url)
const text = (name) => readFileSync(new URL(name, FIXTURES), 'utf8')
const read = (name) => parsePylock(text(name))
const plain = (value) => JSON.parse(JSON.stringify(value))
const byName = (lock, name) => lock.packages.find((pkg) => pkg.name === name)

describe('uv export', () => {
  const lock = read('uv-0.12.21.toml')

  it('every package uv locked but the virtual root, at its version but a directory\'s', () => {
    const uv = parseUvLock(readFileSync(new URL('../uv/fixtures/uv-0.12.21.lock', import.meta.url), 'utf8'))
    const locked = Object.values(uv.packages).filter((pkg) => pkg.source.type !== 'virtual')
    const tree = (pkg) => pkg.source.type === 'directory' || pkg.source.type === 'editable'
    assert.deepEqual(lock.packages.map((pkg) => [pkg.name, pkg.version]), locked.map((pkg) => [pkg.name, tree(pkg) ? undefined : pkg.version]))
    assert.equal(lock.createdBy, 'uv')
  })

  it('a package from the index, with its upload times as date-times', () => {
    const anyio = byName(lock, 'anyio')
    assert.equal(anyio.index, 'https://pypi.org/simple')
    assert.equal(anyio.sdist.uploadTime, '2026-09-05T10:42:39Z')
    assert.equal(anyio.wheels[0].name, 'anyio-4.15.1-py3-none-any.whl')
  })

  it('a git branch, directories, and archives by URL and by path', () => {
    assert.deepEqual(plain(byName(lock, 'sampleproject').vcs), { type: 'git', url: 'https://github.com/pypa/sampleproject', requestedRevision: 'main', commitId: '621e4974ca25ce531773def586ba3ed8e736b3fc' })
    assert.deepEqual(plain(byName(lock, 'member').directory), { path: 'packages/member', editable: true })
    assert.deepEqual(plain(byName(lock, 'localpkg').directory), { path: 'localpkg', editable: false })
    assert.equal(byName(lock, 'wheelpkg').archive.path, 'dist/wheelpkg-0.1.0-py3-none-any.whl')
    assert.match(byName(lock, 'six').archive.url, /\/six-1\.16\.0-py2\.py3-none-any\.whl$/u)
  })

  it('one name at two versions, each by its marker', () => {
    assert.deepEqual(lock.packages.filter((pkg) => pkg.name === 'iniconfig').map((pkg) => [pkg.version, pkg.marker]), [['2.0.0', "python_full_version < '3.12'"], ['2.1.0', "python_full_version >= '3.12'"]])
  })
})

describe('pip lock', () => {
  const lock = read('pip-26.2.1.toml')

  it('wheels as arrays of tables, and no index, version or marker of a direct reference', () => {
    assert.equal(lock.createdBy, 'pip')
    assert.deepEqual(Object.keys(byName(lock, 'attrs').wheels[0].hashes), ['sha256'])
    assert.equal(byName(lock, 'pysocks').wheels[0].name, 'PySocks-1.7.1-py3-none-any.whl')
    assert.deepEqual([byName(lock, 'sampleproject').version, byName(lock, 'sampleproject').vcs.requestedRevision], [undefined, '621e4974ca25ce531773def586ba3ed8e736b3fc'])
    assert.deepEqual(plain(byName(lock, 'localpkg').directory), { path: 'localpkg', editable: false })
    assert.match(byName(lock, 'peppercorn').archive.url, /\/peppercorn-0\.6\.tar\.gz$/u)
  })
})

describe('PDM export', () => {
  const lock = read('pdm-2.29.2.toml')

  it('the groups it can install, and each package\'s, by marker', () => {
    assert.deepEqual([lock.extras, lock.dependencyGroups, lock.defaultGroups], [[], ['default', 'dev'], ['default']])
    assert.deepEqual(lock.environments, ['python_version >= "3.11"'])
    assert.equal(byName(lock, 'pytest').marker, '"dev" in dependency_groups')
    assert.equal(byName(lock, 'requests').marker, '"default" in dependency_groups')
  })

  it('its own tables, as written', () => {
    assert.deepEqual(plain(byName(lock, 'requests').tool.pdm.dependencies), ['certifi>=2017.4.17', 'charset-normalizer<4,>=2', 'idna<4,>=2.5', 'urllib3<3,>=1.21.1'])
    assert.match(lock.tool.pdm.hashes.sha256, /^[\da-f]{64}$/u)
  })
})
