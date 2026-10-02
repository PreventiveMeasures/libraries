// Hand-written against pnpm.js; a change to either belongs with the other.

import type { NodeType, Vfs } from '@preventive/vfs'

// What the lockfile reader and the YAML parser refuse with: the cause of
// the DeptreeError that names the file they refused, pnpm-lock.yaml or
// pnpm-workspace.yaml.
export { LockfileError, YamlError } from '@preventive/lockfile/pnpm.js'

// Where @preventive/upstream caches what it fetches, tarballs among them.
// Tarballs are fetched through it, and that is the one place anything here
// touches a filesystem. Before the network, it takes a tarball from npm's
// cache — under $npm_config_cache, or ~/.npm — or from ~/.audit/cache/tgz,
// where one there has the lockfile's integrity, and writes neither; then
// from its own cache, where one is set, which is where it writes each
// tarball it fetches. Unset, which it is by default, it has none, and
// writes nothing: a tarball in neither of the others is fetched every
// time, each once for however many snapshots it has. The project is read
// only through the view given as `project`, and the tree built in a Vfs.
export { setCacheDir } from '@preventive/upstream/npm.js'

// The machine pnpm would install on, which a tree depends on: `pnpm` is
// the version that installs, and has to be a 9.x from 9.15.0 on, a 10.x,
// an 11.x or a 12.x from 12.8.1 on, the four built for, each as it differs
// from the others; an earlier 9.x or 12.x installs otherwise in places, and
// is refused. Left out, it is the one the root package.json's
// packageManager pins, which pnpm switches to, and has to be given where
// that pins none. `node` is the Node it runs on,
// unless the settings name a nodeVersion or, for pnpm 11, the root
// package.json's engines.runtime pins one; `os`, `cpu` and `libc` as Node
// and pnpm name them — `linux`, `x64`, `glibc` — with `unknown` for a libc
// outside Linux, as pnpm has it.
// Windows is refused: pnpm links there with junctions to absolute paths.
// An optional package the machine cannot run is left out, as pnpm leaves
// it out; supportedArchitectures in the settings widens what is taken.
export interface PnpmHost {
  pnpm?: string
  node: string
  os: string
  cpu: string
  libc: 'glibc' | 'musl' | 'unknown'
}

// A view of the lockfile's directory, by paths from `/`: a Vfs, or
// anything with its readdir, lstat, stat and readFile, such as one of a
// directory on disk, of which only this is read: the names in a
// directory; what a path is, `file`, `directory` or `symlink`, and its
// mode, with lstat, and what it leads to with stat; and a file's bytes.
// Each throws an error whose `code` is ENOENT, ENOTDIR or ELOOP for a path
// that leads nowhere. Nothing is written to it.
export interface PnpmProject {
  readdir(path: string): string[]
  lstat(path: string): { type: NodeType, mode: number }
  stat(path: string): { type: NodeType }
  readFile(path: string): Uint8Array
}

