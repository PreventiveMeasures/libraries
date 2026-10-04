// Hand-written against npm.js; a change to either belongs with the other.

import type { NodeType, Vfs } from '@preventive/vfs'

export { LockfileError } from '@preventive/lockfile/npm.js'

// Where @preventive/upstream caches what it fetches, tarballs among them.
// Tarballs are fetched through it, and that is the one place anything here
// touches a filesystem. Before the network, it takes a tarball from npm's
// cache — under $npm_config_cache, or ~/.npm — or from ~/.audit/cache/tgz,
// where one there has the lockfile's integrity, and writes neither; then
// from its own cache, where one is set, which is where it writes each
// tarball it fetches. Unset, which it is by default, it has none, and
// writes nothing. The project is read only through the view given as
// `project`, and the tree built in a Vfs.
export { setCacheDir } from '@preventive/upstream/npm.js'

// The machine npm would install on, which a tree depends on. `npm` is the
// version that installs, exact: 10.9.3 to 10.9.9, or 11.11.1 to 11.21.0
// (10.9.0 to 10.9.2 escape a `#` in the project's path, which is not known
// here); npm reads no packageManager field, so the root package.json's is
// not read. `node` is
// the Node npm runs on, an exact version; `os` and `cpu` as Node names
// them — `linux`, `x64`; and `libc` the C library npm finds on Linux,
// `glibc` or `musl`, and left out elsewhere, where npm finds none. Windows
// is refused: npm links bins there with shims, and workspaces with
// junctions.
//
// A package whose os, cpu, libc or engines the host does not take is left
// out where npm takes it as optional, and with it what npm leaves out with
// it; one that is not optional is refused where its platform is not the
// host's, as npm fails on it, and installed where its engines are not, as
// npm warns of them, unless engine-strict is set. So for the root and each
// workspace, by their package.json. A libc a package names fails a host
// with none, whatever it names.
export interface NpmHost {
  npm: string
  node: string
  os: string
  cpu: string
  libc?: 'glibc' | 'musl'
}

// A view of the lockfile's directory, by paths from `/`: a Vfs, or
// anything with its readdir, lstat, stat and readFile, such as one of a
// directory on disk, of which only this is read: the names in a
// directory; what a path is, `file`, `directory` or `symlink`, with lstat,
// and what it leads to with stat; and a file's bytes. Each throws an error
// whose `code` is ENOENT, ENOTDIR or ELOOP for a path that leads nowhere.
// Nothing is written to it.
export interface NpmProject {
  readdir(path: string): string[]
  lstat(path: string): { type: NodeType }
  stat(path: string): { type: NodeType }
  readFile(path: string): Uint8Array
}

// The files `npm ci` reads: package-lock.json; the package.json of the
// root and of every workspace; and the .npmrc, where there is one.
//
// With `lockfile`, they are given as text: `manifests` by the project's
// directory relative to the lockfile's (`.` for the root, then each
// workspace's, as findNpmWorkspaces lists them: a directory under the
// lockfile's, with no `.`, `..` or empty segment). Every workspace npm would
// find has to be given, and none else: the lockfile's have to be those.
//
// Without it, they are read from `project`, as npm reads them there, and
// none of them may be given: package-lock.json, which has to be there; the
// root package.json, which has to be there too; the package.json of every
// directory the root's `workspaces` globs take, as npm globs for them,
// outside node_modules, on macOS whatever the case; and the .npmrc. Each
// is read as UTF-8, and refused where it is not. A refusal names each as
// it would given: `manifests["packages/x"]`. Refused there: an
// npm-shrinkwrap.json, which npm reads in the lockfile's stead; and a link
// anywhere the globs reach, which glob follows or not by where it is.
//
// Settings from anywhere else — an .npmrc in the home directory or npm's
// own, the environment, NODE_ENV among it, the command line — are not
// read, and are taken to be at their defaults; so is the directory npm is
// run in, taken to be the lockfile's, with no workspace above it.
//
// Of the .npmrc, as npm reads it: npm hands the install each setting as
// ini reads it, before it checks it, so `bin-links=0` links bins, "0" being
// a truthy string. A setting that can change what npm installs is read
// only in a form with one reading, a key and a value neither quoted,
// escaped, cut at a `;` or `#`, nor filled in from the environment, and
// refused in any other. Three are followed: legacy-peer-deps, engine-strict
// and bin-links, each true or false. install-strategy is taken as hoisted,
// lockfile-version as 1, 2 or 3, allow-git, allow-directory, allow-file
// and allow-remote as all, and install-links, force, dry-run, global,
// package-lock-only, usage and include-workspace-root as false, and refused
// otherwise. omit, include, production, dev, only, also, optional, os,
// cpu, libc, workspace, workspaces, location, umask, prefix, globalconfig,
// userconfig, allow-scripts and a credential not scoped to a registry are
// refused, whatever their value; so are two settings npm takes as
// exclusive, set together, and a section. Any other setting is passed
// over: npm reads it for where it fetches from, how, what it prints, or
// another command, and the tree is held to the lockfile's integrities
// whatever serves it.
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
export type NpmTreeOptions = NpmTreeGiven | NpmTreeRead

