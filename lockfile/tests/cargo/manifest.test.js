import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { LockfileError, parseCargoManifest } from '../../cargo.js'

// A workspace root with a package of its own, and a member that inherits
// from it, with a dependency of every source and kind; then one edit at a
// time, each of which is refused with a message that says where and why.

const ROOT = `[package]
name = "app"
version = "0.1.0"
edition = "2021"

[workspace]
members = ["crates/*"]
exclude = ["crates/old"]

[workspace.package]
version = "0.2.0"
edition = "2024"
license = "MIT"

[workspace.dependencies]
serde = { version = "1", default-features = false, features = ["alloc"] }
log = "0.4"

[features]
default = ["std"]
std = ["serde/std", "memchr?/std"]
json = ["dep:serde_json"]

[dependencies]
serde = { workspace = true, features = ["derive"] }
serde_json = { version = "1", optional = true }
memchr = { version = "2", optional = true }
itoa04 = { package = "itoa", version = "0.4" }
regex = { git = "https://github.com/rust-lang/regex", tag = "1.0.0" }
lib = { path = "crates/lib", version = "0.2" }
private = { version = "1", registry = "corp" }

[target.'cfg(unix)'.dependencies]
libc = "0.2"

[build-dependencies]
cc = "1"

[dev-dependencies]
log = { workspace = true }

[lib]
proc-macro = true

[patch.crates-io]
serde = { git = "https://github.com/serde-rs/serde", branch = "master" }

[profile.release]
lto = true
`

const MEMBER = `[package]
name = "lib"
version.workspace = true
edition.workspace = true
license.workspace = true

[dependencies]
serde = { workspace = true, optional = true, default-features = true }
log = { workspace = true, features = ["std"] }
`

const edit = (text, from, to) => {
  assert.ok(text.includes(from), from)
  return text.replace(from, to)
}

