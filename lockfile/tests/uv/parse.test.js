import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { LockfileError, TomlError, parseUvLock } from '../../uv.js'

const H = 'a'.repeat(64)
const C = 'c'.repeat(40)
const PYPI = 'registry = "https://pypi.org/simple"'

// A project of each kind of edge: a name alone, a name of two packages by
// its version and source, an extra; a registry package with its files, a
// git one, and one name at two versions.
const BASE = `version = 1
revision = 3
requires-python = ">=3.11"

[[package]]
name = "a"
version = "1.0.0"
source = { ${PYPI} }
dependencies = [
    { name = "b" },
]
sdist = { url = "https://files.example.com/a-1.0.0.tar.gz", hash = "sha256:${H}", size = 10, upload-time = "2026-01-01T00:00:00Z" }
wheels = [
    { url = "https://files.example.com/a-1.0.0-py3-none-any.whl", hash = "sha256:${H}", size = 10, upload-time = "2026-01-01T00:00:00.5Z" },
]

[package.optional-dependencies]
x = [
    { name = "c", version = "1.0", source = { ${PYPI} } },
]

[[package]]
name = "b"
version = "2.0.0"
source = { git = "https://github.com/o/b?tag=v2#${C}" }

[[package]]
name = "c"
version = "1.0"
source = { ${PYPI} }

[[package]]
name = "c"
version = "2.0"
source = { ${PYPI} }

[[package]]
name = "project"
version = "0.1.0"
source = { virtual = "." }
dependencies = [
    { name = "a", extra = ["x"] },
    { name = "c", version = "2.0", source = { ${PYPI} }, marker = "sys_platform == 'win32'" },
]

[package.metadata]
requires-dist = [
    { name = "a", extras = ["x"] },
    { name = "c", marker = "sys_platform == 'win32'", specifier = ">=2" },
]
`

// BASE with each `[from, to]` replaced, once; `from` has to be there.
function edit(...edits) {
  let text = BASE
  for (const [from, to] of edits) {
    assert.ok(text.includes(from), `BASE has no ${JSON.stringify(from)}`)
    text = text.replace(from, to)
  }
  return text
}

const refuses = (text, message, where) => assert.throws(() => parseUvLock(text), (error) => {
  assert.ok(error instanceof LockfileError, error.stack)
  assert.equal(error.message, where === undefined ? message : `${where}: ${message}`)
  assert.equal(error.where, where)
  return true
})

const A = 'a==1.0.0 @ registry+https://pypi.org/simple'
const C1 = 'c==1.0 @ registry+https://pypi.org/simple'
const C2 = 'c==2.0 @ registry+https://pypi.org/simple'
const PROJECT = 'project==0.1.0 @ virtual+.'

describe('the graph', () => {
  const lock = parseUvLock(BASE)

  it('each package by its key, as uv shows it, in the order of the file', () => {
    assert.deepEqual(Object.keys(lock.packages), [A, `b==2.0.0 @ git+https://github.com/o/b?tag=v2#${C}`, C1, C2, PROJECT])
    assert.equal(Object.getPrototypeOf(lock.packages), null)
    assert.deepEqual(lock.members, [PROJECT])
  })

  it('an edge by its name alone, by its version and source, with an extra and a marker', () => {
    assert.deepEqual(structuredClone(lock.packages[PROJECT].dependencies), [
      { package: A, extras: ['x'], marker: undefined },
      { package: C2, extras: [], marker: "sys_platform == 'win32'" },
    ])
    assert.deepEqual(structuredClone(lock.packages[A].optionalDependencies.x), [{ package: C1, extras: [], marker: undefined }])
  })

  it('a registry package\'s files, and a git source taken apart', () => {
    const a = lock.packages[A]
    assert.deepEqual({ ...a.sdist }, { url: 'https://files.example.com/a-1.0.0.tar.gz', path: undefined, hash: `sha256:${H}`, size: 10, uploadTime: '2026-01-01T00:00:00Z' })
    assert.equal(a.wheels[0].filename, 'a-1.0.0-py3-none-any.whl')
    assert.equal(a.wheels[0].uploadTime, '2026-01-01T00:00:00.5Z')
    const b = lock.packages[`b==2.0.0 @ git+https://github.com/o/b?tag=v2#${C}`].source
    assert.deepEqual({ ...b }, { type: 'git', url: `https://github.com/o/b?tag=v2#${C}`, repository: 'https://github.com/o/b', reference: { kind: 'tag', name: 'v2' }, commit: C, subdirectory: undefined, path: undefined, lfs: false, id: `git+https://github.com/o/b?tag=v2#${C}` })
  })

  it('the metadata a package was locked with', () => {
    const { requiresDist } = lock.packages[PROJECT].metadata
    assert.deepEqual(structuredClone(requiresDist[1]), { name: 'c', extras: [], groups: [], marker: "sys_platform == 'win32'", source: { type: 'registry', specifier: '>=2', index: undefined, conflict: undefined } })
  })

  it('the defaults of what is left out', () => {
    assert.equal(lock.revision, 3)
    assert.deepEqual([lock.resolutionMarkers, lock.conflicts, lock.manifest.members], [[], [], []])
    assert.deepEqual([lock.options.resolutionMode, lock.options.prereleaseMode, lock.options.forkStrategy], ['highest', 'if-necessary-or-explicit', 'requires-python'])
  })
})