export interface NpmTreeGiven {
  lockfile: string
  manifests: Record<string, string> | Map<string, string>
  npmrc?: string
  project?: undefined
  host: NpmHost
  vfs?: Vfs
}

export interface NpmTreeRead {
  lockfile?: undefined
  manifests?: undefined
  npmrc?: undefined
  project: NpmProject
  host: NpmHost
  vfs?: Vfs
}

// What buildNpmTree counts, all of it plain numbers: `packages` the
// lockfile's, each a copy in a node_modules; `installed` those in the
// tree; `skipped` those left out, as the host cannot run them or only such
// need them; `tarballs` those fetched, each once; `files` and `bytes` what
// is written; `links` the workspaces linked.
export interface NpmTreeStats {
  packages: number
  installed: number
  skipped: number
  tarballs: number
  files: number
  bytes: number
  links: number
}

// A package in the tree, as an SBOM would list it: `path` is where its
// files are, the lockfile's key of it, from the lockfile's directory,
// which is `/` of the Vfs — node_modules/<name>, beneath another package's
// node_modules, or beneath a workspace's. `name` and `version` are the
// package's own, whatever alias it is installed as, as the lockfile has
// them; `integrity` the sha512 its tarball is held to. The flags are those
// npm installs by, the lockfile's as npm 10 takes them and as npm 11 works
// them out again: `dev` is whether dev dependencies alone reach it, which
// --omit=dev leaves out; `optional` whether optional dependencies alone
// reach it, which --omit=optional leaves out; `devOptional` whether either
// is, or both together, which --omit=dev with --omit=optional leaves out;
// `peer` whether peer dependencies alone reach it, which --omit=peer
// leaves out.
export interface NpmInstalled {
  path: string
  name: string
  version: string
  integrity: string
  dev: boolean
  optional: boolean
  devOptional: boolean
  peer: boolean
}

// `vfs` is the one given, the tree mounted into it, or a new one.
// `installed` is each package in the tree, in the lockfile's order; a
// workspace, whose files the tree does not hold, is not among them.
export interface NpmTree {
  vfs: Vfs
  stats: NpmTreeStats
  installed: NpmInstalled[]
}

