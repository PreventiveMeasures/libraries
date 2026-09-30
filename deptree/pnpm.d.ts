// Hand-written against pnpm.js; a change to either belongs with the other.

import type { Vfs } from '@preventive/vfs'

export { LockfileError, YamlError } from '@preventive/lockfile/pnpm.js'

// Where @preventive/upstream caches what it fetches, tarballs among them.
// Unset, which it is by default, nothing is cached and nothing is written:
// tarballs are fetched every time, each once for however many snapshots it
// has. It is the one place anything here touches a filesystem.
export { setCacheDir } from '@preventive/upstream/npm.js'

// The machine pnpm would install on, which a tree depends on: `pnpm` is
// the version that installs, and has to be a 10.x or an 11.x, the two
// built for, each as it differs from the other; `node` the Node it runs
// on, unless the settings name a nodeVersion or, for pnpm 11, the root
// package.json's engines.runtime pins one;
// `os`, `cpu` and `libc` as Node and pnpm name them — `linux`, `x64`,
// `glibc` — with `unknown` for a libc outside Linux, as pnpm has it.
// Windows is refused: pnpm links there with junctions to absolute paths.
// An optional package the machine cannot run is left out, as pnpm leaves
// it out; supportedArchitectures in the settings widens what is taken.
export interface PnpmHost {
  pnpm: string
  node: string
  os: string
  cpu: string
  libc: 'glibc' | 'musl' | 'unknown'
}

// The files an install reads, as text: pnpm-lock.yaml; the package.json
// of every project it installs, by the project's directory relative to the
// lockfile's (`.` for the root, then as its importers are keyed); pnpm-
// workspace.yaml and the .npmrc, where there are any; and every patch file
// the settings' patchedDependencies name, by the path from the lockfile's
// directory they name it by. Settings from anywhere else — another
// .npmrc, the environment, the command line — are not read, and are taken
// to be at their defaults.
//
// A workspace is one lockfile for several projects, each a package.json:
// the root, and every directory pnpm-workspace.yaml's `packages` globs
// take, as pnpm globs for them — `*` and `**`, a leading `!` to leave out,
// and no other glob syntax. Without `packages` the root is the only
// project. Every importer has to have its package.json given, and be a
// project those globs take; and every project pnpm would find has to be
// given, which buildPnpmTree cannot check, as it is not given the
// directories: findPnpmProjects finds them in those. A project the
// lockfile has no importer for is held to an empty one, as pnpm holds it:
// with no dependencies it is installed, and hoisted by its name, and with
// any it is refused as not up to date. Its directory has to be given as
// pnpm would key its importer: from the lockfile's, in normal form.
//
// Each project is held to its importer as --frozen-lockfile holds it: its
// dependencies, devDependencies, optionalDependencies and, with
// autoInstallPeers, the peers it lists nowhere else, have to be what the
// importer records, and in the ranges they ask for. The projects' names
// are what hoistWorkspacePackages hoists them by.
//
// Settings are read as `pnpm install` 10 reads them, each source over the
// one before: the .npmrc, then pnpm-workspace.yaml, then what the
// package.json's `pnpm` field sets, which pnpm's install spreads over the
// rest. Overrides are the package.json's Yarn-style `resolutions` and
// `pnpm.overrides`, the second winning a selector both name; only where
// those name none are pnpm-workspace.yaml's `overrides` read. `$name` in
// one is the root package.json's own specifier for `name`, and
// `catalog:` what the workspace's catalog gives the package. One to a
// directory — a path alone, such as `./vendor/foo`, `link:` or `file:` —
// is read only with `vfs` given, and only where the directory is under
// the lockfile's and holds a package.json there. pnpm links to it by a
// path alone or `link:`. By `file:` it installs it as a package, of the
// files npm-packlist's built-in rules keep, which are followed here alone:
// a directory with a .npmignore or .gitignore, a package.json with `files`
// or bundled dependencies, or a link in it, is refused. pnpm hardlinks
// those files from the directory into each snapshot of the package, so a
// file linking a bin makes executable is made so in every snapshot and in
// the directory, which is not written here; a CRLF `#!` line it rewrites
// is rewritten as a file of that snapshot's own. One by `file:` to a
// tarball is refused, and so is a `file:` dependency no override names.
//
// Of the .npmrc, only what pnpm reads for an install is read: its settings
// by their kebab-case names, those that can change the tree held to what
// is built here, and all else — npm's own settings, publishing's,
// credentials, other names — passed over. A `${VAR}` pnpm would fill in is
// taken in a line passed over, such as `//registry.npmjs.org/:_authToken`,
// where the rest of the file would not change the tree: pnpm drops the
// whole file where the variable is unset.
//
// pnpm 11 reads its settings from pnpm-workspace.yaml alone, as this does
// for it: of the .npmrc only its registries, and of the package.json no
// setting, `resolutions` and the `pnpm` field none. It passes over a
// pnpm-workspace.yaml key not in camelCase; its own settings are read as
// the rest are, pmOnFail and runtimeOnFail among them, which decide what
// its packageManager, devEngines.packageManager and engines.runtime
// checks do. The tree follows the lockfile, as pnpm 11's does with
// trustLockfile: minimumReleaseAge, and the rest of what pnpm 11 checks the
// lockfile against the registry by before it installs — each package's
// publish time, its tarball URL, its trust — are passed over.
//
// `vfs` is a Vfs to mount the tree into, at its root, which is taken to
// be the lockfile's directory, beside whatever it holds, such as the
// projects themselves; without one, a new Vfs holds the tree alone. A Vfs
// that holds a node_modules anywhere, or on macOS a name that is one
// there, is refused before anything is fetched: kept beside the tree, Node
// would read it as the tree's, and removed, it would be the caller's lost.
// Nothing there is written over: each directory the tree has is one there
// or is made, and every file and link is written where nothing is. The
// tree is built, and held to every check below, before any of it is
// written, so a refusal leaves the Vfs as it was. With it given, a
// directory the tree links to that is no project, and is under the
// lockfile's, has to be there with a package.json, whose bins are read as
// pnpm reads them; nothing outside node_modules is written, though pnpm
// 10 makes the files a linked directory's bins run executable too.
// Without it, or outside the lockfile's directory, such a directory's
// bins are not known, and neither are those of a project that has them
// by the files of its directories.bin: where one could win a command a
// package's file is linked by, and so decide whether pnpm fixes that
// file, and fixing it would change it, the tree is refused.
export interface PnpmTreeOptions {
  lockfile: string
  manifests: Record<string, string> | Map<string, string>
  workspace?: string
  npmrc?: string
  patches?: Record<string, string> | Map<string, string>
  host: PnpmHost
  vfs?: Vfs
}

