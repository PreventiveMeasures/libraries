import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { LockfileError, TomlError, linkCargo, parseCargoConfig, parseCargoLock, parseCargoManifest, resolveCargoFeatures } from '../../cargo.js'

// A workspace of two members that depend on two versions of b, one renamed,
// and b asking for c by a feature; then one change at a time to the
// lockfile, a manifest or a build, each of which is refused.

const SUM = 'a'.repeat(64)
const CRATES = 'registry+https://github.com/rust-lang/crates.io-index'
const B1 = `b 1.0.0 (${CRATES})`
const B2 = `b 2.0.0 (${CRATES})`
const C = `c 1.0.0 (${CRATES})`

const LOCK = `version = 4

[[package]]
name = "a"
version = "0.1.0"
dependencies = ["b 2.0.0"]

[[package]]
name = "app"
version = "0.1.0"
dependencies = ["a", "b 1.0.0", "b 2.0.0"]

[[package]]
name = "b"
version = "1.0.0"
source = "${CRATES}"
checksum = "${SUM}"

[[package]]
name = "b"
version = "2.0.0"
source = "${CRATES}"
checksum = "${SUM}"
dependencies = ["c"]

[[package]]
name = "c"
version = "1.0.0"
source = "${CRATES}"
checksum = "${SUM}"
`

const MANIFESTS = {
  'app 0.1.0': `[package]
name = "app"
version = "0.1.0"
edition = "2021"

[workspace]
members = ["a"]

[features]
extra = ["a/extra"]

[dependencies]
a = { path = "a" }
b1 = { package = "b", version = "1" }
b = { version = "2", features = ["fast"] }
`,
  'a 0.1.0': `[package]
name = "a"
version = "0.1.0"
edition = "2021"

[features]
extra = ["b?/fast"]

[dependencies]
b = { version = "2", optional = true }
`,
  [B1]: '[package]\nname = "b"\nversion = "1.0.0"\n',
  [B2]: `[package]
name = "b"
version = "2.0.0"

[features]
fast = ["dep:c"]
slow = ["dep:d"]

[dependencies]
c = { version = "1", optional = true }
d = { version = "1", optional = true }
`,
  [C]: '[package]\nname = "c"\nversion = "1.0.0"\n',
}

const HOST = { name: 'x86_64-unknown-linux-gnu', cfg: ['unix', 'target_os="linux"'] }
const MEMBERS = ['app 0.1.0', 'a 0.1.0']

function link({ lock = LOCK, change = {} } = {}) {
  const texts = { ...MANIFESTS, ...change }
  const root = parseCargoManifest(texts['app 0.1.0'])
  const manifests = Object.fromEntries(Object.entries(texts).map(([key, text]) => [key, key === 'app 0.1.0' ? root : parseCargoManifest(text)]))
  return linkCargo(parseCargoLock(lock), manifests, { workspace: root, members: MEMBERS })
}

const refusedWith = (message) => (error) => error instanceof LockfileError && error.message === message

// A path package beside the workspace, which cargo would have pruned.
const Z = '[[package]]\nname = "z"\nversion = "0.1.0"\n'
const Z_MANIFEST = '[package]\nname = "z"\nversion = "0.1.0"\n'
const Y = `y 1.0.0 (${CRATES})`
const UNREACHED = 'no member depends on it, directly or not: is the lockfile out of date?'