// The node_modules tree `npm ci --ignore-scripts` makes, with host.npm,
// into a project with no node_modules yet: rooted at the lockfile's
// directory, each package's files unpacked where the lockfile puts it,
// and each workspace linked as node_modules/<its name>, by a relative link
// to its directory, with what the lockfile puts beneath it in that
// directory's own node_modules. The tree holds node_modules and nothing
// else of the projects.
//
// Each package is unpacked as npm's tar unpacks it: the first segment of
// each name dropped; a file alone kept, so that a link, a device and a
// directory entry are passed over and no empty directory is made; each
// file's mode the tarball's with read and write for all added, and a umask
// of 0o022 then taken off, so that its execute bits stay; and a .gitignore
// renamed .npmignore, and dropped where a .npmignore came before it in its
// directory, or, where one comes after it, holding the second's bytes with
// the first's mode. Directories are 0o755.
//
// Scripts are always ignored, as `--ignore-scripts` has npm ignore them,
// whatever the settings say; npm 10 runs a workspace's prepare script all
// the same, and one with a prepare script is refused for it. No .bin is
// written, nor npm's own node_modules/.package-lock.json; but each bin's
// target is changed as linking it changes it, unless bin-links is false:
// of the bins the lockfile gives the packages of one node_modules, the
// first of each name, as npm sorts its packages by path, is linked, and its
// target, where the package has it, made 0o755, and the CR dropped from a
// first line in its first 2048 bytes that is a shebang ending in CRLF. A
// target that is a directory, runs through a file, or is in the package's
// own node_modules is refused, and one with such a line that is not UTF-8,
// which npm rewrites with replacement characters. A workspace's bins are
// its own files, which the tree does not hold; one in the workspace's own
// node_modules, or by directories.bin, is refused. So is the root's
// allowScripts, which npm 11.16 and later read for whose bins to link.
//
// npm 10 leaves out an optional package the host cannot run only once it
// has made directories for every package, and so leaves the directories
// it was in, a scope's or another package's node_modules, which the tree
// has too, empty. Of what only such a package needs, npm 11.13 and later
// leave out too what another left out needs as well. The tar of npm 10.9.9
// and 11.18 on gives up on a tarball that inflates more than 1000 times
// what it has read at any point, which is refused where it may, with a
// margin, as where it checks depends on how the bytes come.
//
// The lockfile is held to what the lockfile reader holds it to, with the
// flags npm installs by: npm 11 works them out again at every install, and
// npm 10 takes them as written, unless the root package.json asks for
// other than the lockfile's entry of it to the letter, as one asking for a
// name in two lists, or for a workspace by name too, does. Each project's
// package.json is held to the lockfile's entry of its directory: the same
// names asked for, in the same lists, by the same specs, as npm ci would
// otherwise resolve them anew or refuse; and each workspace to the name
// and version the lockfile gives it. The root's devEngines are checked as
// npm checks them, against the host, which has no os version to check.
// Refused too, as npm's releases read them otherwise: a range with a
// wildcard before a number, `1.x.0`, and for npm 10 an optional peer the
// lockfile does not meet by a range, which it resolves again.
//
// And to more than npm holds it to, where a lockfile npm writes, or a
// package the registry serves, always holds: each tarball gzipped, every
// entry under one directory, named as tar reads it, with no `\` and no
// more than 1024 segments, none in the package's own node_modules, where
// npm installs its dependencies, no setuid, setgid or sticky bit, no link
// name on a file, no global pax header nor a pax size, which tar's releases
// read otherwise; each with the sha512 integrity the lockfile records. On
// macOS, two names in one directory that differ only in case or
// normalization are refused, as they would be one name there.
//
// Packages come from npm's registry alone: each lockfile entry's
// `resolved` has to be the registry's own URL of its tarball,
// https://registry.npmjs.org/<name>/-/<base>-<version>.tgz, a scope's `/`
// as `%2f` or not, or that same URL on yarn's mirror,
// https://registry.yarnpkg.com/, which is taken for npm's; it is fetched
// from npm's through @preventive/upstream.
//
// Ranges and versions are read with npm's own semver, borrowed from the
// npm beside node as @preventive/upstream borrows it, or with its semver
// peer where there is no npm, without either of which this throws.
//
// Nothing is left to a guess: a lockfile the lockfile reader refuses, a
// setting this does not know or does not build for, a package from
// anywhere but the registry — git, a tarball's URL or one on disk, a
// directory by `file:` — or with no resolved URL, which npm fetches by the
// registry's packument, a package bundled in another, a link but to a
// workspace, overrides, acceptDependencies, a check above that fails —
// each is refused with a DeptreeError or a LockfileError that says where.
// A TypeError is thrown for options of the wrong type.
export function buildNpmTree(options: NpmTreeOptions): Promise<NpmTree>

// The directories of the projects npm finds in `project`, by which
// buildNpmTree takes their package.json given: `.`, the root, first, then
// each directory with a package.json that a glob of the root's
// `workspaces` takes, outside node_modules, as npm finds them, and as
// buildNpmTree reads them from a project; with `os` darwin, whatever the
// case, as npm's glob matches on macOS. Refused as buildNpmTree refuses
// it: a link where the globs reach; and a root with no package.json.
export interface NpmWorkspacesOptions {
  project: NpmProject
  os?: string
}

export function findNpmWorkspaces(options: NpmWorkspacesOptions): string[]

// `where` is what a refusal is about — `.npmrc:3`, `manifests["."]`, a
// lockfile entry, `packages["node_modules/a"]` — or undefined for the call
// as a whole; the message leads with it. `cause` is what a package beneath
// refused with, where one did.
export class DeptreeError extends Error {
  constructor(detail: string, where?: string, options?: { cause?: unknown })
  where: string | undefined
}