describe('the format', () => {
  it('refuses another version, a revision past 3, and the format of uv 0.2', () => {
    refuses(edit(['version = 1\n', 'version = 2\n']), 'unsupported version: expected 1, found the integer 2', 'version')
    refuses(edit(['version = 1\n', '']), 'no `version`: a lockfile of uv 0.2 or older, which is not read here', 'version')
    refuses(edit(['revision = 3', 'revision = 4']), 'unsupported revision: expected 1, 2 or 3, found the integer 4', 'revision')
    refuses(edit(['[[package]]\nname = "b"', '[[distribution]]\nname = "b"']), '`distribution` is what uv 0.2 and older wrote for `package`, which is not read here', 'distribution')
    assert.equal(parseUvLock(edit(['revision = 3\n', ''])).revision, 0)
  })

  it('refuses a key it does not know, and the old spelling of dev-dependencies', () => {
    refuses(edit(['requires-python', 'extra = 1\nrequires-python']), 'unsupported key "extra"')
    refuses(edit(['[package.metadata]', '[package.dependency-groups]\n\n[package.metadata]']), '`dependency-groups` is an older spelling of `dev-dependencies`, which uv no longer writes', 'package[4]["dependency-groups"]')
  })

  it('refuses a name, a version or a marker out of the form uv writes', () => {
    refuses(edit(['name = "b"\nversion', 'name = "B"\nversion']), '"B" is not a name in normal form, "b"', 'package[1].name')
    refuses(edit(['version = "2.0.0"', 'version = "v2.0.0"']), '"v2.0.0" is not a version in normal form, "2.0.0"', 'package[1].version')
    refuses(edit(['marker = "sys_platform', 'marker = "sys.platform']), '"sys.platform == \'win32\'" is not an environment marker', 'package[4].dependencies[1].marker')
    refuses(edit(['requires-python = ">=3.11"', 'requires-python = ">=3.11,"']), '">=3.11," is not a list of version specifiers', 'requires-python')
  })

  it('refuses a TypeError for anything but a string, and hands a TomlError on', () => {
    assert.throws(() => parseUvLock(Buffer.from(BASE)), TypeError)
    assert.throws(() => parseUvLock('version = '), TomlError)
  })
})