// The files an install reads: pnpm-lock.yaml; the package.json of every
// project it installs; pnpm-workspace.yaml and the .npmrc, where there are
// any; and every patch file the settings' patchedDependencies name.
//
// With `lockfile`, they are given as text: `manifests` by the project's
// directory relative to the lockfile's (`.` for the root, then as its
// importers are keyed), `patches` by the path from the lockfile's
// directory the settings name each by, and only those.
//
// Without it, they are read from `project`, as pnpm reads them there, and
// none of them may be given: pnpm-lock.yaml, which has to be there;
// pnpm-workspace.yaml, which, where there is none, pnpm refuses under
// another name it looks for it by, such as pnpm-workspace.yml; the .npmrc;
// the package.json of every project pnpm finds, as findPnpmProjects finds
// them, and no other, an importer pnpm-workspace.yaml's packages do not
// take refused unread; and each patch the settings name, and no other,
// which has to be under the lockfile's directory. Each is read as
// UTF-8, and refused where it is not, a byte order mark kept as it is in
// text given; a refusal names each as it would given:
// `manifests["packages/x"]`, `patches["patches/p.patch"]`.
//
// Settings from anywhere else — another .npmrc, the environment, the
// command line — are not read, and are taken to be at their defaults; so
// is pnpm taken to run as itself, not under corepack, and free to switch
// to the version a project pins.
//
// A workspace is one lockfile for several projects, each a package.json:
// the root, and every directory pnpm-workspace.yaml's `packages` globs
// take, as pnpm globs for them — `*` and `**`, a leading `!` to leave out,
// and no other glob syntax. Without `packages` the root is the only
// project. Every importer has to have its package.json, and be a project
// those globs take; and every project pnpm would find has to be given,
// which buildPnpmTree cannot check where it is given them, as it is not
// given the directories: findPnpmProjects finds them in those. A project the
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
// is read only with `project` given, and only where the directory is
// under the lockfile's and holds a package.json there. pnpm links to it by a
// path alone or `link:`. By `file:` it installs it as a package, of the
// files npm-packlist's built-in rules keep — with pnpm 12, its own port's
// — which are followed here alone: a directory with a .npmignore or
// .gitignore, a package.json with `files` or bundled dependencies, or a
// link in it, is refused. pnpm hardlinks those files from the directory
// into each snapshot of the package, so a file linking a bin makes
// executable is made so in every snapshot and in the directory, which is
// not written here; a CRLF `#!` line it rewrites is rewritten as a file of
// that snapshot's own. Where it builds the package — an install script, a
// binding.gyp, which pnpm 11 and 12 pass over with `gypfile: false`, or a
// .hooks directory — or, with pnpm 11 and 12, where packageImportMethod is
// other than auto or hardlink, each snapshot has a copy of its own
// instead. One by `file:` to a tarball is refused, and so is a `file:`
// dependency no override names. One to the lockfile's own directory, which
// pnpm 10 and 11 write as an empty path, is refused for pnpm 12, which
// fails on that lockfile.
//
// pnpm 9 reads its settings as pnpm 10 does, but none of
// pnpm-workspace.yaml: of that it reads the projects and the catalogs
// alone, and fails on one that sets anything else but no `packages`, which
// is refused; where one sets nothing, it finds projects everywhere, as `**`
// does. Of the package.json's `pnpm` field it reads fewer keys, and what
// pnpm 10 has that pnpm 9 has no setting for, such as dedupePeers or
// enableGlobalVirtualStore, it passes over. It hoists `*eslint*` and
// `*prettier*` publicly by default.
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
// pnpm 12 reads them so too. Where the root package.json pins a pnpm that
// host.pnpm is, it fails on a key of pnpm-workspace.yaml it does not know,
// one of pnpm 11's such as alwaysAuth among them, which is refused; it
// drops one otherwise, and passes over one not in camelCase it knows. It
// takes hoistPattern and publicHoistPattern only as lists, and passes over
// what it has that pnpm 11 has not but `cargo` or `python` enabled, which
// is refused. It parses every key of pnpm-workspace.yaml into a type of
// its own, and fails on a value that does not parse, or a `tasks` entry it
// holds to be wrong: that is not checked here of a key that leaves the
// tree as it is. Where there is no pnpm-workspace.yaml, it writes one of
// the root package.json's `workspaces` list, its strings but empty ones,
// and installs by it, as this does for it.
//
// `project` is read only where it is said to be here: for the files an
// install reads, without `lockfile`; for the directories a `link:` or an
// override leads to. With it given, a directory the tree links to that is
// no project, and is under the lockfile's, has to be there with a
// package.json, whose bins are read as pnpm reads them. Without it, or
// outside the lockfile's directory, such a directory's bins are not
// known, and neither are those of a project that has them by the files of
// its directories.bin: where one could win a command a package's file is
// linked by, and so decide whether pnpm fixes that file, and fixing it
// would change it, the tree is refused.
//
// `vfs` is a Vfs to mount the tree into, at its root, which is taken to
// be the lockfile's directory, beside whatever it holds, such as the
// projects themselves — it may be `project` too; without one, a new Vfs
// holds the tree alone. Nothing the tree is built from is read from it. A
// Vfs that holds a node_modules anywhere, or on macOS a name that is one
// there, is refused before anything is fetched: kept beside the tree, Node
// would read it as the tree's, and removed, it would be the caller's lost.
// Nothing there is written over: each directory the tree has is one there
// or is made, and every file and link is written where nothing is. The
// tree is built, and held to every check below, before any of it is
// written, so a refusal leaves the Vfs as it was. Nothing outside
// node_modules is written, though pnpm 9 and 10 make the files a linked
// directory's bins run executable too.
//
// The two ways the files come, one or the other: given, with `lockfile`
// and `manifests`, `project` read only for directories; or read, with
// `project` and none of them.
export type PnpmTreeOptions = PnpmTreeGiven | PnpmTreeRead

