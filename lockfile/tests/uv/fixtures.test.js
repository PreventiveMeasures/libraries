import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { parseUvLock } from '../../uv.js'

// Real lockfiles, as uv writes them: a workspace with every kind of source
// uv locks, by uv 0.12, 0.6 and 0.4; and a project of conflicting extras,
// a dynamic version and the resolver's options, by 0.12.
// scripts/record-python.js records them; its header says how.

const FIXTURES = new URL('fixtures/', import.meta.url)
const read = (name) => parseUvLock(readFileSync(new URL(`${name}.lock`, FIXTURES), 'utf8'))
const plain = (value) => JSON.parse(JSON.stringify(value))

const PYPI = 'registry+https://pypi.org/simple'
const SAMPLE = 'https://github.com/pypa/sampleproject?branch=main#621e4974ca25ce531773def586ba3ed8e736b3fc'
const SIX = 'https://files.pythonhosted.org/packages/d9/5a/e7c31adbe875f2abbb91bd84cf2dc52d792b5a01506781dbcf25c91daf11/six-1.16.0-py2.py3-none-any.whl'
const ROOT = 'uv-demo==0.1.0 @ virtual+.'

describe('a workspace, as uv 0.12 writes it', () => {
  const lock = read('uv-0.12.21')

  it('the format, the forks, and the workspace\'s own packages', () => {
    assert.deepEqual([lock.version, lock.revision, lock.requiresPython], [1, 3, '>=3.11'])
    assert.deepEqual(lock.resolutionMarkers, ["python_full_version >= '3.12'", "python_full_version < '3.12'"])
    assert.deepEqual(lock.members, ['member==0.1.0 @ editable+packages/member', ROOT])
    assert.equal(lock.options.excludeNewer, '2026-09-30T00:00:00Z')
    assert.deepEqual(plain(lock.manifest.constraints), [{ name: 'urllib3', extras: [], groups: [], source: { type: 'registry', specifier: '<3' } }])
  })

  it('every kind of source', () => {
    const sources = Object.fromEntries(Object.values(lock.packages).map((pkg) => [pkg.name, pkg.source.id]))
    assert.equal(sources.anyio, PYPI)
    assert.equal(sources.localpkg, 'directory+localpkg')
    assert.equal(sources.editpkg, 'editable+editpkg')
    assert.equal(sources.member, 'editable+packages/member')
    assert.equal(sources.wheelpkg, 'path+dist/wheelpkg-0.1.0-py3-none-any.whl')
    assert.equal(sources.sampleproject, `git+${SAMPLE}`)
    assert.equal(sources.six, `direct+${SIX}`)
    assert.equal(sources['uv-demo'], 'virtual+.')
  })

  it('the root\'s edges: one name at two versions, by marker, and an extra', () => {
    const edges = plain(lock.packages[ROOT].dependencies)
    assert.deepEqual(edges.filter((edge) => edge.package.startsWith('iniconfig')), [
      { package: `iniconfig==2.0.0 @ ${PYPI}`, extras: [], marker: "python_full_version < '3.12'" },
      { package: `iniconfig==2.1.0 @ ${PYPI}`, extras: [], marker: "python_full_version >= '3.12'" },
    ])
    assert.deepEqual(edges.find((edge) => edge.package.startsWith('requests')), { package: `requests==2.32.3 @ ${PYPI}`, extras: ['socks'] })
    assert.deepEqual(plain(lock.packages[ROOT].optionalDependencies), { dev: [{ package: `pytest==8.2.0 @ ${PYPI}`, extras: [] }] })
    assert.deepEqual(plain(lock.packages[ROOT].devDependencies), { lint: [{ package: `ruff==0.4.4 @ ${PYPI}`, extras: [] }] })
    assert.deepEqual(lock.packages[`iniconfig==2.0.0 @ ${PYPI}`].resolutionMarkers, ["python_full_version < '3.12'"])
  })

  it('a member\'s group, and the extra an edge asks for', () => {
    assert.equal(lock.packages['member==0.1.0 @ editable+packages/member'].devDependencies.test.length, 2)
    assert.deepEqual(plain(lock.packages[`requests==2.32.3 @ ${PYPI}`].optionalDependencies), { socks: [{ package: `pysocks==1.7.1 @ ${PYPI}`, extras: [] }] })
  })

  it('a registry\'s files, with their sizes and upload times; a URL\'s and a path\'s wheel by its hash', () => {
    const anyio = lock.packages[`anyio==4.15.1 @ ${PYPI}`]
    assert.equal(anyio.sdist.size, 276966)
    assert.equal(anyio.sdist.uploadTime, '2026-09-05T10:42:39.44Z')
    assert.equal(anyio.wheels[0].filename, 'anyio-4.15.1-py3-none-any.whl')
    const six = lock.packages[`six==1.16.0 @ direct+${SIX}`]
    assert.deepEqual(plain(six.wheels), [{ url: SIX, filename: 'six-1.16.0-py2.py3-none-any.whl', hash: 'sha256:8abb2f1d86890a2dfb989f9a77cfcfd3e47c2a354b01111771326f8aa26e0254' }])
    const wheel = lock.packages['wheelpkg==0.1.0 @ path+dist/wheelpkg-0.1.0-py3-none-any.whl'].wheels[0]
    assert.deepEqual([wheel.filename, wheel.url, wheel.path], ['wheelpkg-0.1.0-py3-none-any.whl', undefined, undefined])
    assert.match(wheel.hash, /^sha256:[\da-f]{64}$/u)
  })

  it('a git branch, at the commit it resolved to', () => {
    const { source } = lock.packages[`sampleproject==4.0.0 @ git+${SAMPLE}`]
    assert.deepEqual([source.repository, source.reference, source.commit], ['https://github.com/pypa/sampleproject', { kind: 'branch', name: 'main' }, '621e4974ca25ce531773def586ba3ed8e736b3fc'])
  })

  it('what the root asked for, by every kind of source', () => {
    const { requiresDist, providesExtras, requiresDev } = lock.packages[ROOT].metadata
    assert.deepEqual(requiresDist.map((requirement) => requirement.source.type), ['registry', 'registry', 'editable', 'registry', 'registry', 'directory', 'editable', 'registry', 'registry', 'git', 'url', 'path'])
    assert.deepEqual(providesExtras, ['dev'])
    assert.deepEqual(Object.keys(requiresDev), ['lint'])
  })
})