describe('linkCargo', () => {
  const graph = link()

  it('ties each declaration to its package, by version where the name has two', () => {
    const app = graph.packages['app 0.1.0']
    assert.deepEqual(app.dependencies.map((dep) => [dep.name, dep.resolved, dep.active]), [['a', 'a 0.1.0', true], ['b1', B1, true], ['b', B2, true]])
  })

  it('leaves an optional dependency nothing turns on inactive, and unresolved where the lockfile lacks it', () => {
    const b = graph.packages[B2].dependencies
    assert.deepEqual(b.map((dep) => [dep.name, dep.resolved, dep.active]), [['c', C, true], ['d', undefined, false]])
  })

  it('reads the resolver from the root\'s edition', () => {
    assert.deepEqual([graph.resolver, graph.root, graph.members], [2, 'app 0.1.0', MEMBERS])
  })

  const refused = [
    ['a declaration the lockfile does not resolve', { change: { 'a 0.1.0': `${MANIFESTS['a 0.1.0']}e = "1"\n` } }, 'a 0.1.0: the lockfile resolves no "e", which the members\' features turn on: is it out of date?'],
    ['an edge no declaration is', { lock: LOCK.replace('dependencies = ["b 2.0.0"]', 'dependencies = ["b 2.0.0", "c"]') }, 'a 0.1.0: the lockfile\'s edge to "c 1.0.0 (registry+https://github.com/rust-lang/crates.io-index)" is no dependency the members\' features turn on: is it out of date?'],
    ['a declaration two packages could be', { change: { 'app 0.1.0': `${MANIFESTS['app 0.1.0']}bb = { package = "b", version = ">=1" }\n` } }, `app 0.1.0: "bb" could be any of "${B1}", "${B2}"`],
    ['a feature the package does not have', { change: { 'app 0.1.0': MANIFESTS['app 0.1.0'].replace('["fast"]', '["fast", "nope"]') } }, `app 0.1.0: "nope" is asked of "${B2}", which has no such feature`],
    ['a path package no member depends on', { lock: `${LOCK}\n${Z}`, change: { 'z 0.1.0': Z_MANIFEST } }, `z 0.1.0: ${UNREACHED}`],
    [
      'what only such a package depends on',
      { lock: `${LOCK}\n[[package]]\nname = "y"\nversion = "1.0.0"\nsource = "${CRATES}"\nchecksum = "${SUM}"\n\n${Z}dependencies = ["y"]\n`, change: { 'z 0.1.0': `${Z_MANIFEST}\n[dependencies]\ny = "1"\n`, [Y]: '[package]\nname = "y"\nversion = "1.0.0"\n' } },
      `${Y}: ${UNREACHED}`,
    ],
  ]
  for (const [title, input, message] of refused) {
    it(`refuses ${title}`, () => assert.throws(() => link(input), refusedWith(message)))
  }

  it('refuses two packages linking one native library', () => {
    const links = (text) => text.replace(/^(version = "[^"]*"\n)/mu, '$1links = "z"\n')
    assert.throws(() => link({ change: { [B1]: links(MANIFESTS[B1]), [B2]: links(MANIFESTS[B2]) } }), refusedWith(`${B2}: links the native library "z", as "${B1}" does, which cargo refuses`))
  })

  it('refuses two members of one name', () => {
    const lock = parseCargoLock('version = 4\n[[package]]\nname = "app"\nversion = "0.1.0"\ndependencies = ["x 1.0.0", "x 2.0.0"]\n[[package]]\nname = "x"\nversion = "1.0.0"\n[[package]]\nname = "x"\nversion = "2.0.0"\n')
    const root = parseCargoManifest('[package]\nname = "app"\nversion = "0.1.0"\n')
    assert.throws(() => linkCargo(lock, {}, { workspace: root, members: ['app 0.1.0', 'x 1.0.0', 'x 2.0.0'] }), refusedWith('members: "x 1.0.0" and "x 2.0.0" are two members of one name, which cargo refuses'))
  })

  it('refuses a manifest of another package', () => {
    assert.throws(() => link({ change: { [C]: '[package]\nname = "c"\nversion = "1.0.1"\n' } }), refusedWith(`${C}: the manifest given is of "c 1.0.1"`))
  })

  it('refuses a member that is not a path package', () => {
    const root = parseCargoManifest(MANIFESTS['app 0.1.0'])
    assert.throws(() => linkCargo(parseCargoLock(LOCK), {}, { workspace: root, members: [C] }), refusedWith(`members: "${C}" is not a path package in the lockfile`))
  })

  it('throws a TypeError for no root', () => {
    assert.throws(() => linkCargo(parseCargoLock(LOCK), {}, { members: MEMBERS }), TypeError)
  })
})

// A [patch] of x with a path, keyed by the source it patches, and a
// dependency on x from crates.io or another registry.
describe('linkCargo with a [patch]', () => {
  const lock = parseCargoLock('version = 4\n[[package]]\nname = "app"\nversion = "0.1.0"\ndependencies = ["x"]\n[[package]]\nname = "x"\nversion = "1.0.0"\n')
  const x = parseCargoManifest('[package]\nname = "x"\nversion = "1.0.0"\n')
  const patched = (dependency, key, patch = '{ path = "x" }') => {
    const root = parseCargoManifest(`[package]\nname = "app"\nversion = "0.1.0"\n\n[dependencies]\nx = ${dependency}\n\n[patch.${key}]\nx = ${patch}\n`)
    return linkCargo(lock, { 'app 0.1.0': root, 'x 1.0.0': x }, { workspace: root, members: ['app 0.1.0'] })
  }

  it('ties a dependency to the patch of its source', () => {
    assert.equal(patched('"1"', 'crates-io').packages['app 0.1.0'].dependencies[0].resolved, 'x 1.0.0')
    assert.equal(patched('"1"', '"https://github.com/rust-lang/crates.io-index/"').packages['app 0.1.0'].dependencies[0].resolved, 'x 1.0.0')
    assert.equal(patched('{ version = "1", registry-index = "https://example.com/index" }', '"https://example.com/index"').packages['app 0.1.0'].dependencies[0].resolved, 'x 1.0.0')
    assert.equal(patched('{ version = "1", registry = "corp" }', 'corp').packages['app 0.1.0'].dependencies[0].resolved, 'x 1.0.0')
  })

  it('refuses a dependency on a source no patch is for', () => {
    const message = 'app 0.1.0: the lockfile resolves "x" to none but "x 1.0.0", of another source or version: is it out of date, or [patch]ed by a config not given?'
    assert.throws(() => patched('"1"', '"https://example.com/index"'), refusedWith(message))
    assert.throws(() => patched('{ version = "1", registry-index = "https://example.com/index" }', 'crates-io'), refusedWith(message))
    assert.throws(() => patched('{ version = "1", registry = "corp" }', 'other'), refusedWith(message))
  })

  it('refuses a patch from the source it patches, whatever the git reference', () => {
    assert.throws(() => patched('"1"', 'crates-io', '"1"'), refusedWith('patch["crates-io"].x: patches its source with itself, which cargo refuses'))
    const git = '"https://example.com/x"'
    assert.throws(() => patched(`{ git = ${git} }`, git, '{ git = "https://example.com/x.git/", branch = "dev" }'), refusedWith('patch["https://example.com/x"].x: patches its source with itself, which cargo refuses'))
  })

  // x 1.0.0 at the patch's path, which cargo refuses where the patch's own
  // requirement does not take it.
  it('takes a patch only for the versions its requirement takes', () => {
    for (const version of ['1', '=1.0.0']) {
      assert.equal(patched('"1"', 'crates-io', `{ path = "x", version = "${version}" }`).packages['app 0.1.0'].dependencies[0].resolved, 'x 1.0.0')
    }
    const message = 'app 0.1.0: the lockfile resolves "x" to none but "x 1.0.0", of another source or version: is it out of date, or [patch]ed by a config not given?'
    for (const version of ['=1.0.1', '2']) {
      assert.throws(() => patched('"1"', 'crates-io', `{ path = "x", version = "${version}" }`), refusedWith(message))
    }
  })
})

// A [patch] of x that nothing depends on, which the lockfile lists unused,
// and its requirement.
describe('linkCargo with an unused [patch]', () => {
  const unused = (version, patch = `{ path = "x", version = "${version}" }`) => {
    const lock = parseCargoLock(`version = 4\n[[package]]\nname = "app"\nversion = "0.1.0"\n${version === undefined ? '' : '\n[[patch.unused]]\nname = "x"\nversion = "1.0.0"\n'}`)
    const root = parseCargoManifest(`[package]\nname = "app"\nversion = "0.1.0"\n${patch === null ? '' : `\n[patch.crates-io]\nx = ${patch}\n`}`)
    return linkCargo(lock, { 'app 0.1.0': root }, { workspace: root, members: ['app 0.1.0'] })
  }
  const missing = refusedWith('patch["crates-io"].x: the lockfile has no package this patch offers, used or unused: is it out of date?')
  const stray = 'patch.unused: the lockfile lists "x 1.0.0" unused where no [patch] does: is it out of date?'

  it('takes a patch the lockfile lists unused, of a version its requirement takes', () => {
    assert.deepEqual(Object.keys(unused('=1.0.0').packages), ['app 0.1.0'])
    assert.throws(() => unused('=2.0.0'), missing)
  })

  it('refuses a patch the lockfile has no package of, and an unused one no patch offers', () => {
    assert.throws(() => unused(undefined, '{ path = "x" }'), missing)
    assert.throws(() => unused('1', null), refusedWith(stray))
  })

  // The same patch in two tables, which cargo lists unused twice; and an
  // entry listed twice for one patch, or for a patch that is used.
  it('takes one unused entry for each patch that is not used, and leaves none', () => {
    const twice = '\n[[patch.unused]]\nname = "x"\nversion = "1.0.0"\n'.repeat(2)
    const lock = (packages, entries) => parseCargoLock(`version = 4\n[[package]]\nname = "app"\nversion = "0.1.0"\n${packages}${entries}`)
    const root = (tables) => parseCargoManifest(`[package]\nname = "app"\nversion = "0.1.0"\n${tables.map((table) => `\n[patch.${table}]\nx = { path = "x" }\n`).join('')}`)
    const check = (lockfile, manifest, x) => linkCargo(lockfile, { 'app 0.1.0': manifest, ...x }, { workspace: manifest, members: ['app 0.1.0'] })
    assert.deepEqual(Object.keys(check(lock('', twice), root(['crates-io', '"https://example.com/x"'])).packages), ['app 0.1.0'])
    assert.throws(() => check(lock('', twice), root(['crates-io'])), refusedWith(stray))
    const used = parseCargoManifest('[package]\nname = "app"\nversion = "0.1.0"\n\n[dependencies]\nx = "1"\n\n[patch.crates-io]\nx = { path = "x" }\n')
    const x = { 'x 1.0.0': parseCargoManifest('[package]\nname = "x"\nversion = "1.0.0"\n') }
    const usedLock = parseCargoLock('version = 4\n[[package]]\nname = "app"\nversion = "0.1.0"\ndependencies = ["x"]\n[[package]]\nname = "x"\nversion = "1.0.0"\n\n[[patch.unused]]\nname = "x"\nversion = "1.0.0"\n')
    assert.throws(() => check(usedLock, used, x), refusedWith(stray))
    // Taking 1.0.0 for the patch that takes any version would leave the
    // other none.
    const loose = parseCargoManifest('[package]\nname = "app"\nversion = "0.1.0"\n\n[patch.crates-io]\nx = { path = "x" }\n\n[patch."https://example.com/x"]\nx = { path = "y", version = "=1.0.0" }\n')
    const both = lock('', '\n[[patch.unused]]\nname = "x"\nversion = "1.0.0"\n\n[[patch.unused]]\nname = "x"\nversion = "2.0.0"\n')
    assert.deepEqual(Object.keys(check(both, loose).packages), ['app 0.1.0'])
  })
})

// crates.io patched by two tables: foo by `crates-io`, bar by an index URL.
describe('linkCargo with two [patch] tables for one source', () => {
  const tables = (url, unused) => {
    const lock = parseCargoLock(`version = 4\n[[package]]\nname = "app"\nversion = "0.1.0"\n${unused.map((name) => `\n[[patch.unused]]\nname = "${name}"\nversion = "1.0.0"\n`).join('')}`)
    const root = parseCargoManifest(`[package]\nname = "app"\nversion = "0.1.0"\n\n[patch.crates-io]\nfoo = { path = "foo" }\n\n[patch."${url}"]\nbar = { path = "bar" }\n`)
    return linkCargo(lock, { 'app 0.1.0': root }, { workspace: root, members: ['app 0.1.0'] })
  }

  it('reads the later of two at one URL, as cargo replaces the one with the other', () => {
    assert.deepEqual(Object.keys(tables('https://github.com/rust-lang/crates.io-index', ['bar']).packages), ['app 0.1.0'])
    assert.throws(() => tables('https://github.com/rust-lang/crates.io-index', ['bar', 'foo']), refusedWith('patch.unused: the lockfile lists "foo 1.0.0" unused where no [patch] does: is it out of date?'))
  })

  it('refuses two at one source by URLs that differ, of which cargo would take either', () => {
    const url = 'https://github.com/rust-lang/crates.io-index/'
    assert.throws(() => tables(url, ['bar']), refusedWith(`patch["${url}"]: patches the source [patch.crates-io] does by another URL, and cargo would take either table`))
  })
})

// x 1.0.0 at a path, patched in for crates.io by the config, the root, or
// both; the root's other patch y, which the lockfile lists unused.
describe('linkCargo with a [patch] in the config', () => {
  const lock = parseCargoLock('version = 4\n[[package]]\nname = "app"\nversion = "0.1.0"\ndependencies = ["x"]\n[[package]]\nname = "x"\nversion = "1.0.0"\n\n[[patch.unused]]\nname = "y"\nversion = "1.0.0"\n')
  const x = parseCargoManifest('[package]\nname = "x"\nversion = "1.0.0"\n')
  const configured = (patch, config) => {
    const root = parseCargoManifest(`[package]\nname = "app"\nversion = "0.1.0"\n\n[dependencies]\nx = "1"\n\n[patch.crates-io]\ny = { path = "y" }\n${patch}`)
    const options = { workspace: root, members: ['app 0.1.0'], ...(config === undefined ? {} : { config: parseCargoConfig(config) }) }
    return linkCargo(lock, { 'app 0.1.0': root, 'x 1.0.0': x }, options)
  }
  const resolved = (graph) => graph.packages['app 0.1.0'].dependencies[0].resolved

  it('reads the config\'s patch, as cargo does, and keeps the root\'s of other names', () => {
    assert.equal(resolved(configured('', ['[patch.crates-io]\nx = { path = "x" }\n'])), 'x 1.0.0')
    assert.throws(() => configured(''), refusedWith('app 0.1.0: the lockfile resolves "x" to none but "x 1.0.0", of another source or version: is it out of date, or [patch]ed by a config not given?'))
  })

  it('takes the config\'s entry before the root\'s of its name', () => {
    const strict = 'x = { path = "x", version = "=2.0.0" }\n'
    assert.throws(() => configured(strict), refusedWith('app 0.1.0: the lockfile resolves "x" to none but "x 1.0.0", of another source or version: is it out of date, or [patch]ed by a config not given?'))
    assert.equal(resolved(configured(strict, ['[patch.crates-io]\nx = { path = "x" }\n'])), 'x 1.0.0')
    assert.equal(resolved(configured('', ['[patch."https://github.com/rust-lang/crates.io-index"]\nx = { path = "x" }\n'])), 'x 1.0.0')
  })

  it('refuses a config\'s table and the root\'s at one source by two URLs, of which cargo would take either', () => {
    const config = ['[patch."https://github.com/rust-lang/crates.io-index/"]\nx = { path = "x" }\n']
    assert.throws(() => configured('', config), refusedWith('patch["crates-io"]: patches the source the config\'s [patch.https://github.com/rust-lang/crates.io-index/] does by another URL, and cargo would take either table'))
  })

  it('refuses an option it does not know', () => {
    assert.throws(() => linkCargo(lock, {}, { workspace: x, members: [], configs: [] }), { name: 'TypeError', message: 'unknown option "configs", of workspace, members, config' })
  })
})

describe('parseCargoConfig', () => {
  const patchOf = (...texts) => parseCargoConfig(texts).patch

  it('merges the configs as cargo does: tables key by key, the closer value first', () => {
    const merged = patchOf('[patch.crates-io]\nx = { path = "near" }\n', '[patch.crates-io]\nx = { path = "far", version = "1" }\ny = "2"\n')
    assert.deepEqual({ ...merged['crates-io'].x.source, version: merged['crates-io'].x.version }, { type: 'path', path: 'near', version: '1' })
    assert.equal(merged['crates-io'].y.version, '2')
  })

  it('looks into nothing but [patch]', () => {
    assert.deepEqual({ ...patchOf('[build]\ntarget = "x86_64-unknown-linux-gnu"\n\n[source.crates-io]\nreplace-with = "vendored"\n') }, {})
  })

  it('refuses a table under a value of another kind, and says which text is not TOML', () => {
    assert.throws(() => patchOf('[patch.crates-io]\nx = "1"\n', '[patch.crates-io]\nx = { path = "x" }\n'), refusedWith('patch["crates-io"].x: the string "1" in one config and a table in one under it, which cargo does not merge'))
    assert.throws(() => patchOf('', '[patch'), (error) => error instanceof TomlError && error.message.startsWith('texts[1]: '))
    assert.throws(() => parseCargoConfig('[patch]'), TypeError)
  })
})

describe('resolveCargoFeatures', () => {
  const graph = link()
  const build = (options) => resolveCargoFeatures(graph, { packages: ['app 0.1.0'], host: HOST, ...options })

  it('turns on what the build asks for, and what that asks for', () => {
    assert.deepEqual({ ...build() }, {
      'a 0.1.0': { normal: [], host: undefined },
      'app 0.1.0': { normal: [], host: undefined },
      [B1]: { normal: [], host: undefined },
      [B2]: { normal: ['fast'], host: undefined },
      [C]: { normal: [], host: undefined },
    })
  })

  it('leaves a weak feature waiting until something turns its dependency on', () => {
    assert.deepEqual(build({ features: ['extra'] })['a 0.1.0'].normal, ['extra'])
    assert.equal(build({ features: ['extra'] })['a 0.1.0'].normal.includes('b'), false)
  })

  // A proc-macro integration test of app, which only a dev build compiles,
  // and for the host, the library and what it depends on with it.
  it('builds for the host what only a proc-macro test of it pulls there, where dev targets are built', () => {
    const tested = link({ change: { 'app 0.1.0': `${MANIFESTS['app 0.1.0']}\n[[test]]\nname = "t"\nproc-macro = true\n` } })
    const hosted = (dev) => {
      const result = resolveCargoFeatures(tested, { packages: ['app 0.1.0'], host: HOST, dev })
      return [result['app 0.1.0'].host, result[B2].host]
    }
    assert.deepEqual(hosted(false), [undefined, undefined])
    assert.deepEqual(hosted(true), [[], ['fast']])
  })

  it('takes an empty list of targets as none: the host', () => {
    const b1 = 'b1 = { package = "b", version = "1" }\n'
    const unix = link({ change: { 'app 0.1.0': `${MANIFESTS['app 0.1.0'].replace(b1, '')}\n[target.'cfg(unix)'.dependencies]\n${b1}` } })
    const empty = resolveCargoFeatures(unix, { packages: ['app 0.1.0'], host: HOST, targets: [] })
    assert.deepEqual(empty, resolveCargoFeatures(unix, { packages: ['app 0.1.0'], host: HOST }))
    assert.deepEqual(empty[B1], { normal: [], host: undefined })
  })

  it('resolves the root package under resolver 1 whether built or not, and lists only what is built', () => {
    const v1 = link({ change: { 'app 0.1.0': MANIFESTS['app 0.1.0'].replace('edition = "2021"', 'edition = "2015"') } })
    assert.deepEqual({ ...resolveCargoFeatures(v1, { packages: ['a 0.1.0'], features: ['extra'], host: HOST }) }, { 'a 0.1.0': { normal: ['extra'], host: undefined } })
  })

  it('refuses a package built that depends on one package by two names, where the build turns both on', () => {
    const twice = (spec) => link({ change: { 'app 0.1.0': `${MANIFESTS['app 0.1.0']}bb = { package = "b", version = "2"${spec} }\n` } })
    const message = `app 0.1.0: depends on "${B2}" as both "b" and "bb", which cargo refuses to build`
    assert.throws(() => resolveCargoFeatures(twice(''), { packages: ['app 0.1.0'], host: HOST }), refusedWith(message))
    assert.equal(resolveCargoFeatures(twice(', optional = true'), { packages: ['app 0.1.0'], host: HOST })[B2].normal.length, 1)
    assert.throws(() => resolveCargoFeatures(twice(', optional = true'), { packages: ['app 0.1.0'], features: ['bb'], host: HOST }), refusedWith(message))
  })

  // c twice, for no platform and as a Windows dev-dependency, or a
  // build-dependency: only a test built for Windows depends on it, which a
  // proc-macro's is not, or the build script.
  it('refuses two names where only a test or a build script depends on the package, and not where no test built for that platform does', () => {
    const lock = LOCK.replace('dependencies = ["a", "b 1.0.0", "b 2.0.0"]', 'dependencies = ["a", "b 1.0.0", "b 2.0.0", "c"]')
    const deps = '\n[target.\'cfg(any())\'.dependencies]\ncc = { package = "c", version = "1" }\n\n[target.\'cfg(windows)\'.dev-dependencies]\ncd = { package = "c", version = "1" }\n'
    const windows = { packages: ['app 0.1.0'], host: HOST, targets: [{ name: 'x86_64-pc-windows-msvc', cfg: ['windows', 'target_os="windows"'] }] }
    const lib = link({ lock, change: { 'app 0.1.0': `${MANIFESTS['app 0.1.0']}${deps}` } })
    assert.equal(resolveCargoFeatures(lib, windows)['app 0.1.0'].normal.length, 0)
    assert.throws(() => resolveCargoFeatures(lib, { ...windows, dev: true }), refusedWith(`app 0.1.0: depends on "${C}" as both "cd" and "cc", which cargo refuses to build`))
    const macro = link({ lock, change: { 'app 0.1.0': `${MANIFESTS['app 0.1.0']}${deps}\n[lib]\nproc-macro = true\n` } })
    assert.equal(resolveCargoFeatures(macro, { ...windows, dev: true })['app 0.1.0'].host.length, 0)
    const script = link({ lock, change: { 'app 0.1.0': `${MANIFESTS['app 0.1.0']}${deps.replace("[target.'cfg(windows)'.dev-dependencies]", '[build-dependencies]')}` } })
    assert.throws(() => resolveCargoFeatures(script, { packages: ['app 0.1.0'], host: HOST }), refusedWith(`app 0.1.0: depends on "${C}" as both "cd" and "cc", which cargo refuses to build`))
  })

  const refused = [
    ['a feature no package selected has', { features: ['nope'] }, 'features: no package selected has "nope"'],
    ['dep: on the command line', { features: ['dep:b'] }, 'features: "dep:b": `dep:` is not taken on the command line'],
    ['two slashes', { features: ['b/x/y'] }, 'features: "b/x/y" has more than one "/"'],
    ['a package that is not a member', { packages: [C] }, `packages: "${C}" is not a member of the workspace`],
    ['a feature that turns on what the lockfile lacks', { features: ['b/slow'] }, `${B2}: the build turns on "d", which the lockfile does not resolve to one package, and cargo would anew`],
  ]
  for (const [title, options, message] of refused) {
    it(`refuses ${title}`, () => assert.throws(() => build(options), refusedWith(message)))
  }
})
