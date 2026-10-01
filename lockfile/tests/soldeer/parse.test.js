import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { LockfileError, TomlError, parseSoldeerLockfile } from '../../soldeer.js'

const H = 'a'.repeat(64)
const C = 'b'.repeat(40)

// One entry of each kind, laid out as Soldeer 0.12 writes them.
const BASE = `version = 2

[[dependencies]]
name = "a-lib"
version = "1.2.0"
url = "https://soldeer-revisions.s3.amazonaws.com/a-lib/1_2_0_01-01-2025_00:00:00_a.zip"
checksum = "${H}"
integrity = "${H}"

[[dependencies]]
name = "b-git"
version = "v1"
git = "https://example.com/b.git"
rev = "${C}"

[[dependencies]]
name = "c-private"
version = "2.0.0"
checksum = "${H}"
integrity = "${H}"
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

const refuses = (text, message, where, options) => assert.throws(() => parseSoldeerLockfile(text, options), (error) => {
  assert.ok(error instanceof LockfileError, error.stack)
  assert.equal(error.message, where === undefined ? message : `${where}: ${message}`)
  assert.equal(error.where, where)
  return true
})

describe('each kind of entry', () => {
  it('read by what it has: a url, a git repository, or neither', () => {
    const { lockfileVersion, dependencies } = parseSoldeerLockfile(BASE)
    assert.equal(lockfileVersion, 2)
    assert.deepEqual(Object.values(dependencies).map((entry) => entry.type), ['http', 'git', 'private'])
    assert.equal(Object.getPrototypeOf(dependencies), null)
    assert.deepEqual({ ...dependencies['c-private'] }, { type: 'private', name: 'c-private', version: '2.0.0', checksum: H, integrity: H })
  })

  it('refuses what Soldeer requires missing, and what it does not write for the kind', () => {
    refuses(edit([`checksum = "${H}"\nintegrity = "${H}"\n\n[[dep`, `checksum = "${H}"\n\n[[dep`]), 'expected integrity, which Soldeer requires of an entry with a url', 'dependencies["a-lib"]')
    refuses(edit([`rev = "${C}"\n`, '']), 'expected rev, which Soldeer requires of an entry with a git repository', 'dependencies["b-git"]')
    refuses(edit([`version = "2.0.0"\nchecksum = "${H}"\n`, 'version = "2.0.0"\n']), 'expected checksum, which Soldeer requires of an entry with neither a url nor a git repository', 'dependencies["c-private"]')
    refuses(edit([`rev = "${C}"\n`, `rev = "${C}"\nchecksum = "${H}"\n`]), 'a field Soldeer does not write for an entry with a git repository', 'dependencies["b-git"].checksum')
    refuses(edit(['git = "https://example.com/b.git"\n', 'git = "https://example.com/b.git"\nurl = "https://example.com/b.zip"\n']), 'both a url and a git repository, which Soldeer refuses', 'dependencies["b-git"]')
  })

  it('refuses a field it does not know, and the source of Soldeer 0.3 and older', () => {
    refuses(edit(['version = "2.0.0"\n', 'version = "2.0.0"\nsource = "https://example.com/c.zip"\n']), 'a field of Soldeer 0.3 and older, whose entries 0.4 and later do not read', 'dependencies["c-private"].source')
    refuses(edit(['version = "2.0.0"\n', 'version = "2.0.0"\nbranch = "main"\n']), 'unsupported field "branch"', 'dependencies["c-private"].branch')
  })

  it('refuses a hash, a commit or a URL Soldeer does not write', () => {
    refuses(edit([`checksum = "${H}"`, `checksum = "${H.toUpperCase()}"`]), `"${H.toUpperCase()}" is not a hex sha256`, 'dependencies["a-lib"].checksum')
    refuses(edit([`rev = "${C}"`, 'rev = "bbbbbbb"']), '"bbbbbbb" is not a full commit hash, as Soldeer writes', 'dependencies["b-git"].rev')
    refuses(edit(['url = "https://soldeer', 'url = "ftp://soldeer']), '"ftp://soldeer-revisions.s3.amazonaws.com/a-lib/1_2_0_01-01-2025_00:00:00_a.zip" is not an http(s) URL', 'dependencies["a-lib"].url')
  })

  it('refuses an empty string, and one toml_edit writes in other quotes, or as its releases differ', () => {
    refuses(edit(['version = "v1"', 'version = ""']), '"" is empty, or has a quote, backslash or control character, which this reader does not take', 'dependencies["b-git"].version')
    refuses(edit(['version = "v1"', 'version = "v\\"1"']), '"v\\"1" is empty, or has a quote, backslash or control character, which this reader does not take', 'dependencies["b-git"].version')
    refuses(edit(['version = "v1"', 'version = "v\\t1"']), '"v\\t1" is empty, or has a quote, backslash or control character, which this reader does not take', 'dependencies["b-git"].version')
    refuses(edit(['version = "v1"', 'version = 1']), 'expected a string, found the number 1', 'dependencies["b-git"].version')
  })
})

describe('the file', () => {
  it('a format version of 1, 2 or none, and the dependencies Soldeer requires', () => {
    assert.equal(parseSoldeerLockfile(BASE.replace('version = 2\n\n', '')).lockfileVersion, 1)
    assert.equal(parseSoldeerLockfile(BASE.replace('version = 2', 'version = 1')).lockfileVersion, 1)
    refuses(edit(['version = 2', 'version = 3']), 'expected 1, for Soldeer 0.11 and older, or 2, the formats Soldeer 0.12 knows', 'version')
    refuses('version = 2\n', 'expected an array of tables, which Soldeer requires', 'dependencies')
    refuses(`${BASE}\n[extra]\n`, 'unsupported field "extra"', 'extra')
    refuses('version = 2\ndependencies = [1.5]\n', 'expected a table', 'dependencies[0]')
  })

  it('names in the order Soldeer sorts them, whatever order an object lists them in', () => {
    const { dependencies } = parseSoldeerLockfile(edit(['name = "a-lib"', 'name = "10"'], ['name = "b-git"', 'name = "9"']))
    assert.deepEqual(Object.keys(dependencies), ['9', '10', 'c-private'])
  })

  it('refuses a name twice, or out of the order Soldeer sorts them in, by code point', () => {
    refuses(edit(['name = "b-git"', 'name = "a-lib"']), 'a second entry of the name, where Soldeer writes one', 'dependencies["a-lib"]')
    refuses(edit(['name = "c-private"', 'name = "b"']), 'after "b-git", where Soldeer sorts entries by name', 'dependencies.b')
    // UTF-16 sorts U+FF5E before U+1F600, and code points the other way.
    const named = (a, b) => edit(['name = "a-lib"', `name = "a${a}"`], ['name = "b-git"', `name = "a${b}"`])
    assert.ok(parseSoldeerLockfile(named('～', '\u{1F600}')))
    refuses(named('\u{1F600}', '～'), 'after "a\u{1F600}", where Soldeer sorts entries by name', 'dependencies["a～"]')
  })

  it('refuses two entries Soldeer installs in one folder, on Unix or on Windows', () => {
    refuses(edit(['name = "b-git"\nversion = "v1"', 'name = "a:lib"\nversion = "1.2.0"']), 'installed in the folder "a-lib-1.2.0", as "a-lib" is', 'dependencies["a:lib"]')
    // `a-b-c.` ends in a dot, which Windows does not keep.
    refuses(edit(['name = "a-lib"\nversion = "1.2.0"', 'name = "a"\nversion = "b-c-"'], ['name = "b-git"\nversion = "v1"', 'name = "a-b"\nversion = "c."']), 'installed in the folder "a-b-c-", as "a" is', 'dependencies["a-b"]')
  })

  it('refuses a layout Soldeer does not write, by its line', () => {
    refuses(BASE.replace('version = 2\n\n', 'version = 2\n'), 'line 2: expected "", as Soldeer writes it, found "[[dependencies]]"')
    refuses(BASE.replace('name = "a-lib"\nversion = "1.2.0"', 'version = "1.2.0"\nname = "a-lib"'), 'line 4: expected "name = \\"a-lib\\"", as Soldeer writes it, found "version = \\"1.2.0\\""')
    refuses(BASE.replace('name = "a-lib"', "name = 'a-lib'"), 'line 4: expected "name = \\"a-lib\\"", as Soldeer writes it, found "name = \'a-lib\'"')
    refuses(`# a comment\n${BASE}`, 'line 1: expected "version = 2", as Soldeer writes it, found "# a comment"')
    refuses(`${BASE}\n`, 'line 21: expected the end of the file, as Soldeer writes it')
    refuses(BASE.slice(0, -1), 'line 20: expected a newline at its end, as Soldeer writes it')
    refuses(BASE.replaceAll('\n', '\r\n'), 'line 1: expected "version = 2", as Soldeer writes it, found "version = 2\\r"')
    refuses('version = 2\ndependencies = [ ]\n', 'line 2: expected "dependencies = []", as Soldeer writes it, found "dependencies = [ ]"')
  })

  it('throws a TomlError for what is not TOML, and a TypeError for bad arguments', () => {
    assert.throws(() => parseSoldeerLockfile('[[dependencies]\n'), TomlError)
    assert.throws(() => parseSoldeerLockfile(Buffer.from(BASE)), { name: 'TypeError', message: 'expected a string' })
    assert.throws(() => parseSoldeerLockfile(BASE, null), { name: 'TypeError', message: 'expected an options object' })
    assert.throws(() => parseSoldeerLockfile(BASE, { dependencies: {} }), { name: 'TypeError', message: 'unknown option "dependencies", of config' })
  })
})

