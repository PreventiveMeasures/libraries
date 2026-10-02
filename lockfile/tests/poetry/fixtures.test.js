import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { parsePoetryLock } from '../../poetry.js'

// Real lockfiles, as Poetry writes them: one project with every kind of
// source Poetry locks, by Poetry 2.3, of lock-version 2.1, and by Poetry
// 1.8, of 2.0, with an index of its own. scripts/record-python.js records
// them; its header says how.

const FIXTURES = new URL('fixtures/', import.meta.url)
const read = (name) => parsePoetryLock(readFileSync(new URL(`${name}.lock`, FIXTURES), 'utf8'))
const plain = (value) => JSON.parse(JSON.stringify(value))
const byName = (lock, name) => lock.packages.filter((pkg) => pkg.name === name)

const SIX = 'https://files.pythonhosted.org/packages/d9/5a/e7c31adbe875f2abbb91bd84cf2dc52d792b5a01506781dbcf25c91daf11/six-1.16.0-py2.py3-none-any.whl'

describe('Poetry 2.3, lock-version 2.1', () => {
  const lock = read('poetry-2.3.3')

  it('the metadata, and the project\'s extras', () => {
    assert.equal(lock.lockVersion, '2.1')
    assert.equal(lock.pythonVersions, '>=3.11')
    assert.match(lock.contentHash, /^[\da-f]{64}$/u)
    assert.deepEqual(plain(lock.extras), { fast: ['anyio'] })
  })

  it('the groups each package is in, and the markers it is needed with', () => {
    const [old, current] = byName(lock, 'iniconfig')
    assert.deepEqual([old.version, current.version], ['2.0.0', '2.1.0'])
    assert.deepEqual(old.groups, ['main', 'dev'])
    assert.deepEqual(plain(old.markers), { main: 'python_version == "3.11"', dev: 'python_version == "3.11"' })
    assert.deepEqual(byName(lock, 'ruff')[0].groups, ['lint'])
    const [anyio] = byName(lock, 'anyio')
    assert.equal(anyio.optional, true)
    assert.equal(anyio.markers.main, 'extra == "fast"')
  })

  it('every kind of source', () => {
    const sources = Object.fromEntries(lock.packages.filter((pkg) => pkg.source !== undefined).map((pkg) => [pkg.name, plain(pkg.source)]))
    assert.deepEqual(sources, {
      editpkg: { type: 'directory', path: 'editpkg' },
      localpkg: { type: 'directory', path: 'localpkg' },
      sampleproject: { type: 'git', url: 'https://github.com/pypa/sampleproject', reference: 'main', commit: '621e4974ca25ce531773def586ba3ed8e736b3fc' },
      six: { type: 'url', url: SIX },
      wheelpkg: { type: 'file', path: 'dist/wheelpkg-0.1.0-py3-none-any.whl' },
    })
    assert.deepEqual([byName(lock, 'editpkg')[0].develop, byName(lock, 'localpkg')[0].develop], [true, false])
    assert.deepEqual(byName(lock, 'sampleproject')[0].files, [])
    assert.equal(byName(lock, 'six')[0].files[0].file, 'six-1.16.0-py2.py3-none-any.whl')
  })

  it('a dependency of an extra, by a name as the package has it', () => {
    const requests = byName(lock, 'requests')[0]
    assert.deepEqual(plain(requests.dependencies.PySocks), [{ type: 'version', version: '>=1.5.6,<1.5.7 || >1.5.7', extras: [], optional: true, markers: 'extra == "socks"' }])
    assert.deepEqual(requests.extras.socks, ['PySocks (>=1.5.6,!=1.5.7)'])
  })
})

describe('Poetry 1.8, lock-version 2.0', () => {
  const lock = read('poetry-1.8.5')

  it('no groups, no markers', () => {
    assert.equal(lock.lockVersion, '2.0')
    assert.equal(lock.pythonVersions, '^3.11')
    assert.ok(lock.packages.every((pkg) => pkg.groups === undefined && pkg.markers === undefined))
  })

  it('an index of the project\'s own, and a git commit asked for by rev', () => {
    assert.deepEqual(plain(byName(lock, 'ruff')[0].source), { type: 'legacy', url: 'https://pypi.org/simple', name: 'mirror' })
    assert.equal(byName(lock, 'sampleproject')[0].source.reference, '621e4974ca25ce531773def586ba3ed8e736b3fc')
  })

  it('the same packages, at the same versions, as Poetry 2.3 locks', () => {
    const names = (of) => of.packages.map((pkg) => `${pkg.name} ${pkg.version}`)
    assert.deepEqual(names(lock), names(read('poetry-2.3.3')))
  })
})
