import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { LockfileError, TomlError, parsePylock } from '../../pylock.js'

const H = 'a'.repeat(64)
const C = 'c'.repeat(40)

// A multi-use lockfile: an entry from an index with an sdist and a wheel,
// one name at two versions by marker, a VCS, a directory and an archive,
// dependencies naming entries, and tool tables.
const BASE = `lock-version = "1.0"
environments = ["sys_platform == 'linux'"]
requires-python = ">=3.11"
extras = ["fast"]
dependency-groups = ["dev"]
default-groups = ["default"]
created-by = "test"

[[packages]]
name = "a"
version = "1.0.0"
marker = "'default' in dependency_groups"
requires-python = ">=3.8"
index = "https://pypi.org/simple"
dependencies = [{ name = "b", version = "2.0" }, { name = "d" }]
sdist = { url = "https://files.example.com/a-1.0.0.tar.gz", upload-time = 2026-01-01T00:00:00Z, size = 10, hashes = { sha256 = "${H}" } }
wheels = [{ name = "a-1.0.0-py3-none-any.whl", url = "https://files.example.com/a-1.0.0-py3-none-any.whl", hashes = { sha256 = "${H}", md5 = "${'b'.repeat(32)}" } }]
attestation-identities = [{ kind = "GitHub", repository = "o/a" }]

[packages.tool.x]
note = 1

[[packages]]
name = "b"
version = "1.0"
marker = "python_version < '3.12'"
wheels = [{ path = "wheels/b-1.0-py3-none-any.whl", hashes = { sha256 = "${H}" } }]

[[packages]]
name = "b"
version = "2.0"
marker = "python_version >= '3.12'"
wheels = [{ path = "wheels/b-2.0-py3-none-any.whl", hashes = { sha256 = "${H}" } }]

[[packages]]
name = "c"
vcs = { type = "git", url = "https://github.com/o/c", requested-revision = "main", commit-id = "${C}" }

[[packages]]
name = "d"
directory = { path = "../d", editable = true }

[[packages]]
name = "e"
archive = { url = "https://files.example.com/e-1.0.zip", hashes = { sha256 = "${H}" }, subdirectory = "src" }

[tool.test]
seed = 1
`

function edit(...edits) {
  let text = BASE
  for (const [from, to] of edits) {
    assert.ok(text.includes(from), `BASE has no ${JSON.stringify(from)}`)
    text = text.replace(from, to)
  }
  return text
}

const refuses = (text, message, where) => assert.throws(() => parsePylock(text), (error) => {
  assert.ok(error instanceof LockfileError, error.stack)
  assert.equal(error.message, where === undefined ? message : `${where}: ${message}`)
  assert.equal(error.where, where)
  return true
})

const plain = (value) => JSON.parse(JSON.stringify(value))

describe('a multi-use lockfile', () => {
  const lock = parsePylock(BASE)

  it('what it can install, and for where', () => {
    assert.deepEqual(plain({ ...lock, packages: undefined, tool: undefined }), {
      lockVersion: '1.0', environments: ["sys_platform == 'linux'"], requiresPython: '>=3.11', extras: ['fast'], dependencyGroups: ['dev'], defaultGroups: ['default'], createdBy: 'test',
    })
    assert.deepEqual(plain(lock.tool), { test: { seed: 1 } })
  })

  it('an entry from an index, its files with their names, hashes and times', () => {
    const [a] = lock.packages
    assert.deepEqual(plain(a.sdist), { name: 'a-1.0.0.tar.gz', url: 'https://files.example.com/a-1.0.0.tar.gz', size: 10, uploadTime: '2026-01-01T00:00:00Z', hashes: { sha256: H } })
    assert.deepEqual(Object.keys(a.wheels[0].hashes), ['sha256', 'md5'])
    assert.deepEqual([a.index, a.marker, a.requiresPython], ['https://pypi.org/simple', "'default' in dependency_groups", '>=3.8'])
    assert.deepEqual(plain(a.attestationIdentities), [{ kind: 'GitHub', repository: 'o/a' }])
    assert.deepEqual(plain(a.tool), { x: { note: 1 } })
  })

  it('dependencies, each the one entry with every key it names', () => {
    assert.deepEqual(lock.packages[0].dependencies, [2, 4])
    assert.deepEqual(lock.packages[1].dependencies, [])
  })

  it('a VCS, a directory and an archive', () => {
    const [, , , c, d, e] = lock.packages
    assert.deepEqual(plain(c.vcs), { type: 'git', url: 'https://github.com/o/c', requestedRevision: 'main', commitId: C })
    assert.deepEqual(plain(d.directory), { path: '../d', editable: true })
    assert.deepEqual(plain(e.archive), { url: 'https://files.example.com/e-1.0.zip', hashes: { sha256: H }, subdirectory: 'src' })
    assert.deepEqual([c.version, c.wheels, c.sdist], [undefined, [], undefined])
  })

  it('a VCS by a URL of any scheme, a file by one of https, http or file', () => {
    const ssh = 'ssh://git@github.com/o/c.git'
    assert.equal(parsePylock(edit(['url = "https://github.com/o/c"', `url = "${ssh}"`])).packages[3].vcs.url, ssh)
    refuses(edit(['https://files.example.com/e-1.0.zip', 'ftp://files.example.com/e-1.0.zip']), '"ftp://files.example.com/e-1.0.zip" is not a URL of https, http, file', 'packages[5].archive.url')
  })
})