describe('the config', () => {
  const DEPENDENCIES = {
    'a-lib': '^1.0.0',
    'b-git': { version: 'v1', git: 'https://example.com/b.git', branch: 'main' },
    'c-private': { version: '>=2.0.0, <3.0.0' },
  }
  const config = (extra) => ({ soldeer: { remappings_generate: false }, dependencies: { ...DEPENDENCIES, ...extra } })

  it('each dependency held to its entry, and the rest of the config not read', () => {
    assert.ok(parseSoldeerLockfile(BASE, { config: config() }))
    assert.ok(parseSoldeerLockfile('version = 2\ndependencies = []\n', { config: {} }))
  })

  it('refuses what Soldeer refuses, or warns of and ignores', () => {
    refuses(BASE, 'expected a version, which Soldeer requires', 'config.dependencies["a-lib"]', { config: config({ 'a-lib': '' }) })
    refuses(BASE, 'a field Soldeer does not read', 'config.dependencies["a-lib"].tags', { config: config({ 'a-lib': { version: '1.2.0', tags: 'x' } }) })
    refuses(BASE, 'a field Soldeer ignores without a git repository', 'config.dependencies["a-lib"].rev', { config: config({ 'a-lib': { version: '1.2.0', rev: C } }) })
    refuses(BASE, 'a url beside a git repository, which Soldeer refuses', 'config.dependencies["b-git"].url', { config: config({ 'b-git': { version: 'v1', git: 'https://example.com/b.git', url: 'https://example.com/b.zip' } }) })
    refuses(BASE, 'branch and tag, of which Soldeer takes one alone', 'config.dependencies["b-git"]', { config: config({ 'b-git': { version: 'v1', git: 'https://example.com/b.git', branch: 'main', tag: 'v1' } }) })
    refuses(BASE, '"=v1" has an "=", which Soldeer refuses in the version of what it does not resolve', 'config.dependencies["b-git"].version', { config: config({ 'b-git': { version: '=v1', git: 'https://example.com/b.git' } }) })
    refuses(BASE, 'expected a string, found the number 1', 'config.dependencies["a-lib"].version', { config: config({ 'a-lib': { version: 1 } }) })
  })

  it('refuses two names Soldeer installs in one folder', () => {
    refuses(BASE, 'installed in the folder "a-lib", as "a-lib" is', 'config.dependencies["a/lib"]', { config: config({ 'a/lib': '1.2.0' }) })
  })

  it('a version that is not semver held to the requirement as folder names, on Unix and on Windows', () => {
    const lock = edit(['name = "c-private"\nversion = "2.0.0"', 'name = "c-private"\nversion = "two/0"'])
    assert.ok(parseSoldeerLockfile(lock, { config: config({ 'c-private': 'two:0' }) }))
    refuses(lock, '"two.0", which its entry\'s version, "two/0", does not satisfy', 'config.dependencies["c-private"].version', { config: config({ 'c-private': 'two.0' }) })
  })

  it('a registry version to its requirement, by semver where a comparator with no operator is exact', () => {
    const asking = (requirement) => ({ config: config({ 'a-lib': requirement }) })
    for (const requirement of ['1.2.0', '1.2', '1', '^1.0', '>=1.0, <2', '1.*', '*', ' =1.2.0']) assert.ok(parseSoldeerLockfile(BASE, asking(requirement)), requirement)
    for (const requirement of ['1.0', '1.0.0', '>=1.0, 1.0', '~1.3']) {
      refuses(BASE, `${JSON.stringify(requirement)}, which its entry's version, "1.2.0", does not satisfy`, 'config.dependencies["a-lib"].version', asking(requirement))
    }
  })

  it('refuses a private entry for a URL the config names', () => {
    refuses(BASE, 'a URL dependency, whose entry is a private registry one', 'config.dependencies["c-private"]', { config: config({ 'c-private': { version: '2.0.0', url: 'https://example.com/c.zip' } }) })
  })
})