describe('parseCargoManifest', () => {
  const root = parseCargoManifest(ROOT)

  it('reads a package: name, version, edition, proc-macro', () => {
    const { name, version, edition, resolver, procMacro, procMacroTarget } = root.package
    assert.deepEqual({ name, version, edition, resolver, procMacro, procMacroTarget }, { name: 'app', version: '0.1.0', edition: '2021', resolver: undefined, procMacro: true, procMacroTarget: true })
  })

  it('reads the feature map, an implicit feature for an optional dependency among it', () => {
    assert.deepEqual({ ...root.package.features }, { default: ['std'], std: ['serde/std', 'memchr?/std'], json: ['dep:serde_json'], memchr: ['dep:memchr'] })
  })

  it('reads each dependency, with its source, kind and platform', () => {
    const deps = Object.fromEntries(root.package.dependencies.map((dep) => [`${dep.kind} ${dep.name}`, dep]))
    assert.deepEqual(Object.keys(deps), [
      'normal serde', 'normal serde_json', 'normal memchr', 'normal itoa04', 'normal regex', 'normal lib', 'normal private', 'dev log', 'build cc', 'normal libc',
    ])
    assert.deepEqual(deps['normal serde'], {
      name: 'serde', kind: 'normal', target: undefined, package: 'serde', version: '1', optional: false, defaultFeatures: false,
      features: ['alloc', 'derive'], source: { type: 'registry', registry: undefined, index: undefined }, inherited: true,
    })
    assert.equal(deps['normal itoa04'].package, 'itoa')
    assert.deepEqual(deps['normal regex'].source, { type: 'git', url: 'https://github.com/rust-lang/regex', branch: undefined, tag: '1.0.0', rev: undefined })
    assert.deepEqual(deps['normal lib'].source, { type: 'path', path: 'crates/lib' })
    assert.deepEqual(deps['normal private'].source, { type: 'registry', registry: 'corp', index: undefined })
    assert.equal(deps['normal libc'].target, "cfg(unix)")
  })

  it('reads [workspace] and [patch]', () => {
    assert.deepEqual(root.workspace.members, ['crates/*'])
    assert.equal(root.workspace.dependencies.log.version, '0.4')
    assert.equal(root.patch['crates-io'].serde.source.branch, 'master')
  })

  it('inherits fields and dependencies from the root', () => {
    const member = parseCargoManifest(MEMBER, root)
    assert.equal(member.package.version, '0.2.0')
    assert.equal(member.package.edition, '2024')
    const [serde, log] = member.package.dependencies
    assert.deepEqual([serde.optional, serde.defaultFeatures, serde.features], [true, true, ['alloc']])
    assert.deepEqual(log.features, ['std'])
    assert.deepEqual({ ...member.package.features }, { serde: ['dep:serde'] })
  })

  it('reads a virtual manifest', () => {
    const virtual = parseCargoManifest('[workspace]\nmembers = ["a"]\nresolver = "2"\n')
    assert.deepEqual([virtual.package, virtual.workspace.resolver], [undefined, 2])
  })

  it('reads a package with no version as 0.0.0', () => {
    assert.equal(parseCargoManifest('[package]\nname = "a"\npublish = false\n').package.version, '0.0.0')
  })

  // lib at crates/lib, and again for unix: by other words, or by a path that
  // climbs out of the directory, which may lead back into it.
  it('takes a path that leads to the same place, or may, as the same source', () => {
    for (const path of ['./crates//lib/', 'crates/x/../lib', '../root/crates/lib', '/root/crates/lib']) {
      const pkg = parseCargoManifest(edit(ROOT, 'libc = "0.2"', `lib = { path = "${path}", version = "0.2" }`)).package
      assert.equal(pkg.dependencies.filter((dep) => dep.name === 'lib').length, 2)
    }
    // `..` stops at `/`: from /app, both are /lib.
    const shallow = parseCargoManifest(edit(edit(ROOT, 'path = "crates/lib"', 'path = "../lib"'), 'libc = "0.2"', 'lib = { path = "../../lib", version = "0.2" }')).package
    assert.equal(shallow.dependencies.filter((dep) => dep.name === 'lib').length, 2)
  })

  // util at crates/util of the root, inherited by crates/m, and again for
  // unix from crates/m.
  it('reads an inherited path from the workspace root', () => {
    const utilRoot = parseCargoManifest('[workspace]\nmembers = ["crates/*"]\n\n[workspace.dependencies]\nutil = { path = "crates/util" }\n')
    const member = (path) => `[package]\nname = "m"\nversion = "0.1.0"\n\n[dependencies]\nutil = { workspace = true }\n\n[target.'cfg(unix)'.dependencies]\nutil = { path = "${path}" }\n`
    assert.equal(parseCargoManifest(member('../util'), utilRoot).package.dependencies.length, 2)
    const message = 'target["cfg(unix)"].dependencies.util: "util" is given another source elsewhere, which cargo refuses'
    assert.throws(() => parseCargoManifest(member('../other'), utilRoot), (error) => error instanceof LockfileError && error.message === message)
  })

  // Cargo builds the library for the host by the flag where both are given,
  // and by the crate type alone only where the flag is not.
  it('reads a proc-macro by the flag before the crate type', () => {
    const lib = (text) => parseCargoManifest(`[package]\nname = "m"\nversion = "0.1.0"\n\n[lib]\n${text}\n`).package.procMacro
    assert.deepEqual(['proc-macro = false\ncrate-type = ["proc-macro"]', 'proc-macro = true\ncrate-type = ["lib"]', 'crate-type = ["proc-macro"]', 'crate-type = ["lib"]'].map(lib), [false, true, true, false])
  })

  it('throws a TypeError for a root that is not one', () => {
    assert.throws(() => parseCargoManifest(MEMBER, parseCargoManifest('[package]\nname = "a"\n')), TypeError)
  })

  const refused = [
    ['cargo-features', `cargo-features = ["edition2027"]\n${ROOT}`, '["cargo-features"]: cargo-features, which only a nightly cargo reads, is not supported'],
    ['[replace]', `${ROOT}\n[replace]\n"foo:0.1.0" = { path = "x" }\n`, 'replace: [replace] is not supported'],
    ['a key cargo does not know', `${ROOT}\n[extra]\n`, 'unsupported key "extra"'],
    ['a package key cargo does not know', edit(ROOT, 'edition = "2021"', 'edition = "2021"\nauthor = "x"'), 'package: unsupported key "author"'],
    ['a nightly package key', edit(ROOT, 'edition = "2021"', 'edition = "2021"\nforced-target = "x"'), 'package["forced-target"]: a per-package target, which only a nightly cargo reads, is not supported'],
    ['an edition that is not one', edit(ROOT, 'edition = "2021"', 'edition = "2027"'), 'package.edition: "2027" is not an edition: expected one of 2015, 2018, 2021, 2024'],
    ['a resolver that is not one', edit(ROOT, 'members = ["crates/*"]', 'members = ["crates/*"]\nresolver = "4"'), 'workspace.resolver: "4" is not a resolver: expected "1", "2" or "3"'],
    ['a resolver in [package] and [workspace]', edit(edit(ROOT, 'members = ["crates/*"]', 'members = ["crates/*"]\nresolver = "2"'), 'edition = "2021"', 'edition = "2021"\nresolver = "2"'), 'package.resolver: `resolver` is given in [workspace] too'],
    ['a root that names another root', edit(ROOT, 'edition = "2021"', 'edition = "2021"\nworkspace = ".."'), 'package.workspace: a workspace root names no other root'],
    ['[project] beside [package]', `${ROOT}\n[project]\nname = "b"\n`, 'project: [project] beside [package]'],
    ['an underscore key in the 2024 edition', edit(ROOT, '[build-dependencies]\ncc = "1"', '[build_dependencies]\ncc = "1"').replace('edition = "2021"', 'edition = "2024"'), 'build_dependencies: not supported in the 2024 edition: use "build-dependencies"'],
    ['an underscore key beside its dashed one', `${ROOT}\n[dev_dependencies]\nx = "1"\n`, 'dev_dependencies: given beside "dev-dependencies"'],
    ['a dependency with no source', edit(ROOT, 'cc = "1"', 'cc = { features = ["x"] }'), '["build-dependencies"].cc: names no version, path or git repository'],
    ['git and path both', edit(ROOT, 'tag = "1.0.0"', 'tag = "1.0.0", path = "x"'), 'dependencies.regex: ambiguous: only one of `git` or `path` is taken'],
    ['git and a registry both', edit(ROOT, 'tag = "1.0.0"', 'tag = "1.0.0", registry = "corp"'), 'dependencies.regex: ambiguous: only one of `git` or a registry is taken'],
    ['a tag and a branch both', edit(ROOT, 'tag = "1.0.0"', 'tag = "1.0.0", branch = "main"'), 'dependencies.regex: ambiguous: only one of `branch`, `tag` or `rev` is taken'],
    ['a branch without git', edit(ROOT, 'cc = "1"', 'cc = { version = "1", branch = "main" }'), '["build-dependencies"].cc.branch: `branch` is only for a git dependency'],
    ['a git URL with a fragment', edit(ROOT, 'regex", tag', 'regex#abc", tag'), 'dependencies.regex.git: "https://github.com/rust-lang/regex#abc" has a query or a fragment, which cargo drops or misreads'],
    ['a version requirement cargo refuses', edit(ROOT, 'cc = "1"', 'cc = ">=1 <2"'), '["build-dependencies"].cc: ">=1 <2" is not a version requirement: unexpected "<"'],
    ['a dependency key it does not know', edit(ROOT, 'cc = "1"', 'cc = { version = "1", vesion = "2" }'), '["build-dependencies"].cc: unsupported key "vesion"'],
    ['an artifact dependency', edit(ROOT, 'cc = "1"', 'cc = { version = "1", artifact = "bin" }'), '["build-dependencies"].cc.artifact: an artifact dependency, which only a nightly cargo reads, is not supported'],
    ['a path base', edit(ROOT, 'cc = "1"', 'cc = { path = "cc", base = "b" }'), '["build-dependencies"].cc.base: a path base, which only a nightly cargo reads, is not supported'],
    ['a feature naming another package', edit(ROOT, 'cc = "1"', 'cc = { version = "1", features = ["x/y"] }'), '["build-dependencies"].cc.features[0]: "x/y": a dependency\'s feature cannot name another\'s'],
    ['a dependency feature with dep:', edit(ROOT, 'cc = "1"', 'cc = { version = "1", features = ["dep:y"] }'), '["build-dependencies"].cc.features[0]: "dep:y": a dependency\'s feature cannot be `dep:`'],
    ['an optional dev-dependency', edit(ROOT, 'log = { workspace = true }', 'log = { workspace = true, optional = true }'), '["dev-dependencies"].log: a dev-dependency cannot be optional'],
    ['two sources for one name', edit(ROOT, 'libc = "0.2"', 'itoa04 = { package = "itoa", git = "https://example.com/itoa" }'), 'target["cfg(unix)"].dependencies.itoa04: "itoa04" is given another source elsewhere, which cargo refuses'],
    ['two paths for one name', edit(ROOT, 'libc = "0.2"', 'lib = { path = "crates/other", version = "0.2" }'), 'target["cfg(unix)"].dependencies.lib: "lib" is given another source elsewhere, which cargo refuses'],
    ['a path that climbs out and cannot come back to the other', edit(ROOT, 'libc = "0.2"', 'lib = { path = "../crates/other", version = "0.2" }'), 'target["cfg(unix)"].dependencies.lib: "lib" is given another source elsewhere, which cargo refuses'],
    ['a platform that is neither', edit(ROOT, "[target.'cfg(unix)'.dependencies]", "[target.'cfg(unix'.dependencies]"), 'target["cfg(unix"]: "cfg(unix" is neither a target\'s name nor cfg(…)'],
    ['a cfg expression cargo refuses', edit(ROOT, "[target.'cfg(unix)'.dependencies]", "[target.'cfg(not(a, b))'.dependencies]"), 'target["cfg(not(a, b))"]: "not(a, b)" is not a cfg expression: expected ")"'],
    ['inheriting with no root given', MEMBER, 'package.edition: inherits from a workspace, and no workspace root is given'],
    ['inheriting what the root does not have', edit(MEMBER, 'license.workspace = true', 'readme.workspace = true'), 'package.readme: workspace.package.readme is not given'],
    ['inheriting a dependency the root does not have', edit(MEMBER, 'log = {', 'rand = {'), 'dependencies.rand: "rand" is not in [workspace.dependencies]'],
    ['an inherited dependency with a version', edit(MEMBER, 'features = ["std"] }', 'version = "1" }'), 'dependencies.log: unsupported key "version"'],
    ['`workspace = false`', edit(MEMBER, 'log = { workspace = true, features = ["std"] }', 'log = { workspace = false }'), 'dependencies.log.workspace: expected true, found the boolean false'],
    ['an optional workspace dependency', edit(ROOT, 'log = "0.4"', 'log = { version = "0.4", optional = true }'), 'workspace.dependencies.log: a workspace dependency cannot be optional'],
    ['a feature naming nothing', edit(ROOT, 'json = ["dep:serde_json"]', 'json = ["dep:serde_json", "yaml"]'), 'features.json: "yaml" is neither a feature nor a dependency'],
    ['a feature naming a required dependency', edit(ROOT, 'json = ["dep:serde_json"]', 'json = ["dep:serde_json", "regex"]'), 'features.json: "regex" is a dependency, but not an optional one'],
    ['a feature naming a hidden optional dependency', edit(ROOT, 'json = ["dep:serde_json"]', 'json = ["dep:serde_json", "serde_json"]'), 'features.json: "serde_json" is an optional dependency with no feature of its name: use "dep:serde_json"'],
    ['dep: of a required dependency', edit(ROOT, 'json = ["dep:serde_json"]', 'json = ["dep:serde_json", "dep:regex"]'), 'features.json: "dep:regex" names "regex", which is not an optional dependency'],
    ['? on a required dependency', edit(ROOT, 'json = ["dep:serde_json"]', 'json = ["dep:serde_json", "regex?/std"]'), 'features.json: "regex?/std" names "regex", which is not an optional dependency'],
    ['dep: with /', edit(ROOT, 'json = ["dep:serde_json"]', 'json = ["dep:serde_json/std"]'), 'features.json: "dep:serde_json/std" has both "dep:" and "/"'],
    ['two slashes', edit(ROOT, 'json = ["dep:serde_json"]', 'json = ["dep:serde_json", "serde/a/b"]'), 'features.json: "serde/a/b" has more than one "/"'],
    ['a feature name cargo refuses', edit(ROOT, 'json = ["dep:serde_json"]', 'json = ["dep:serde_json"]\n"a b" = []'), 'features["a b"]: "a b" is not a feature name'],
    ['an optional dependency in no feature', edit(ROOT, 'json = ["dep:serde_json"]', 'serde_json = []'), 'features: optional dependency "serde_json" is in no feature: add "dep:serde_json" to one'],
    ['a proc-macro crate type beside another', edit(ROOT, 'proc-macro = true', 'crate-type = ["proc-macro", "rlib"]'), 'lib["crate-type"]: a proc-macro crate type is taken alone'],
    ['publish = true without a version', '[package]\nname = "a"\npublish = true\n', 'package.publish: `publish` needs a `version`'],
    ['a virtual manifest with dependencies', '[workspace]\n\n[dependencies]\na = "1"\n', 'dependencies: a virtual manifest has no package for it'],
    ['a manifest with neither package nor workspace', '[dependencies]\na = "1"\n', 'neither [package] nor [workspace]'],
    ['a root read as another\'s member', ROOT, 'workspace: a workspace root inherits from its own [workspace], not another'],
  ]
  for (const [title, text, message] of refused) {
    it(`refuses ${title}`, () => {
      const workspace = title === 'a root read as another\'s member' || title.startsWith('inheriting what') || title.startsWith('inheriting a dep') || title.startsWith('an inherited') || title === '`workspace = false`' ? root : undefined
      assert.throws(() => parseCargoManifest(text, workspace), (error) => error instanceof LockfileError && error.message === message)
    })
  }
})