describe('the format', () => {
  it('refuses another major version, a key the spec does not name, and no created-by', () => {
    refuses(edit(['lock-version = "1.0"', 'lock-version = "2.0"']), 'unsupported lock-version: expected "1.0", found "2.0"', 'lock-version')
    assert.equal(parsePylock(edit(['lock-version = "1.0"', 'lock-version = "1.1"'])).lockVersion, '1.1')
    refuses(edit(['created-by = "test"', 'created-by = "test"\nhashes = []']), 'unsupported key "hashes"')
    refuses(edit(['created-by = "test"\n', '']), 'expected a string, found nothing', 'created-by')
    refuses(edit(['name = "e"', 'name = "e"\nextras = []']), 'unsupported key "extras"', 'packages[5]')
  })

  it('refuses names out of normal form, and markers and specifiers PEP 508 and PEP 440 do not read', () => {
    refuses(edit(['name = "c"', 'name = "C"']), '"C" is not a name in normal form, "c"', 'packages[3].name')
    refuses(edit(['extras = ["fast"]', 'extras = ["Fast"]']), '"Fast" is not a name in normal form, "fast"', 'extras[0]')
    refuses(edit(['environments = ["sys_platform', 'environments = ["sys.platform']), '"sys.platform == \'linux\'" is not an environment marker', 'environments[0]')
    refuses(edit(['requires-python = ">=3.8"', 'requires-python = "3.8"']), '"3.8" is not a list of version specifiers', 'packages[0]["requires-python"]')
  })

  it('a TypeError for anything but a string, and a TomlError on', () => {
    assert.throws(() => parsePylock(undefined), TypeError)
    assert.throws(() => parsePylock('lock-version = "1.0'), TomlError)
  })
})

