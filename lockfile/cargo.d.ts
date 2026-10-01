// Hand-written against cargo.js; a change to either belongs with the other.

export { LockfileError } from './pnpm.js'
export { TomlError } from './toml.js'

// Nothing here reads a filesystem: each function takes texts, or what
// another made of them, and the caller reads the files. Throws a TypeError
// for anything but what it takes, a TomlError where a text is not the TOML
// cargo writes, and a LockfileError where it is but is not read here, or
// would be read two ways: `where` says where, and the message what.
//
// Every Record below has a null prototype, and is in the order the file
// has it. A package goes by its key: `name version` for a path package,
// `name version (source)` for any other, as a Cargo.lock names it in full.

// Reads a Cargo.lock of `version = 3` or `version = 4`, as cargo 1.53 and
// later write it. Anything else is refused: 1 and 2, which have no
// `version`, and 5, which only a nightly cargo reads; a field this reader
// does not know, [metadata], [root], `replace`; a source other than a
// registry, a sparse registry or git at a commit.
//
// So is a lockfile that could be read two ways, where cargo would pick one
// or drop an edge: a package listed twice, one version of one package from
// two sources cargo holds the same, a dependency that names no package or
// could be any of two, one no path package reaches.
export function parseCargoLock(text: string): CargoLockfile

export interface CargoLockfile {
  version: 3 | 4
  packages: Record<string, CargoLockPackage>
  // [[patch.unused]]: what the workspace's [patch] offers that nothing takes.
  unusedPatches: { name: string, version: string, source: string | undefined, checksum: string | undefined }[]
}

export interface CargoLockPackage {
  name: string
  // SemVer, exactly.
  version: string
  // `registry+URL`, `sparse+URL`, or `git+URL`, `?branch=`, `?tag=` or
  // `?rev=` and what was asked for, and `#` and the commit; undefined for a
  // path package, which is in the workspace or a path dependency of it.
  source: string | undefined
  // The sha256 of a registry package's .crate, where the registry has one.
  checksum: string | undefined
  // The keys of the packages it depends on, of every kind and platform.
  dependencies: string[]
}

// Reads a Cargo.toml for what resolution takes of it. `workspace` is the
// workspace root's manifest, read before, for a member that inherits from
// it (`version.workspace = true`, `serde = { workspace = true }`); a root
// inherits from its own [workspace].
//
// What cargo reads and this does not is refused by name: cargo-features,
// [replace], artifact dependencies, path bases, anything only a nightly
// cargo takes. So is a key cargo does not know, which it warns of and
// drops, and whatever cargo refuses of a manifest that can be told without
// a filesystem: a feature naming nothing, a dependency with two sources, an
// optional dev-dependency, `links` with `build = false`. Sections that bear
// on no dependency or feature — [badges], [lints], [profile], [[bin]],
// metadata — are not looked into.
export function parseCargoManifest(text: string, workspace?: CargoManifest): CargoManifest

export interface CargoManifest {
  // Undefined for a virtual manifest, which has only [workspace].
  package: CargoPackage | undefined
  workspace: CargoWorkspace | undefined
  // [patch.<registry or URL>], by the name each is patched under.
  patch: Record<string, Record<string, CargoDependencySpec>>
}

export interface CargoPackage {
  name: string
  // `0.0.0` where none is given.
  version: string
  edition: '2015' | '2018' | '2021' | '2024'
  // As [package] gives it; the workspace root's decides.
  resolver: 1 | 2 | 3 | undefined
  // The native library it links, which no other package of one graph may.
  links: string | undefined
  // Cargo's feature map: the [features] table, as written, and a feature
  // for each optional dependency that no `dep:` names and no feature is
  // named after, which turns it on (`name = ["dep:name"]`).
  features: Record<string, string[]>
  // Of every kind and platform, each with the features it asks for.
  dependencies: CargoDependency[]
  // Whether its library is a proc-macro, and whether any target is.
  procMacro: boolean
  procMacroTarget: boolean
}

// What one entry of a dependency table says.
export interface CargoDependencySpec {
  // The package's name: `package = ...`, or the entry's name.
  package: string
  // The version requirement, as written; cargo's semver rules read it.
  version: string | undefined
  source: CargoSource
  optional: boolean
  defaultFeatures: boolean
  features: string[]
}

// crates.io is `registry` with neither a registry nor an index named. A
// path is as written, relative to the manifest's directory, or the
// workspace root's where the dependency is inherited.
export type CargoSource =
  | { type: 'registry', registry: string | undefined, index: string | undefined }
  | { type: 'git', url: string, branch: string | undefined, tag: string | undefined, rev: string | undefined }
  | { type: 'path', path: string }

export interface CargoDependency extends CargoDependencySpec {
  // The name the package goes by here, which features name it by.
  name: string
  kind: 'normal' | 'dev' | 'build'
  // The platform of its [target.<platform>] table, as written: a target's
  // name or `cfg(...)`.
  target: string | undefined
  // From [workspace.dependencies], with this entry's features added.
  inherited: boolean
}

export interface CargoWorkspace {
  members: string[]
  exclude: string[]
  defaultMembers: string[] | undefined
  resolver: 1 | 2 | 3 | undefined
  // [workspace.package], as written, for members to inherit.
  package: Record<string, unknown>
  dependencies: Record<string, CargoDependencySpec>
}