describe('sources', () => {
  it('refuses a source of no kind or two, and a subdirectory but of a URL', () => {
    refuses(edit(['source = { virtual = "." }', 'source = {}']), 'expected one of registry, git, url, path, directory, editable, virtual, found none', 'package[4].source')
    refuses(edit(['source = { virtual = "." }', 'source = { virtual = ".", editable = "." }']), 'expected one of registry, git, url, path, directory, editable, virtual, found editable and virtual', 'package[4].source')
    refuses(edit(['source = { virtual = "." }', 'source = { virtual = ".", subdirectory = "x" }']), 'a subdirectory, which uv reads of a URL alone', 'package[4].source.subdirectory')
  })

  it('refuses a path that is absolute or out of normal form', () => {
    refuses(edit(['source = { virtual = "." }', 'source = { virtual = "/home/x" }']), '"/home/x" is absolute, and only reads on the machine that wrote it', 'package[4].source.virtual')
    refuses(edit(['source = { virtual = "." }', 'source = { virtual = "a/./b" }']), '"a/./b" is not a relative path in normal form', 'package[4].source.virtual')
  })

  it('refuses a URL out of normal form, or with credentials', () => {
    refuses(edit([`source = { ${PYPI} }\ndependencies`, 'source = { registry = "https://PyPI.org/simple" }\ndependencies']), '"https://PyPI.org/simple" is not a URL in normal form, of https, http, file', 'package[0].source.registry')
    refuses(edit([`source = { ${PYPI} }\ndependencies`, 'source = { registry = "https://u:p@pypi.org/simple" }\ndependencies']), '"https://u:p@pypi.org/simple" has credentials in it, which uv does not write', 'package[0].source.registry')
  })

  it('a local registry by its path', () => {
    const lock = parseUvLock(edit([`name = "c"\nversion = "2.0"\nsource = { ${PYPI} }`, 'name = "c"\nversion = "2.0"\nsource = { registry = "../wheels" }'], [`version = "2.0", source = { ${PYPI} }`, 'version = "2.0", source = { registry = "../wheels" }']))
    assert.deepEqual({ ...lock.packages['c==2.0 @ registry+../wheels'].source }, { type: 'registry', url: undefined, path: '../wheels', id: 'registry+../wheels' })
  })

  it('refuses a git source without its commit, or with one other than rev= names', () => {
    const git = (url) => edit([`source = { git = "https://github.com/o/b?tag=v2#${C}" }`, `source = { git = "${url}" }`])
    refuses(git('https://github.com/o/b?tag=v2'), '"https://github.com/o/b?tag=v2" is not a git source: expected "#" and the full commit it resolved to', 'package[1].source.git')
    refuses(git(`https://github.com/o/b?rev=${'d'.repeat(40)}#${C}`), `"https://github.com/o/b?rev=${'d'.repeat(40)}#${C}" is not a git source: rev= names another commit than the one it resolved to`, 'package[1].source.git')
    refuses(git(`https://github.com/o/b?tag=v2&branch=main#${C}`), `"https://github.com/o/b?tag=v2&branch=main#${C}" is not a git source: more than one of branch=, tag= and rev=`, 'package[1].source.git')
    refuses(git(`https://github.com/o/b?ref=v2#${C}`), `"https://github.com/o/b?ref=v2#${C}" is not a git source: uv does not read "ref"`, 'package[1].source.git')
    const lock = parseUvLock(git(`https://github.com/o/b?subdirectory=pkg&rev=v2#${C}`).replace(`b?tag=v2#${C}`, `b?subdirectory=pkg&rev=v2#${C}`))
    assert.deepEqual(Object.values(lock.packages)[1].source.reference, { kind: 'rev', name: 'v2' })
    assert.equal(Object.values(lock.packages)[1].source.subdirectory, 'pkg')
  })

  it('refuses a package without a version but of a source tree', () => {
    refuses(edit(['version = "2.0.0"\n', '']), 'expected a version, which uv writes of any but a source tree\'s package', 'package[1]')
    const lock = parseUvLock(edit(['version = "0.1.0"\nsource = { virtual = "." }', 'source = { virtual = "." }']))
    assert.deepEqual(lock.members, ['project @ virtual+.'])
  })
})

