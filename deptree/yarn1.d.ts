// Hand-written against yarn1.js; a change to either belongs with the other.

import type { NodeType, Vfs } from '@preventive/vfs'

export { LockfileError } from '@preventive/lockfile/yarn1.js'

// Where @preventive/upstream caches what it fetches, tarballs among them.
// Tarballs are fetched through it, and that is the one place anything here
// touches a filesystem. Before the network, it takes a tarball from npm's
// cache — under $npm_config_cache, or ~/.npm — or from ~/.audit/cache/tgz,
// where one there has the lockfile's integrity, and writes neither; then
// from its own cache, where one is set, which is where it writes each
// tarball it fetches. Unset, which it is by default, it has none, and
// writes nothing. yarn's own cache is never read. The project is read
// only through the view given as `project`, and the tree built in a Vfs.
export { setCacheDir } from '@preventive/upstream/npm.js'

// The machine yarn would install on, which a tree depends on: `yarn` is
// the version that installs, and has to be a 1.22.x; left out, it is the
// one the root package.json's packageManager pins, which corepack runs,
// and has to be given where that pins none, and to be that one where it
// does. `node` is the Node yarn runs on, an exact version; `os` and `cpu`
// as Node names them — `linux`, `x64`. Windows is refused: yarn links bins
// there with shims, and workspaces with junctions.
// A package whose os, cpu or engines the machine does not take is left
// out where it is optional, and refused where it is not, as yarn fails
// on it; so is the root project. Of engines, `node` (and `iojs`, which
// yarn takes for it) and `yarn` are checked as yarn checks them, and one
// yarn has no version for is passed over, as yarn passes over it; one Node
// 24 reports in process.versions, such as `v8`, which yarn would check
// against the Node it runs on, is refused.
export interface Yarn1Host {
  yarn?: string
  node: string
  os: string
  cpu: string
}

// A view of the lockfile's directory, by paths from `/`: a Vfs, or
// anything with its readdir, lstat, stat and readFile, such as one of a
// directory on disk, of which only this is read: the names in a
// directory; what a path is, `file`, `directory` or `symlink`, with lstat,
// and what it leads to with stat; and a file's bytes. Each throws an error
// whose `code` is ENOENT, ENOTDIR or ELOOP for a path that leads nowhere.
// Nothing is written to it.
export interface Yarn1Project {
  readdir(path: string): string[]
  lstat(path: string): { type: NodeType }
  stat(path: string): { type: NodeType }
  readFile(path: string): Uint8Array
}

// The files an install reads: yarn.lock; the package.json of the root and
// of every workspace; and the .yarnrc and the .npmrc, where there are any.
//
// With `lockfile`, they are given as text: `manifests` by the project's
// directory relative to the lockfile's (`.` for the root, then each
// workspace's, as findYarn1Workspaces lists them). Every workspace yarn
// would find has to be given, which buildYarn1Tree cannot check where it
// is given them, as it is not given the directories; and the lockfile
// reader refuses a manifest of any directory the root's `workspaces` do
// not take.
//
// Without it, they are read from `project`, as yarn reads them there, and
// none of them may be given: yarn.lock, which has to be there; the root
// package.json, which has to be there too; the package.json of every
// directory the root's `workspaces` globs take, as yarn globs for them,
// outside node_modules; the .yarnrc and the .npmrc. Each is read as UTF-8,
// and refused where it is not; a byte order mark is dropped, as yarn drops
// it. A refusal names each as it would given: `manifests["packages/x"]`.
// Refused there: a link anywhere the globs reach, which node-glob follows
// or not by where it is; a node_modules the globs would take, whose
// package.json yarn would read as a workspace; a yarn.json, which yarn
// reads as a manifest too; and a .yarnrc.yml, whose yarnPath yarn 1.22
// runs in its stead.
//
// Settings from anywhere else — a .yarnrc or .npmrc above the project or
// in the home directory, the environment, the command line — are not read,
// and are taken to be at their defaults.
//
// Of the .yarnrc and the .npmrc, each line a setting, a `--` one a flag
// yarn adds to its command line, read alike: what only moves where yarn
// fetches from, how, and what it keeps — the registry, a scope's registry,
// credentials, the network, its caches, the offline mirror — is passed
// over, as the tree is held to the lockfile's integrities whatever serves
// it, and so are settings of other commands, such as `yarn version`'s.
// Every other setting is refused: those that change what yarn installs —
// ignore-optional, ignore-engines, ignore-platform, production, flat,
// modules-folder, link-duplicates, bin-links, yarn-path, workspaces and
// the like — and any not known here. A .yarnrc line indented under
// another, which yarn reads into it, is refused too.
//
// A workspace project is the root, marked private, and every directory its
// `workspaces` globs take — `*`, `?` and `**`, as the lockfile reader takes
// them — with a package.json that has a name and a version. `nohoist`,
// Plug'n'Play, and a root package.json's `flat` are refused.
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
// written, so a refusal leaves the Vfs as it was.
//
// The two ways the files come, one or the other: given, with `lockfile`
// and `manifests`; or read, with `project` and none of them. `project`
// given with `lockfile` is read only to tell whether a tag a top-level
// dependency asks for is a directory, which yarn would install instead.
export type Yarn1TreeOptions = Yarn1TreeGiven | Yarn1TreeRead