// Which vendored copy is which package, as a directory source finds it: by
// the name and version in its Cargo.toml, not by the directory's name, so
// `rand` may hold 0.8.5 and `rand-0.7.3` the other, or the other way
// around. `vendor` is by directory: every one cargo reads, which is every
// one not starting with `.` that holds a Cargo.toml, with the texts of that
// Cargo.toml and of its `.cargo-checksum.json`.
//
// Every package of the lockfile but a path one has to be there, with the
// lockfile's checksum, as cargo checks. Two directories holding one
// version of one package are refused, as cargo would read either. More
// directories than the lockfile needs are not: `cargo vendor --sync` fills
// one for several lockfiles.
//
// The copy a dependent uses: the dependency's `resolved` key in the graph
// linkCargo gives, and that key here.
export function readCargoVendor(lock: CargoLockfile, vendor: Record<string, { manifest: string, checksum: string }>): Record<string, CargoVendored>

export interface CargoVendored {
  directory: string
  // The sha256 of each file, by its path within the directory, which cargo
  // checks the files against before it builds from them.
  files: Record<string, string>
}

// The lockfile's graph with each package's manifest laid over it: every
// dependency declared, with the package the lockfile resolves it to.
// `manifests` is by key, one for every package of the lockfile: a
// member's own, a vendored package's from its directory. `workspace` is
// the root's manifest; `members` the keys of the members, which the
// lockfile resolves with every feature on, dev-dependencies and all.
//
// Cargo ties a declaration to a package by name, version requirement and
// source, [patch] aside; so does this, and refuses a declaration two
// packages could be, one the lockfile does not resolve where cargo's
// resolver would, an edge no declaration is, a package no member depends
// on, directly or not, a [patch] it has no package of, used or unused: a
// lockfile out of date with its manifests. So is what cargo refuses: two
// members of one name, two packages linking one native library, a feature
// a declaration asks of a package that has no such feature, a [patch]
// whose location has no version its requirement takes, a [patch] from the
// source it patches. And, as cargo would read either, two [patch] tables
// for one source by URLs that differ but for being canonical; of two at
// one URL, `crates-io` and crates.io's index, the later by key is read, as
// cargo reads it.
export function linkCargo(lock: CargoLockfile, manifests: Record<string, CargoManifest>, options: { workspace: CargoManifest, members: string[] }): CargoGraph

export interface CargoGraph {
  // The workspace's: [workspace] resolver, the root package's, or its
  // edition's (1 before 2021, 2 for 2021, 3 for 2024); 1 for a virtual
  // workspace that names none.
  resolver: 1 | 2 | 3
  // The root package's key; undefined for a virtual workspace.
  root: string | undefined
  members: string[]
  packages: Record<string, CargoGraphPackage>
}

export interface CargoGraphPackage {
  name: string
  version: string
  source: string | undefined
  checksum: string | undefined
  manifest: CargoPackage
  dependencies: CargoLinkedDependency[]
}

export interface CargoLinkedDependency extends CargoDependency {
  // The key of the package it is: the one package among the lockfile's
  // edges from this one it could be, which cargo keeps to when a build
  // turns it on. Undefined where there is none or more than one, and for a
  // dev-dependency of a package outside the workspace, which no build has.
  resolved: string | undefined
  // Whether the lockfile has it: whether cargo's resolve, every member's
  // every feature on, turns it on. An optional dependency nothing turns on
  // is not; the lockfile's edges are the active dependencies'.
  active: boolean
}

// The features a build turns on, by cargo's feature resolver: what
// `cargo build` with these flags compiles each package with, for each way
// it compiles it, for the host (build scripts, proc-macros and what they
// depend on) or for the target. Resolver 2 and 3 give the two their own
// features, and turn on nothing for a platform not built for or for
// dev-dependencies where no dev target is built; resolver 1 unifies all of
// it, so one package has one set of features, both ways and every way.
//
// A package is listed as cargo's unit graph reaches it, but for what only a
// filesystem tells, which targets a package has: a proc-macro member, and
// what it depends on, is listed for the target too, in case it has more
// targets than its library; a member with a proc-macro example, test or
// bench for the host too where dev targets are built, though `cargo test`
// builds no bench; a build-dependency, though the package may have
// no build script; and what a member depends on, though it may have no
// library or binary for `cargo build` to build. So is a build-dependency
// that a package built for the target turns on and the same package built
// for the host does not: where the two have the same features, cargo gives
// them one build script, with the dependencies of whichever it comes to
// first.
//
// Refused, as cargo refuses to build it: a crate listed, but for a
// proc-macro member for the target and what only that reaches, that depends
// on one package by two names, `-` read as `_`, where the build turns both
// on, of any kind or platform.
export function resolveCargoFeatures(graph: CargoGraph, build: CargoBuild): Record<string, { normal: string[] | undefined, host: string[] | undefined }>

// The host is what `rustc -vV` calls it and `rustc --print cfg` prints for
// it; each target, each `--target` likewise, is the host alone where none
// is given or the list is empty. Targets `'all'` read every platform at
// once, as `cargo metadata` and `cargo tree --target all` do, and need no
// host.
export type CargoBuild = CargoCommand & (
  | { host: CargoPlatform, targets?: CargoPlatform[] }
  | { host?: CargoPlatform, targets: 'all' }
)

export interface CargoCommand {
  // `-p`: the keys of the members built; all of graph.members for
  // `--workspace`.
  packages: string[]
  // `--features`, `--all-features`, `--no-default-features`, as given:
  // cargo's rules hand them out among the members.
  features?: string[]
  allFeatures?: boolean
  noDefaultFeatures?: boolean
  // Resolver 1 with a root package gives `--features` to the member cargo
  // runs in: its key. The root package where none is given. It is resolved,
  // and its features unified with the rest, whether it is built or not.
  current?: string
  // Whether a dev target is built: `cargo test`, `--all-targets`.
  dev?: boolean
}

export interface CargoPlatform {
  name: string
  cfg: string[]
}
