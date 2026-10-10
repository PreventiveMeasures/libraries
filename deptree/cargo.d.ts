// Hand-written against cargo.js; a change to either belongs with the other.

import type { NodeType, Vfs } from '@preventive/vfs'

export { LockfileError, TomlError } from '@preventive/lockfile/cargo.js'

// Where @preventive/upstream caches what it fetches, .crate files among
// them. Each .crate is fetched through it, and that is the one place
// anything here touches a filesystem. Before the network, it takes one from
// cargo's own cache -- each registry's under $CARGO_HOME/registry/cache, or
// ~/.cargo where that is unset -- where one there has the lockfile's
// checksum, and writes none of it; then from its own cache, where one is
// set, which is where it writes each .crate it fetches: setCacheDir() sets
// the default one, and setCacheDir(false) unsets it. Unset, which it is
// until set, it writes nothing. The project is read only through the view
// given as `project`, and the tree built in a Vfs.
export { setCacheDir } from '@preventive/upstream/npm.js'

// The machine cargo would vendor on: `cargo` is the version that vendors,
// exact, 1.94.0 to 1.99.x, which unpack a .crate alike, those from 1.97 on
// writing a `$comment` in each .cargo-checksum.json that those before do
// not; `os` as Node names it -- `linux`, `darwin`. Windows is refused:
// cargo unpacks and names files otherwise there.
export interface CargoHost {
  cargo: string
  os: string
}

// A view of the project's root, by paths from `/`: a Vfs, or anything with
// its readdir, lstat, stat and readFile, such as one of a directory on
// disk, of which only this is read: Cargo.lock; the Cargo.toml of every
// path package cargo reads, as below, and of each directory between one and
// the root, as cargo looks there for a workspace's root; the directories
// workspace.members takes; and .cargo/config, or else .cargo/config.toml.
// Each is read as UTF-8, and refused where it is not. A link where cargo
// looks for members, or at or on the way to any file it reads -- Cargo.lock,
// the config, a Cargo.toml -- is refused, so that nothing is read from
// outside the view. Each throws an error
// whose `code` is ENOENT, ENOTDIR or ELOOP for a path that leads nowhere.
// Nothing is written to it.
export interface CargoProject {
  readdir(path: string): string[]
  lstat(path: string): { type: NodeType }
  stat(path: string): { type: NodeType }
  readFile(path: string): Uint8Array
}

// The files `cargo vendor` reads, run at the project's root, which is taken
// to be the workspace's, with no workspace above it: Cargo.lock; the
// Cargo.toml of the root and of every other path package cargo reads; and
// the project's .cargo/config.toml, where there is one.
//
// The path packages are the members -- the root's package, each directory
// workspace.members takes and workspace.exclude does not, and each path
// dependency of a member that is in the root and not excluded -- and every
// other package cargo reads from a path: each path dependency of a member
// that is not one, each [patch] from a path, and each normal or build path
// dependency of those, which cargo resolves where it resolves their
// dev-dependencies for members alone. Each inherits from the root's
// [workspace] where cargo has it inherit: where it is in the root and not
// excluded, or its package.workspace points to the root.
//
// With `lockfile`, they are given as text: `manifests` by directory, `.`
// for the root and each other's path from it, with no `.`, `..` or empty
// segment; and `config`, where there is one. They stand for the project, so
// that a directory none of them is in is taken not to be there, and every
// one cargo reads has to be given, and none else. Without it, they are read
// from `project`, and none of them may be given. A refusal names each by
// its path from the root: `crates/a/Cargo.toml`.
//
// Of a workspace, what cargo reads otherwise than this is refused: a glob
// in workspace.members or default-members with a `**` or a `[`, a path in
// one of the three lists or in a manifest that is absolute, leads out of
// the project or has a `..` after a name; a package.workspace that points
// elsewhere than the root, or a root's at all; a [workspace] between a
// package and the root. What cargo refuses of one is refused too: a glob
// that takes nothing, a member with no Cargo.toml or with a [workspace] of
// its own, a root excluded from its own workspace, a default member that is
// no member, a path dependency or [patch] that leads to no package or to
// another of the name. Settings from anywhere else -- a config above the
// project or in cargo's home, the environment, the command line -- are not
// read, and are taken to be at their defaults. Of the config, [patch] is
// read, as cargo resolves with it; `paths` and `include` are refused; the
// rest is passed over, as it bears on where packages are fetched from and
// not on what is vendored: `cargo vendor` replaces no source unless told
// to with --respect-source-config.
//
// `vfs` is a Vfs to mount the tree into, at its root, which is taken to be
// the project's -- it may be `project` too; without one, a new Vfs holds
// the tree alone. A Vfs that holds a `vendor` at its root, or on macOS a
// name that is one there, is refused before anything is fetched: cargo
// would remove what is in it. Nothing there is written over: each
// directory the tree has is one there or is made, and every file is written
// where nothing is. The tree is built, and held to every check below,
// before any of it is written, so a refusal leaves the Vfs as it was.
export type CargoTreeOptions = CargoTreeGiven | CargoTreeRead

export interface CargoTreeGiven {
  lockfile: string
  manifests: Record<string, string> | Map<string, string>
  config?: string
  project?: undefined
  host: CargoHost
  vfs?: Vfs
}

