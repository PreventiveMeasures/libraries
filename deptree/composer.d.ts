// Hand-written against composer.js; a change to either belongs with the other.

import type { Client } from '@preventive/upstream/github.js'
import type { NodeType, Vfs } from '@preventive/vfs'

export { LockfileError } from '@preventive/lockfile/composer.js'

// Where @preventive/upstream caches what it fetches, archives and zips
// among them. Each is fetched through it, and that is the one place
// anything here touches a filesystem: from its cache, where one is set,
// which is where it writes each it fetches; unset, which it is by default,
// it has none, and writes nothing. Composer's own cache is never read. The
// project is read only through the view given as `project`, and the tree
// built in a Vfs.
export { setCacheDir } from '@preventive/upstream/npm.js'

// The machine Composer would install on: `composer` the version that
// installs, exact, 2.2.0 to 2.10, which install alike; `os` as Node names
// it — `linux`, `darwin`; and `unzip` whether unzip is on the PATH, which
// Composer extracts zips with where it is, and has to be: without it,
// Composer extracts them with PHP's ZipArchive, which keeps neither modes
// nor links, and that is refused. Windows is refused: Composer extracts
// zips with 7-Zip and proxies bins with .bat files there.
export interface ComposerHost {
  composer: string
  os: string
  unzip: boolean
}

// A view of the project's root, by paths from `/`: a Vfs, or anything with
// its readdir, lstat, stat and readFile, such as one of a directory on
// disk, of which only composer.json and composer.lock are read there, each
// as UTF-8, and refused where it is not. Nothing is written to it.
export interface ComposerProject {
  readdir(path: string): string[]
  lstat(path: string): { type: NodeType }
  stat(path: string): { type: NodeType }
  readFile(path: string): Uint8Array
}

// The files `composer install` reads at the project's root, composer.json
// and composer.lock: given, with `lockfile` and `composerJson`; or read,
// with `project` and neither of them.
//
// Of composer.json, what the lockfile reader holds it to, with the
// lockfile; and three settings of its config: vendor-dir, a directory
// within the project by plain names, as Composer neither expands nor
// resolves one, `vendor` where unset; bin-dir, one too, or within
// vendor-dir by `{$vendor-dir}`, `{$vendor-dir}/bin` where unset; and
// preferred-install, dist where unset, source, auto, or a mapping of
// package patterns to those. Settings from
// anywhere else — Composer's home, the environment, COMPOSER_VENDOR_DIR
// and COMPOSER among it, the command line — are not read, and are taken to
// be at their defaults.
//
// `github` is the client the archives of GitHub's packages are fetched
// with, as getRepoTarball fetches them, exported, from
// @preventive/upstream/github.js; an anonymous one where left out, which
// GitHub answers 60 times an hour, and each package without a shasum asks
// for its commit, its archive and some of its listings and blobs.
//
// `vfs` is a Vfs to mount the tree into, at its root, which is taken to be
// the project's — it may be `project` too; without one, a new Vfs holds the
// tree alone. A Vfs that holds the vendor directory already, or on macOS a
// name that is one there with it, is refused before anything is fetched,
// as Composer would keep or overwrite what is in it. Nothing there is
// written over: each directory the tree has is one there or is made, and
// every file and link is written where nothing is. The tree is built, and
// held to every check below, before any of it is written, so a refusal
// leaves the Vfs as it was.
export type ComposerTreeOptions = ComposerTreeGiven | ComposerTreeRead

export interface ComposerTreeGiven {
  lockfile: string
  composerJson: string
  project?: undefined
  host: ComposerHost
  github?: Client
  vfs?: Vfs
}

export interface ComposerTreeRead {
  lockfile?: undefined
  composerJson?: undefined
  project: ComposerProject
  host: ComposerHost
  github?: Client
  vfs?: Vfs
}

// What buildComposerTree counts, all of it plain numbers: `packages` the
// lockfile's; `installed` those with files in the tree, each an archive or
// a zip fetched; `metapackages` those with none; `files`, `bytes` and
// `links` what is written.
export interface ComposerTreeStats {
  packages: number
  installed: number
  metapackages: number
  files: number
  bytes: number
  links: number
}

// A package of the lockfile, as an SBOM would list it: `path` is its
// directory, from the project's root, which is `/` of the Vfs —
// vendor/<name>, under its target-dir if it has one — or null for a
// metapackage, which installs nothing; `name`, `version` and `type` the
// lockfile's, as the package has them; `dev` whether it is of
// packages-dev. And what its files are held to: the `repo` and `commit` of
// GitHub's archive, held to the commit's tree; or the `url` and `shasum`
// of its dist, the sha1 it is held to.
export type ComposerInstalled = {
  path: string | null
  name: string
  version: string
  type: string
  dev: boolean
} & ({ repo: string, commit: string } | { url: string, shasum: string } | {})