describe('the same workspace by older uv', () => {
  const lock = read('uv-0.12.21')

  it('uv 0.6: revision 2, its upload times as upload_time, read the same', () => {
    const old = read('uv-0.6.17')
    assert.equal(old.revision, 2)
    assert.deepEqual(plain(old.packages), plain(lock.packages))
  })

  it('uv 0.4: no revision, no upload times, no provides-extras', () => {
    const old = read('uv-0.4.30')
    assert.equal(old.revision, 0)
    assert.deepEqual(Object.keys(old.packages), Object.keys(lock.packages))
    assert.deepEqual(old.members, lock.members)
    assert.equal(old.packages[`anyio==4.15.1 @ ${PYPI}`].sdist.uploadTime, undefined)
    assert.deepEqual(old.packages[ROOT].metadata.providesExtras, [])
  })
})

describe('conflicts, a dynamic version, and the resolver\'s options', () => {
  const lock = read('uv-0.12.21-conflicts')

  it('two extras that conflict, and the environments the lockfile covers', () => {
    assert.deepEqual(plain(lock.conflicts), [[{ package: 'uv-conflicts', extra: 'new' }, { package: 'uv-conflicts', extra: 'old' }]])
    assert.deepEqual(lock.supportedMarkers, ["sys_platform == 'linux'", "sys_platform == 'darwin'"])
    assert.deepEqual(lock.requiredMarkers, ["sys_platform == 'linux'"])
    assert.deepEqual([lock.options.resolutionMode, lock.options.prereleaseMode], ['lowest-direct', 'allow'])
  })

  it('a package of a dynamic version, by its source alone', () => {
    assert.equal(lock.packages['dynpkg @ editable+dynpkg'].version, undefined)
    assert.deepEqual(plain(lock.packages['uv-conflicts==0.1.0 @ virtual+.'].dependencies[0]), { package: 'dynpkg @ editable+dynpkg', extras: [] })
  })

  it('an sdist by URL, by its hash alone, and a git commit asked for by rev', () => {
    const peppercorn = Object.values(lock.packages).find((pkg) => pkg.name === 'peppercorn')
    assert.equal(peppercorn.source.type, 'url')
    assert.deepEqual(plain(peppercorn.sdist), { hash: 'sha256:96d7681d7a04545cfbaf2c6fb66de67b29cfc42421aa263e4c78f2cbb85be4c6' })
    const sample = Object.values(lock.packages).find((pkg) => pkg.name === 'sampleproject')
    assert.deepEqual(sample.source.reference, { kind: 'rev', name: '621e4974ca25ce531773def586ba3ed8e736b3fc' })
  })

  it('each extra to its own version of one name', () => {
    const extras = lock.packages['uv-conflicts==0.1.0 @ virtual+.'].optionalDependencies
    assert.deepEqual([extras.old[0].package, extras.new[0].package], [`iniconfig==2.0.0 @ ${PYPI}`, `iniconfig==2.1.0 @ ${PYPI}`])
  })
})