export interface CargoTreeRead {
  lockfile?: undefined
  manifests?: undefined
  config?: undefined
  project: CargoProject
  host: CargoHost
  vfs?: Vfs
}

// What buildCargoTree counts, all of it plain numbers: `packages` the
// lockfile's; `vendored` those copied into vendor/, each a .crate fetched;
// `files` and `bytes` what is written, each .cargo-checksum.json among it.
export interface CargoTreeStats {
  packages: number
  vendored: number
  files: number
  bytes: number
}

// A package in the tree, as an SBOM would list it: `path` is its
// directory, from the project's root, which is `/` of the Vfs --
// vendor/<name>, or vendor/<name>-<version> for all but the greatest
// version of a name; `name`, `version` and `source` the lockfile's;
// `checksum` the hex sha256 its .crate is held to; `commit` the commit its
// .cargo_vcs_info.json names, as `cargo package` writes one where it packs
// from a git checkout, where that is a full commit id and the checkout was
// not dirty, and undefined elsewhere; `repository` and `homepage` those its
// Cargo.toml's [package] gives, as cargo packed it, each undefined where it
// gives none. All of it is the publisher's word, held to no repository.
export interface CargoInstalled {
  path: string
  name: string
  version: string
  source: string
  checksum: string
  commit: string | undefined
  repository: string | undefined
  homepage: string | undefined
}

// `vfs` is the one given, the tree mounted into it, or a new one.
// `installed` is each package vendored, in the lockfile's order.
export interface CargoTree {
  vfs: Vfs
  stats: CargoTreeStats
  installed: CargoInstalled[]
}

// The vendor directory `cargo vendor` makes from the lockfile, with
// host.cargo and none of its options, in a project with no vendor directory
// yet: rooted at the project's root, it holds vendor/<directory> for each
// package of the lockfile but a path one, and nothing else of the project;
// none at all where every package is a path one. Each package's directory
// is its name, or `<name>-<version>` for all but the greatest version of
// that name, by the semver crate's order. What cargo writes or prints
// beside it -- the config that reads from it, the lockfile again -- is not
// written.
//
// The lockfile is held to the manifests, as cargo would resolve anew one
// that is out of date with them and vendor what that comes to: every
// package's, a vendored one's from its .crate, laid over it with
// @preventive/lockfile/cargo.js's linkCargo, with what that refuses, and
// each path dependency to the package in the directory it leads to. Every
// path package of the lockfile has to be one cargo reads, and every member
// one of the lockfile's.
//
// Each .crate is fetched from crates.io and held to the lockfile's checksum,
// its sha256. It is unpacked as cargo unpacks it into vendor/: every entry
// under the directory `<name>-<version>`, that directory taken off; of what
// is under it, anything under a `.git`, a .gitattributes or .gitignore,
// and a .cargo-ok, passed over, and a directory none but such entries are
// in not made. Each directory is 0o755, or its own entry's mode where it has
// one; each file its mode within 0o777; both as a umask of 0o022 leaves
// them. Each directory then gets a .cargo-checksum.json, 0o644, as cargo
// writes it: the sha256 of each file and of the .crate, as serde_json
// writes them.
//
// What the archive readers refuse is refused: @preventive/archive's
// compression.js and tar.js refuse a name with a backslash, a control or
// formatting character, an empty or `..` segment, or a drive letter, two
// entries of one name that differ, an entry inside one that is not a
// directory, a sparse entry -- where cargo would take some of it. What cargo
// reads otherwise than the readers is refused:
// a .crate of more than one gzip member, of which cargo reads the first
// alone; a gzip header CRC or reserved flag; a pax size, which cargo 1.94.0
// reads otherwise. What cargo refuses or fails on is refused: a .crate that
// unpacks to more than 512 MiB, or twenty times its size where that is
// more; an entry not under `<name>-<version>`, an entry not a file or
// directory, a .crate's own .cargo-checksum.json, which cargo lists and
// writes over so that it cannot build from it. So is what cargo fails on or
// reads otherwise as any user but root: a file whose mode lacks the owner's
// read, which cargo cannot checksum; a directory with anything in it whose
// mode lacks the owner's read or search, whose files cargo leaves out of
// .cargo-checksum.json; and one whose mode lacks the owner's write where
// anything is written into it after its own entry, as .cargo-checksum.json
// always is into the package's. A directory with nothing in it may have any
// mode. On macOS, two names in one directory that differ only in case
// or normalization are refused, as they would be one name there.
//
// Packages come from crates.io alone: one from git, which cargo vendor
// checks out with git, or from another registry, is refused.
//
// Nothing is left to a guess: a lockfile or manifest the lockfile reader
// refuses, a workspace this does not read as cargo reads it, a package from
// anywhere but crates.io, a check above that fails -- each is refused with a
// DeptreeError, a LockfileError or a TomlError that says where. A TypeError
// is thrown for options of the wrong type.
export function buildCargoTree(options: CargoTreeOptions): Promise<CargoTree>

// `where` is what a refusal is about -- `crates/a/Cargo.toml`,
// `packages["serde 1.0.0 (registry+...)"]`, an entry of a .crate -- or
// undefined for the call as a whole; the message leads with it. `cause` is
// what a package beneath refused with, where one did.
export class DeptreeError extends Error {
  constructor(detail: string, where?: string, options?: { cause?: unknown })
  where: string | undefined
}