describe('where a package comes from', () => {
  it('refuses two origins, and none', () => {
    refuses(edit(['name = "d"\ndirectory', `name = "d"\nvcs = { type = "git", path = "c", commit-id = "${C}" }\ndirectory`]), 'expected one of vcs, directory and archive, or an sdist or wheels, found vcs and directory', 'packages[4]')
    refuses(edit(['name = "d"\ndirectory = { path = "../d", editable = true }', 'name = "d"']), 'expected one of vcs, directory and archive, or an sdist or wheels, found none', 'packages[4]')
    refuses(edit(['name = "d"\ndirectory = { path = "../d", editable = true }', `name = "d"\ndirectory = { path = "../d" }\nwheels = [{ path = "d-1.0-py3-none-any.whl", hashes = { sha256 = "${H}" } }]`]), 'directory beside an sdist or wheels, which the spec forbids', 'packages[4]')
  })

  it('refuses a file of another name or version than its entry, or not a wheel or an sdist', () => {
    refuses(edit(['wheels/b-1.0-py3', 'wheels/c-1.0-py3']), '"c-1.0-py3-none-any.whl" is not a file of "b"', 'packages[1].wheels[0]')
    refuses(edit(['wheels/b-1.0-py3', 'wheels/b-1.1-py3']), '"b-1.1-py3-none-any.whl" is not of version "1.0"', 'packages[1].wheels[0]')
    refuses(edit(['a-1.0.0.tar.gz", upload', 'a-1.0.0.tar.bz2", upload']), '"a-1.0.0.tar.bz2" is not the name of an sdist, .tar.gz or .zip', 'packages[0].sdist')
    assert.equal(parsePylock(edit(['wheels/b-1.0-py3', 'wheels/b-1.0.0-py3'])).packages[1].wheels[0].name, 'b-1.0.0-py3-none-any.whl')
  })

  it('takes a file\'s name over its path\'s and its URL\'s', () => {
    refuses(edit(['{ name = "a-1.0.0-py3-none-any.whl", url', '{ name = "a-2.0-py3-none-any.whl", url']), '"a-2.0-py3-none-any.whl" is not of version "1.0.0"', 'packages[0].wheels[0]')
  })

  it('refuses a file of no URL or path, of no hash, or of a hash it does not know', () => {
    refuses(edit(['{ path = "wheels/b-1.0-py3-none-any.whl", hashes', '{ hashes']), 'expected a url or a path', 'packages[1].wheels[0]')
    refuses(edit([`archive = { url = "https://files.example.com/e-1.0.zip", hashes = { sha256 = "${H}" }`, 'archive = { url = "https://files.example.com/e-1.0.zip", hashes = {}']), 'expected a hash at least', 'packages[5].archive.hashes')
    refuses(edit([`archive = { url = "https://files.example.com/e-1.0.zip", hashes = { sha256 = "${H}" }`, `archive = { url = "https://files.example.com/e-1.0.zip", hashes = { SHA256 = "${H}" }`]), '"SHA256" is not a hash algorithm of hashlib\'s this reader knows', 'packages[5].archive.hashes.SHA256')
    refuses(edit([`md5 = "${'b'.repeat(32)}"`, `md5 = "${H}"`]), `"${H}" is not a md5 digest in lowercase hex`, 'packages[0].wheels[0].hashes.md5')
  })

  it('refuses an upload time but a date-time in UTC', () => {
    refuses(edit(['upload-time = 2026-01-01T00:00:00Z', 'upload-time = "2026-01-01T00:00:00Z"']), 'expected a date-time, found the string "2026-01-01T00:00:00Z"', 'packages[0].sdist["upload-time"]')
    refuses(edit(['upload-time = 2026-01-01T00:00:00Z', 'upload-time = 2026-01-01T00:00:00+01:00']), '2026-01-01T00:00:00+01:00 is not in UTC', 'packages[0].sdist["upload-time"]')
  })

  it('refuses a path that is absolute or has backslashes, and a commit but in full', () => {
    refuses(edit(['path = "../d"', 'path = "/home/d"']), '"/home/d" is absolute, and only reads on the machine that wrote it', 'packages[4].directory.path')
    refuses(edit(['path = "../d"', 'path = "..\\\\d"']), '"..\\\\d" is not a relative path in normal form', 'packages[4].directory.path')
    refuses(edit([`commit-id = "${C}"`, 'commit-id = "ccccccc"']), '"ccccccc" is not a full commit hash, which the spec requires', 'packages[3].vcs["commit-id"]')
    refuses(edit(['type = "git"', 'type = "cvs"']), 'expected one of git, hg, bzr, svn', 'packages[3].vcs.type')
  })
})

describe('entries of a name', () => {
  it('refuses two of a name with no marker, which an installer must refuse', () => {
    refuses(edit(['marker = "python_version < \'3.12\'"\n', ''], ['marker = "python_version >= \'3.12\'"\n', '']), '"b" is listed with no marker, as packages[1] is, and both would be installed', 'packages[2]')
  })

  it('refuses a dependency that names no entry, or more than one', () => {
    refuses(edit(['{ name = "b", version = "2.0" }', '{ name = "b", version = "3.0" }']), 'names no entry of packages', 'packages[0].dependencies[0]')
    refuses(edit(['{ name = "b", version = "2.0" }', '{ name = "b" }']), 'could be any of 2 entries of packages', 'packages[0].dependencies[0]')
    refuses(edit(['{ name = "b", version = "2.0" }', '{ version = "2.0" }']), 'expected a name', 'packages[0].dependencies[0]')
  })

  it('a dependency by a table it names, key by key', () => {
    const lock = parsePylock(edit(['{ name = "d" }', '{ name = "d", directory = { path = "../d", editable = true } }']))
    assert.deepEqual(lock.packages[0].dependencies, [2, 4])
    refuses(edit(['{ name = "d" }', '{ name = "d", directory = { path = "../d" } }']), 'names no entry of packages', 'packages[0].dependencies[1]')
  })
})