// `vfs` is the one given, the tree mounted into it, or a new one.
// `installed` is each package, in the lockfile's order.
export interface ComposerTree {
  vfs: Vfs
  stats: ComposerTreeStats
  installed: ComposerInstalled[]
}

// The vendor directory `composer install --no-plugins --no-scripts` makes
// from the lockfile, with host.composer, in a project with no vendor
// directory yet, packages-dev and all: rooted at the project's root, it
// holds each package's files where Composer installs it, and nothing else
// of the project. Plugins are not run, so none installs a package
// elsewhere, as composer/installers would, or writes anything. What
// Composer writes of its own is not written: the autoloader,
// vendor/autoload.php and vendor/composer's own files, installed.json
// among them, and the proxies in vendor/bin. But each bin's file is made
// executable as proxying it does: its links followed, it is made 0o755,
// unless it leads to nothing or to a directory, as Composer passes such a
// bin over. Two packages' bins of one name, which Composer proxies the
// first it installs of alone, are refused unless each is 0o755 already.
// The platform is not checked, as with --ignore-platform-reqs: where PHP or
// an extension of the host does not meet the lockfile's, Composer without
// it refuses to install anything.
//
// Each package is installed from its dist, a zip, as Composer prefers by
// default: one that preferred-install has installed from source, a clone,
// or that has no dist, is refused, and so is a dist of any other type, one
// with a preferred mirror, which Composer downloads from first, and a
// metapackage's none. Its files are what unzip extracts from the zip, as
// Composer extracts it on a host with unzip, under a umask of 0o022, and
// then moves into its place: the one directory the zip holds at its top,
// `.DS_Store` aside, or else the whole of it.
//
// Of GitHub's zipball of a commit with no shasum, which is how Packagist
// records each package on GitHub, the archive @preventive/upstream's
// getRepoTarball fetches exported stands in, which holds the same files,
// as `git archive` writes both, and is held to the commit's tree as the
// tree's .gitattributes export it: what they mark export-ignore left out,
// a file whose eol attributes have git write its line ends CRLF so
// written, and a file git rewrites otherwise, as export-subst has it,
// refused. As unzip
// extracts the zipball, each directory is 0o755 and each file 0o644, as
// git records no mode for them, but an executable, which keeps git's
// 0o755; each link is a link; and each directory git writes is made, an
// empty one of files it leaves out, or of a submodule, included.
//
// A dist with a shasum, which Composer holds it to, is fetched and held to
// it by @preventive/upstream's getDist: a release zip on drupal.org, or
// GitHub's zipball of a commit; from anywhere else, it is refused. It is
// extracted as unzip extracts it: a mode made on Unix as it is but for its
// setuid, setgid and sticky bits, one made on MS-DOS that agrees with its
// DOS attributes as it is too, and any other of those attributes, with the
// umask taken off. What unzip would ask about or read otherwise is refused
// with what the archive reader refuses: a name twice, which it asks
// whether to replace, a name past ASCII not flagged UTF-8, an entry it
// reads no mode of, a link not made on Unix, which it writes as a file.
//
// And to more than Composer holds a package to: a link that leads out of
// its package, a bin that does, a target-dir but of plain names, and a
// package installed in bin-dir, where the proxies go, or holding it, on
// macOS by names as it takes them, are refused. On macOS, two
// names in one directory that differ only in case or normalization are
// refused, as they would be one name there.
//
// The lockfile is held to what the lockfile reader holds it to, with
// composer.json; a lockfile out of date with it, which Composer warns of
// and installs from all the same, is installed from.
//
// Nothing is left to a guess: a lockfile the lockfile reader refuses, a
// setting this does not read as Composer reads it, a package from anywhere
// but those above, a check above that fails — each is refused with a
// DeptreeError or a LockfileError that says where. A TypeError is thrown
// for options of the wrong type.
export function buildComposerTree(options: ComposerTreeOptions): Promise<ComposerTree>

// `where` is what a refusal is about — `composer.json:
// config.vendor-dir`, `packages["symfony/console"]`, an entry of a zip — or
// undefined for the call as a whole; the message leads with it. `cause` is
// what a package beneath refused with, where one did.
export class DeptreeError extends Error {
  constructor(detail: string, where?: string, options?: { cause?: unknown })
  where: string | undefined
}