describe('files', () => {
  const WHEEL = `{ url = "https://files.example.com/a-1.0.0-py3-none-any.whl", hash = "sha256:${H}", size = 10, upload-time = "2026-01-01T00:00:00.5Z" }`

  it('refuses an sdist or wheels a source of the kind has none of', () => {
    refuses(edit(['source = { virtual = "." }', 'source = { virtual = "." }\nsdist = { hash = "x" }']), 'an sdist, which a virtual source has none of', 'package[4].sdist')
    refuses(edit([`source = { git = "https://github.com/o/b?tag=v2#${C}" }`, `source = { git = "https://github.com/o/b?tag=v2#${C}" }\nwheels = []`]), 'wheels, which a git source has none of', 'package[1].wheels')
  })

  it('refuses the file of a URL without its hash', () => {
    const url = 'https://files.example.com/a-1.0.0-py3-none-any.whl'
    const text = edit([`source = { ${PYPI} }\ndependencies`, `source = { url = "${url}" }\ndependencies`], [WHEEL, `{ url = "${url}" }`])
    refuses(text.replace(/^sdist = .*\n/mu, ''), 'expected a hash, which uv writes for a file of a url source', 'package[0].wheels[0]')
  })

  it('refuses a key uv does not write for the kind of source', () => {
    const url = 'https://files.example.com/a-1.0.0-py3-none-any.whl'
    refuses(edit([`source = { ${PYPI} }\ndependencies`, `source = { url = "${url}" }\ndependencies`], [WHEEL, `{ url = "${url}", hash = "sha256:${H}", size = 10 }`]).replace(/^sdist = .*\n/mu, ''), 'unsupported key "size"', 'package[0].wheels[0]')
    refuses(edit([WHEEL, `{ filename = "a-1.0.0-py3-none-any.whl", hash = "sha256:${H}" }`]), 'unsupported key "filename"', 'package[0].wheels[0]')
  })

  it('refuses a wheel of another name or version, and takes one of a local version', () => {
    refuses(edit(['a-1.0.0-py3-none-any.whl', 'b-1.0.0-py3-none-any.whl']), '"b-1.0.0-py3-none-any.whl" is a wheel of "b", not of "a"', 'package[0].wheels[0]')
    refuses(edit(['a-1.0.0-py3-none-any.whl', 'a-1.0.1-py3-none-any.whl']), '"a-1.0.1-py3-none-any.whl" is a wheel of another version than "1.0.0"', 'package[0].wheels[0]')
    refuses(edit(['a-1.0.0-py3-none-any.whl', 'a-1.0.0-py3-none.whl']), '"a-1.0.0-py3-none.whl" is not the name of a wheel', 'package[0].wheels[0]')
    assert.equal(parseUvLock(edit(['a-1.0.0-py3-none-any.whl', 'a-1.0.0%2Blocal-py3-none-any.whl'])).packages[A].wheels[0].filename, 'a-1.0.0+local-py3-none-any.whl')
  })

  it('refuses a hash of another algorithm or size, and a time not in UTC', () => {
    refuses(edit([`hash = "sha256:${H}", size = 10, upload-time = "2026-01-01T00:00:00Z"`, `hash = "sha1:${H}", size = 10, upload-time = "2026-01-01T00:00:00Z"`]), `"sha1:${H}" is not a hash of md5, sha256, sha384, sha512, blake2b`, 'package[0].sdist.hash')
    refuses(edit([`hash = "sha256:${H}", size = 10, upload-time = "2026-01-01T00:00:00Z"`, `hash = "sha256:${H.toUpperCase()}", size = 10, upload-time = "2026-01-01T00:00:00Z"`]), `"${H.toUpperCase()}" is not a sha256 digest in lowercase hex`, 'package[0].sdist.hash')
    refuses(edit(['upload-time = "2026-01-01T00:00:00Z"', 'upload-time = "2026-01-01T00:00:00+01:00"']), '"2026-01-01T00:00:00+01:00" is not a UTC timestamp', 'package[0].sdist["upload-time"]')
  })

  it('upload_time, as uv 0.6 wrote it, and not beside upload-time', () => {
    assert.equal(parseUvLock(edit(['upload-time = "2026-01-01T00:00:00Z"', 'upload_time = "2026-01-01T00:00:00Z"'])).packages[A].sdist.uploadTime, '2026-01-01T00:00:00Z')
    refuses(edit(['upload-time = "2026-01-01T00:00:00Z"', 'upload-time = "2026-01-01T00:00:00Z", upload_time = "2026-01-01T00:00:00Z"']), 'upload-time and upload_time, which are one field to uv', 'package[0].sdist')
  })
})

describe('edges', () => {
  it('refuses a name of no package, or of more than one with no source or version', () => {
    refuses(edit(['{ name = "b" }', '{ name = "d" }']), '"d" names no package in the lockfile', 'package[0].dependencies[0]')
    refuses(edit([`{ name = "c", version = "2.0", source = { ${PYPI} }, marker`, '{ name = "c", marker']), '"c" could be any of 2 packages, and names no source', 'package[4].dependencies[1]')
    refuses(edit([`{ name = "c", version = "2.0", source = { ${PYPI} }, marker`, `{ name = "c", source = { ${PYPI} }, marker`]), '"c" could be any of 2 versions, and names none', 'package[4].dependencies[1]')
  })

  it('refuses a version or a source the lockfile does not hold', () => {
    refuses(edit([`{ name = "c", version = "2.0", source`, `{ name = "c", version = "3.0", source`]), 'names a package the lockfile does not hold: "c==3.0 @ registry+https://pypi.org/simple"', 'package[4].dependencies[1]')
    refuses(edit([`{ name = "c", version = "2.0", source`, `{ name = "c", version = "2.0.0", source`]), '"2.0.0", where the package is "2.0"', 'package[4].dependencies[1]')
  })

  it('refuses an extra the package has no dependencies for, which uv drops', () => {
    refuses(edit(['extra = ["x"]', 'extra = ["y"]']), `"y", an extra "${A}" has no dependencies for, which uv drops`, 'package[4].dependencies[0]')
    refuses(edit(['extra = ["x"]', 'extra = ["x", "x"]']), '"x" is listed twice', 'package[4].dependencies[0].extra')
  })

  it('refuses one edge twice alike', () => {
    refuses(edit(['    { name = "b" },\n', '    { name = "b" },\n    { name = "b" },\n']), '"b==2.0.0 @ git+https://github.com/o/b?tag=v2#cccccccccccccccccccccccccccccccccccccccc" is listed twice alike', 'package[0].dependencies')
  })

  it('refuses a package listed twice, by an equal version too', () => {
    refuses(edit(['name = "c"\nversion = "2.0"', 'name = "c"\nversion = "1.0.0"']), `"c==1.0.0 @ registry+https://pypi.org/simple" is listed twice, first as package[2]`, 'package[3]')
  })
})