export interface PnpmTreeGiven {
  lockfile: string
  manifests: Record<string, string> | Map<string, string>
  workspace?: string
  npmrc?: string
  patches?: Record<string, string> | Map<string, string>
  project?: PnpmProject
  host: PnpmHost
  vfs?: Vfs
}

export interface PnpmTreeRead {
  lockfile?: undefined
  manifests?: undefined
  workspace?: undefined
  npmrc?: undefined
  patches?: undefined
  project: PnpmProject
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

// A snapshot in the tree, as an SBOM would list it: `path` is where its
// files are, from the lockfile's directory, which is `/` of the Vfs —
// node_modules/.pnpm/<dir>/node_modules/<name>; `key` the lockfile's
// snapshot key, its peers and patch hash in it. `name` and `version` are
// the package's own, which its package.json is held to, and `integrity`
// the sha512 its tarball is held to; one a `file:` override has pnpm
// install from a directory has `directory`, from the lockfile's, `.` for
// its own, and neither a version nor an integrity, as the lockfile records
// none.
// `dev` is whether devDependencies alone reach it: no project's
// dependencies or optionalDependencies do, through what is installed, so
// `pnpm install --prod` would leave it out. `optional` is whether optional
// dependencies alone reach it, as the lockfile records it. `patch` is the
// patch applied to it, by pnpm's hash of it and the path the settings name
// it by: of two patches of one text, the first they name.
export interface PnpmInstalled {
  path: string
  key: string
  name: string
  version: string | undefined
  integrity: string | undefined
  directory: string | undefined
  dev: boolean
  optional: boolean
  patch: { hash: string, path: string } | undefined
}

// `vfs` is the one given, the tree mounted into it, or a new one.
// `installed` is each snapshot in the tree, one for each `stats.installed`
// counts, in the lockfile's order.
export interface PnpmTree {
  vfs: Vfs
  stats: PnpmTreeStats
  installed: PnpmInstalled[]
}

// The node_modules tree `pnpm install --frozen-lockfile --ignore-scripts`
// makes with the isolated linker of host.pnpm, 9, 10, 11 or 12, and no
// other install: whatever the
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
//
// pnpm 9 makes its tree as pnpm 10 does but in places, each built as
// pnpm 9 makes it. It ends the name of a directory under
// node_modules/.pnpm it cuts short with 26 base32 characters of an MD5,
// not 32 hex of a SHA-256, and leaves a `#` in it. It hoists from the
// lockfile, not the graph: the snapshots of one depth in the order of
// their keys, not their directories', and an alias taken by a child left
// out, a `link:` or a project as well as by a snapshot hoisted, the root's
// all taken from the start as its specifiers spell them. It takes a bin's
// command by its name before it drops the scope, so links `@x/y z` as
// `y z`, and links a `bin` string, or a directories.bin, where it leads
// out of the package, which is refused; it fails on a bin that is a
// directory, which is refused, where pnpm 10 passes over it.
//
// pnpm 11 links bins otherwise in places — npm owns `npx` and pnpm its
// aliases, a project's .bin takes the bins of the peers its dependencies
// require — and each is built as the one given links them.
//
// pnpm 12, a rewrite of pnpm, makes its tree otherwise again, and it is
// built as pnpm 12 makes it. It links each package's own bins into its own
// node_modules/.bin, beside its dependencies', and of two of one name
// keeps the one of the package whose name sorts first by its bytes; makes
// a file a bin runs executable without rewriting a CRLF `#!` line, and
// fails on a bin that is a directory, which is refused; reads `bin` and
// directories.bin otherwise, dotfiles among them, and a package's null
// `bin` beside a directories.bin as its store has the package or not,
// which is refused. It links no package to
// a dependency of its own name, and writes a file a patch makes as
// 0o644, whatever mode the patch gives it. It hoists from a graph of every
// snapshot, those left out walked through but not hoisted, keeps from
// hoisting the root project's aliases but its `link:`s, those left out
// among them, and takes the snapshots of one depth in the order of their
// directories' names. It names a directory under node_modules/.pnpm by the
// UTF-8 bytes of its key, which only a key that is not ASCII tells. It
// shares pnpm 11's store, and takes what pnpm 11 left there, such as a
// patched package as pnpm 11 built it, which is not followed here: the
// tree is the one a store of pnpm 12's own gives.
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
// pnpm 12 reads devEngines.packageManager over packageManager, as pnpm 11
// does but for the onFail of a list with no pnpm in it, which is its first
// entry's own. Unless what to do on a mismatch, or pmOnFail, is to ignore,
// host.pnpm has to be in the pnpm it pins, or the mismatch only to warn,
// and another package manager is refused unless it is only to warn; and a
// pin of devEngines, or of a pnpm 12 by packageManager, has to be recorded
// in the lockfile's env document, of `pnpm` alone at the version pinned,
// or at host.pnpm for a range, with its package: pnpm 12 runs that one,
// and fails a frozen install where it is not there.
//
// pnpm 9 holds a lockfile to less than pnpm 10: neither to the catalogs
// nor to dedupePeers, nor a dependency's version to its range. It hashes a
// patch with MD5, in base32, and picks one for a package by `name@version`
// as spelled, else by `name`, never by a range. It overrides a peer in
// place, whatever the override. Where the root package.json's
// packageManager pins another pnpm, pnpm 9 installs with itself, unless
// managePackageManagerVersions has it switch to that one, or
// packageManagerStrict and packageManagerStrictVersion have it fail, each
// refused; and it fails on another package manager with
// packageManagerStrict, as it is by default, which is refused. It knows no
// runtime, and holds a project's os, cpu and libc to the host's own,
// whatever supportedArchitectures says.
//
// pnpm 12 makes none of pnpm 11's further checks of a lockfile, but holds
// a directory a project depends on by `file:` to it: each dependency the
// snapshot has is one its package.json, overridden, asks for, a peer among
// them; each it asks for is resolved as it asks, an optional one there or
// not; and its peers, and which are optional, are what the lockfile
// records. A project the lockfile has no importer for is held to none
// where it has no dependencies but peers, and refused otherwise. It checks
// of the projects only the root's engines.node, with engineStrict, and
// with engineStrict refuses whatever it installs that the host cannot run,
// though the lockfile mark it optional. An os, cpu or libc list is read
// by its first entry that names the host's. A patched package's
// engines.node is held to nodeVersion, or the host's Node, whatever the
// root's engines.runtime pins. An engines.node npm's semver does not read,
// or a range of a `-` with an `x`, pnpm 12 reads otherwise, which is
// refused where it would decide what is installed. host.node is, for pnpm
// 12, the `node` it finds on the PATH.
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
// Nothing is left to a guess: a lockfile the lockfile reader refuses, or
// one of the env document pnpm 11 writes alone before anything is
// installed, a setting this does not know or does not build for, overrides
// pnpm cannot read, a lockfile not resolved with these settings, a package
// from anywhere but the registry, a pnpmfile, package extensions, an
// injected dependency, a lockfile not up to date with a package.json,
// another package manager, a runtime to download, two projects of one
// name, a patch that does not hash or apply, a check above that fails,
// text that is not well-formed where it is hashed, a patch that would
// change a bin's file between two times pnpm links it, a file whose mode
// would turn on the order a directory is read in — each is refused with a
// DeptreeError that says where: where the lockfile reader or the YAML
// parser refused pnpm-lock.yaml or pnpm-workspace.yaml, it names the file,
// and its cause is their LockfileError or YamlError. A TypeError is thrown
// for options of the wrong type.
export function buildPnpmTree(options: PnpmTreeOptions): Promise<PnpmTree>

// The directories of the projects pnpm finds in `project`, by which
// buildPnpmTree takes their package.json given: `.`, the root, first, then
// in order each directory whose package.json a glob of
// pnpm-workspace.yaml's `packages` takes, as pnpm `host.pnpm` finds them.
// pnpm-workspace.yaml is read from `project`, as buildPnpmTree reads it;
// so is the root package.json, where host.pnpm is left out, for the pnpm
// its packageManager pins, or, for pnpm 12, where there is no
// pnpm-workspace.yaml, for its `workspaces`.
//
// Of `project`, besides those, only the directories pnpm walks into are
// read: none under node_modules or bower_components, and none whose name
// starts with a dot unless a glob spells it there. A manifest is a file,
// or a link to one; a link that leads nowhere, or to a directory, is none,
// as pnpm has it.
//
// pnpm 12 finds them otherwise in places: a `**` may take no directory
// before one a glob spells with a leading dot; it walks into no
// node_modules or bower_components, wherever they are; it fails where a
// glob with a `*` takes a directory whose first manifest there is not a
// file, which is refused; and the projects come in the order of their
// paths by name, `a/b` before `a-b`.
//
// pnpm 9 finds them with fast-glob, otherwise again: past the names before
// a glob's first `**` it walks into every directory, one with a leading
// dot among them, though no `*` or `**` takes a project there; it walks
// from the top for every glob where one has a `*` in its first name; and
// it leaves out what a `!` glob takes, leading dots and all. It reads
// every manifest a project has, not the first, and fails on a glob that
// leads through a file, both refused. Where pnpm-workspace.yaml sets
// nothing, it finds projects everywhere, as `**` does; where it sets
// anything but no `packages`, it fails, which is refused; and it refuses
// no name for it but pnpm-workspace.yml.
//
// Refused: a root with no manifest, which pnpm takes for no project; a
// project, the root among them, whose manifest is package.json5 or
// package.yaml, which pnpm reads where there is no package.json, or is a
// link; a project pnpm finds through a link to a directory, which it
// follows, and a link to a directory in one followed, which is not; a
// project in a directory a lockfile could not key its importer by, with a
// control, bidirectional or backslash character in its path, or a drive
// letter; a node_modules pnpm walks into, which it does only under a
// directory with a leading dot, one a glob spells or, for pnpm 9, one
// past a `**`; a glob buildPnpmTree refuses, or a pnpm not 9.x, 10.x, 11.x
// or 12.x; and a pnpm-workspace.yaml that is not YAML, is not a mapping,
// is not UTF-8, or is under another name pnpm refuses.
export interface PnpmProjectsOptions {
  project: PnpmProject
  host?: Pick<PnpmHost, 'pnpm'>
}

export function findPnpmProjects(options: PnpmProjectsOptions): string[]

// `where` is what a refusal is about — `pnpm-workspace.yaml: nodeLinker`,
// `.npmrc:3: node-linker`, `pnpm-lock.yaml`, a package's key — or
// undefined for the call as a whole; the message leads with it. `cause` is
// what a package beneath refused with, where one did: the lockfile
// reader's LockfileError, its YamlError, a fetch's failure.
export class DeptreeError extends Error {
  constructor(detail: string, where?: string, options?: { cause?: unknown })
  where: string | undefined
}