// What buildPnpmTree counts, all of it plain numbers: `projects` the
// importers; `snapshots` the lockfile's; `installed` those in the tree;
// `skipped` the optional ones left out, as the host cannot run them or
// only such reach them; `incompatible` those installed although the host
// does not take their platform or engines, which pnpm warns of; `tarballs`
// the packages fetched, each once; `patched` the snapshots a patch is
// applied to; `files` and `bytes` what is written; `links` the symlinks.
export interface PnpmTreeStats {
  projects: number
  snapshots: number
  installed: number
  skipped: number
  incompatible: number
  tarballs: number
  patched: number
  files: number
  bytes: number
  links: number
}

// `vfs` is the one given, the tree mounted into it, or a new one.
export interface PnpmTree {
  vfs: Vfs
  stats: PnpmTreeStats
}

// The node_modules tree `pnpm install --frozen-lockfile --ignore-scripts`
// makes with the isolated linker of host.pnpm, 10 or 11, and no other
// install: whatever the
// settings say of frozen lockfiles, the install is frozen, which is also
// the only one that hoists by the lockfile's graph alone. It is rooted at
// the lockfile's directory: each package's
// files at node_modules/.pnpm/<dir>/node_modules/<name>, its dependencies
// linked beside it, the hoisted aliases, and each project's own
// node_modules of links. Links are relative; a `link:` dependency leads
// where the lockfile says, which the tree does not hold. Scripts are
// always ignored, as `--ignore-scripts` has pnpm ignore them, whatever the
// settings would allow to build. No .bin is written, nor pnpm's own state
// files; but each file a bin pnpm links runs is left as linking leaves it:
// executable, and with a CRLF ending its `#!` line made LF. Every file is
// its own, as pnpm's files are where it clones or copies them from its
// store; where it hardlinks them instead, making one executable makes
// every file of the same content executable, and the store's, for later
// installs too, which is not followed here. Every file is written once,
// and a write that would replace anything with something else is refused;
// into a Vfs given, one that would replace anything at all.
// pnpm 11 links bins otherwise in places — npm owns `npx` and pnpm its
// aliases, a project's .bin takes the bins of the peers its dependencies
// require — and each is built as the one given links them.
//
// The lockfile is held to what a frozen install holds it to, and refused
// where pnpm would refuse it: the settings that shaped its resolution —
// catalogs, overrides, package extensions, optional dependencies left out,
// patches, autoInstallPeers, dedupePeers, peersSuffixMaxLength — and each
// project's package.json, read through pnpm's read-package hook as pnpm
// reads it. The root package.json's packageManager, where it has one, has
// to be `pnpm@` host.pnpm exactly, as pnpm would switch to the one it
// names; a project's engines.pnpm has to take host.pnpm, and with
// engineStrict its engines.node host.node. With engineStrict, pnpm 11
// holds a patched package's engines.node to host.node as its package.json
// has it once patched, not as the lockfile records it, and fails on, or
// takes out, one that does not take it, which is refused. pnpm 11 holds a
// lockfile to more before it installs, and so does this for it: a catalog
// dependency to the catalog's version, a workspace package linked exactly
// where its version is in range, and a patch hash in a snapshot's peers to
// the patch; it lets an optional dependency the importer has no specifier
// for go unresolved, and takes two spellings of one git commit alike. A
// devEngines.packageManager is refused unless its onFail, or pmOnFail, is
// to warn or ignore, as pnpm 11 installs with the pnpm the lockfile pins
// for it; and a root engines.runtime whose onFail is `error` has to take
// host.node.
//
// And to more than pnpm holds it to, where a lockfile pnpm writes, or a
// package the registry serves, always holds: each dependency linked where
// the package.json names a directory for it, a path alone among them; each
// snapshot marked optional exactly where only optional dependencies reach
// it; each patch
// on the package the settings pick it for, and each used; each tarball
// gzipped, every file under one directory, no link or device in it, and
// a package.json for exactly its name and version, whose os, cpu, libc,
// bins and bundled dependencies are what the lockfile recorded and whose
// every dependency the snapshot has. On macOS, two names in one directory
// that differ only in case or normalization are refused, as they would be
// one name there.
//
// Packages come from https://registry.npmjs.org/ alone, fetched through
// @preventive/upstream, and each tarball is held to the lockfile's
// integrity; each patch to the lockfile's hash of it, and applied only
// where every hunk matches exactly where it says.
//
// Nothing is left to a guess: a lockfile the lockfile reader refuses, a
// setting this does not know or does not build for, overrides pnpm cannot
// read, a lockfile not resolved with these settings, a package from
// anywhere but the registry, a pnpmfile, package extensions, an injected
// dependency, a lockfile not up to date with a package.json, another
// package manager, a runtime to download, two projects of one name, a
// patch that does not hash or apply, a check above that fails, text
// that is not well-formed where it is hashed, a patch that would change a
// bin's file between two times pnpm links it, a file whose mode would turn
// on the order a directory is read in — each is refused with a
// DeptreeError, a LockfileError or a YamlError that says where. A
// TypeError is thrown for options of the wrong type.
export function buildPnpmTree(options: PnpmTreeOptions): Promise<PnpmTree>