describe('what uv resolved from', () => {
  it('options, conflicts and the manifest', () => {
    const lock = parseUvLock(edit(['requires-python = ">=3.11"\n', `requires-python = ">=3.11"
conflicts = [[{ package = "project", extra = "x" }, { package = "project", group = "y" }]]

[options]
resolution-mode = "lowest"
exclude-newer = "0001-01-01T00:00:00Z"
exclude-newer-span = "P3W"

[options.exclude-newer-package]
a = false
c = { timestamp = "0001-01-01T00:00:00Z", span = "P1D" }

[manifest]
members = ["project"]
constraints = [{ name = "a", specifier = "<2" }]
overrides = [{ name = "c", url = "https://files.example.com/c-2.0.tar.gz" }]

[manifest.dependency-groups]
dev = [{ name = "b", git = "https://github.com/o/b?tag=v2" }]
`]))
    assert.deepEqual(structuredClone(lock.conflicts), [[{ package: 'project', extra: 'x', group: undefined }, { package: 'project', extra: undefined, group: 'y' }]])
    assert.deepEqual([lock.options.resolutionMode, lock.options.excludeNewer, lock.options.excludeNewerSpan], ['lowest', undefined, 'P3W'])
    assert.deepEqual(structuredClone(lock.options.excludeNewerPackage), { a: false, c: { timestamp: '0001-01-01T00:00:00Z', span: 'P1D' } })
    assert.deepEqual(lock.members, [PROJECT])
    assert.equal(lock.manifest.overrides[0].source.type, 'url')
    assert.equal(lock.manifest.dependencyGroups.dev[0].source.commit, undefined)
  })

  it('conflicts of whole packages, as uv writes for workspace members, and none of no package', () => {
    const conflicts = (sets) => edit(['requires-python = ">=3.11"\n', `requires-python = ">=3.11"\nconflicts = ${sets}\n`])
    const lock = parseUvLock(conflicts('[[{ package = "a" }, { package = "b" }]]'))
    assert.deepEqual(structuredClone(lock.conflicts), [[{ package: 'a', extra: undefined, group: undefined }, { package: 'b', extra: undefined, group: undefined }]])
    refuses(conflicts('[[{ extra = "x" }, { package = "b" }]]'), 'expected a string, found nothing', 'conflicts[0][0].package')
    refuses(conflicts('[[{ package = "a", extra = "x", group = "y" }, { package = "b" }]]'), 'an extra and a group, of which uv takes one', 'conflicts[0][0]')
    refuses(conflicts('[[{ package = "a" }]]'), 'a set of conflicts of fewer than two, which uv refuses', 'conflicts[0]')
  })

  it('refuses an option it does not know, or a value uv does not write', () => {
    refuses(edit(['requires-python = ">=3.11"\n', 'requires-python = ">=3.11"\n\n[options]\nresolution-mode = "newest"\n']), 'expected one of highest, lowest, lowest-direct', 'options["resolution-mode"]')
    refuses(edit(['requires-python = ">=3.11"\n', 'requires-python = ">=3.11"\n\n[options]\nexclude-newer-span = "3 weeks"\n']), '"3 weeks" is not an ISO 8601 duration', 'options["exclude-newer-span"]')
  })

  it('refuses a member the lockfile has no package of', () => {
    refuses(edit(['requires-python = ">=3.11"\n', 'requires-python = ">=3.11"\n\n[manifest]\nmembers = ["other"]\n']), '"other" is no package of a directory in the lockfile', 'manifest.members[0]')
  })

  it('refuses an override of one package\'s dependencies, and a requirement of two sources', () => {
    refuses(edit(['requires-python = ">=3.11"\n', 'requires-python = ">=3.11"\n\n[manifest]\noverrides = [{ package = { name = "a" }, dependencies = [] }]\n']), 'an override of one package\'s dependencies, which is not read here', 'manifest.overrides[0]')
    refuses(edit(['{ name = "a", extras = ["x"] }', '{ name = "a", extras = ["x"], specifier = ">=1", path = "a" }']), 'more than one source: path, specifier', 'package[4].metadata["requires-dist"][0]')
  })
})