export interface Yarn1TreeGiven {
  lockfile: string
  manifests: Record<string, string> | Map<string, string>
  yarnrc?: string
  npmrc?: string
  project?: Yarn1Project
  host: Yarn1Host
  vfs?: Vfs
}

export interface Yarn1TreeRead {
  lockfile?: undefined
  manifests?: undefined
  yarnrc?: undefined
  npmrc?: undefined
  project: Yarn1Project
  host: Yarn1Host
  vfs?: Vfs
}

// What buildYarn1Tree counts, all of it plain numbers: `packages` the
// registry packages yarn resolves, each fetched; `skipped` the optional
// ones left out, as the host cannot run them; `installed` the copies of
// them in the tree; `files` and `bytes` what is written; `links` the
// workspaces linked.
export interface Yarn1TreeStats {
  packages: number
  skipped: number
  installed: number
  files: number
  bytes: number
  links: number
}

// `vfs` is the one given, the tree mounted into it, or a new one.
export interface Yarn1Tree {
  vfs: Vfs
  stats: Yarn1TreeStats
}

// The node_modules tree `yarn install --frozen-lockfile --ignore-scripts`
// makes, with host.yarn's node_modules linker, into a project with no
// node_modules yet: rooted at the lockfile's directory, each package's
// files copied where yarn hoists it, and each workspace linked where yarn
// hoists it, by a relative link to its directory, with what yarn hoists
// beneath it in that directory's own node_modules. The tree holds
// node_modules and nothing else of the projects.
//
// The lockfile is resolved as yarn resolves it, in yarn's order, which
// decides where a package goes: the resolutions' patterns, then the root's
// dependencies, devDependencies and optionalDependencies, then the
// workspaces, each request with all it leads to before the next, and
// beneath one every request at once, as yarn's resolver runs them; each
// package's peers looked for along the shortest chain of names that asked
// for it, as yarn looks for them; and the tree laid out as yarn's hoister
// lays it out, quirks and all. A resolution applies to a dependency by its
// path, as yarn applies it, and not to one of the root's own.
//
// Scripts are always ignored, as `--ignore-scripts` has yarn ignore them,
// whatever the settings say. No .bin is written, nor yarn's own
// .yarn-integrity; but each file a bin yarn links runs is made executable,
// chmod 755, as linking it does, from the copy yarn links it from. Those
// of a workspace's bins are the workspace's own, which the tree does not
// hold, and are left as they are. Each file's mode is the tarball's, with
// read for all added and a umask of 0o022 taken off, as yarn unpacks it;
// .bin, .yarn-metadata.json and .yarn-tarball.tgz in a package are left
// out, as yarn's copy leaves them out.
//
// The lockfile is held to what the lockfile reader holds it to, with the
// manifests, and to what a frozen install holds it to: every pattern
// asked for has its entry, and each entry a version in the range of its
// pattern, as yarn would otherwise resolve the pattern anew, frozen or not.
// The root package.json's packageManager, where it has one, has to be
// `yarn@` host.yarn exactly, as corepack would run the one it names.
//
// And to more than yarn holds it to, where a lockfile yarn writes, or a
// package the registry serves, always holds: each tarball gzipped, every
// file under one directory, none in a node_modules, no link or device in
// it, and a package.json for exactly its name and version; each with the
// sha512 integrity and the sha1 the lockfile records. On macOS, two names
// in one directory that differ only in case or normalization are refused,
// as they would be one name there.
//
// Packages come from https://registry.yarnpkg.com/ or
// https://registry.npmjs.org/ alone, which serve the same tarballs,
// fetched from the second through @preventive/upstream; each by a semver
// range, an `npm:` alias, or a tag — the last only where the project is
// given, and a directory of the project of that name is not there, which
// yarn would install instead, and only where yarn would not have two
// requests of tags wait on the filesystem at once, which it answers in no
// set order.
//
// Nothing is left to a guess: a lockfile the lockfile reader refuses, a
// setting this does not know or does not build for, a package from
// anywhere but the registry — git, a tarball's URL, a directory by
// `file:` or `link:` — a range that is none of those above, a package
// with bundled dependencies, another package manager, a check above that
// fails — each is refused with a DeptreeError or a LockfileError that says
// where. A TypeError is thrown for options of the wrong type.
export function buildYarn1Tree(options: Yarn1TreeOptions): Promise<Yarn1Tree>

// The directories of the projects yarn finds in `project`, by which
// buildYarn1Tree takes their package.json given: `.`, the root, first,
// then each directory with a package.json that a glob of the root's
// `workspaces` takes, outside node_modules, as yarn finds them, and as
// buildYarn1Tree reads them from a project. Refused as buildYarn1Tree
// refuses it: a link where the globs reach, a node_modules they would
// take, a yarn.json; and a root with no package.json.
export interface Yarn1WorkspacesOptions {
  project: Yarn1Project
}

export function findYarn1Workspaces(options: Yarn1WorkspacesOptions): string[]

// `where` is what a refusal is about — `.yarnrc:3`, `manifests["."]`, a
// package's pattern — or undefined for the call as a whole; the message
// leads with it. `cause` is what a package beneath refused with, where one
// did.
export class DeptreeError extends Error {
  constructor(detail: string, where?: string, options?: { cause?: unknown })
  where: string | undefined
}