// The directories of the projects pnpm finds for the workspace at the
// root of `vfs`, by which buildPnpmTree takes their package.json: `.`, the
// root, first, then in order each directory whose package.json a glob of
// `workspace`'s `packages` takes, as pnpm `host.pnpm` finds them. Given
// the package.json of each, buildPnpmTree holds each to its importer as
// pnpm does, one the lockfile has none for to an empty one.
//
// `vfs` is a Vfs, or anything with its readdir, lstat and stat, such as a
// view of a directory on disk, by paths from `/`; nothing is written. Of
// it, only the directories pnpm walks into are read: none under
// node_modules or bower_components, and none whose name starts with a dot
// unless a glob spells it there. A manifest is a file, or a link to one; a
// link that leads nowhere, or to a directory, is none, as pnpm has it.
//
// Refused: a project, the root among them, whose manifest is
// package.json5 or package.yaml, which pnpm reads where there is no
// package.json, or is a link; a project pnpm finds through a link to a
// directory, which it follows as it follows it, and a link to a directory
// in one followed, which is not; a project in a directory a lockfile
// could not key its importer by, with a control, bidirectional or
// backslash character in its path, or a drive letter; a node_modules pnpm
// walks into, which it does under a directory with a leading dot that a
// glob spells, as buildPnpmTree builds no project in one; and a glob
// buildPnpmTree refuses, or a pnpm not 10.x or 11.x. A node_modules pnpm
// leaves out is neither read nor refused.
export interface PnpmProjectsOptions {
  workspace?: string
  host: Pick<PnpmHost, 'pnpm'>
  vfs: Pick<Vfs, 'readdir' | 'lstat' | 'stat'>
}

export function findPnpmProjects(options: PnpmProjectsOptions): string[]

// `where` is what a refusal is about — `pnpm-workspace.yaml: nodeLinker`,
// `.npmrc:3: node-linker`, a package's key — or undefined for the call as
// a whole; the message leads with it. `cause` is what a package beneath
// refused with, where one did.
export class DeptreeError extends Error {
  constructor(detail: string, where?: string, options?: { cause?: unknown })
  where: string | undefined
}
