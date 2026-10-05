// Hand-written against soldeer.js; a change to either belongs with the other.

import type { NodeType, Vfs } from '@preventive/vfs'

export { LockfileError, TomlError } from '@preventive/lockfile/soldeer.js'

// Where @preventive/upstream caches what it fetches, zips among them. Zips
// are fetched through it, and that is the one place anything here touches
// a filesystem: from its cache, where one is set, which is where it writes
// each zip it fetches — setCacheDir() sets the default one, and
// setCacheDir(false) unsets it; unset, which it is until set, it has none,
// and writes nothing. Soldeer's own folders are never read. The project is
// read only through the view given as `project`, and the tree built in a
// Vfs.
export { setCacheDir } from '@preventive/upstream/npm.js'

// The machine Soldeer would install on: `soldeer` is the version that
// installs, on its own or as `forge soldeer`, and has to be 0.12.0, which
// extracts zips otherwise than 0.11 and older; `os` as Node names it —
// `linux`, `darwin`. Windows is refused: Soldeer names folders and reads
// paths in zips otherwise there.
export interface SoldeerHost {
  soldeer: string
  os: string
}

// A view of the project's root, by paths from `/`: a Vfs, or anything
// with its readdir, lstat, stat and readFile, such as one of a directory
// on disk, of which only soldeer.lock, foundry.toml and, where there is
// no foundry.toml, soldeer.toml are read there, as Soldeer reads them,
// each as UTF-8, and refused where it is not. Nothing is written to it.
export interface SoldeerProject {
  readdir(path: string): string[]
  lstat(path: string): { type: NodeType }
  stat(path: string): { type: NodeType }
  readFile(path: string): Uint8Array
}

// The files an install reads at the project's root: soldeer.lock, and
// foundry.toml and soldeer.toml, where they are.
//
// Of the two, the config is the one Soldeer reads: foundry.toml, where it
// has a [dependencies] table, written as one rather than inline; else
// soldeer.toml, where there is no foundry.toml. Where neither holds, which
// is so of a foundry.toml with no such table, whatever soldeer.toml there
// is, Soldeer asks which file to make its config, and that is refused. Of
// foundry.toml, what Soldeer fails on as it adds `dependencies` to the
// default profile's libs is refused: a profile or profile.default that is
// not a table, or written inline, and libs that are not an array. Of the
// config's [soldeer] settings, a value of a type Soldeer fails on is
// refused, and so is recursive_deps = true, which has Soldeer install what
// each dependency depends on too; the others change nothing beneath
// dependencies/, and any other key is passed over, as Soldeer passes it
// over. A config whose `dependencies` is inline, which Soldeer reads none
// from, is refused.
//
// The two ways the files come, one or the other: given, with `lockfile`
// and, where they are, `foundry` and `soldeer`; or read, with `project`
// and none of them.
//
// `vfs` is a Vfs to mount the tree into, at its root, which is taken to be
// the project's — it may be `project` too; without one, a new Vfs holds
// the tree alone. A Vfs that holds a `dependencies` at its root, or on
// macOS a name that is one there, is refused before anything is fetched,
// as Soldeer would keep or remove what is in it by what it holds. Nothing
// there is written over: each directory the tree has is one there or is
// made, and every file is written where nothing is. The tree is built, and
// held to every check below, before any of it is written, so a refusal
// leaves the Vfs as it was.
export type SoldeerTreeOptions = SoldeerTreeGiven | SoldeerTreeRead

export interface SoldeerTreeGiven {
  lockfile: string
  foundry?: string
  soldeer?: string
  project?: undefined
  host: SoldeerHost
  vfs?: Vfs
}

export interface SoldeerTreeRead {
  lockfile?: undefined
  foundry?: undefined
  soldeer?: undefined
  project: SoldeerProject
  host: SoldeerHost
  vfs?: Vfs
}

// What buildSoldeerTree counts, all of it plain numbers: `dependencies`
// those installed, each a zip fetched; `files` and `bytes` what is written.
export interface SoldeerTreeStats {
  dependencies: number
  files: number
  bytes: number
}

// A dependency in the tree, as an SBOM would list it: `path` is its
// folder, from the project's root, which is `/` of the Vfs —
// dependencies/<name>-<version>; `name` and `version` the lockfile's, as
// the registry has them; `checksum` the hex sha256 its zip is held to.
export interface SoldeerInstalled {
  path: string
  name: string
  version: string
  checksum: string
}

// `vfs` is the one given, the tree mounted into it, or a new one.
// `installed` is each dependency, in the lockfile's order.
export interface SoldeerTree {
  vfs: Vfs
  stats: SoldeerTreeStats
  installed: SoldeerInstalled[]
}

// The dependencies folder `soldeer install` makes from the lockfile, with
// host.soldeer, in a project with no dependencies folder yet: rooted at
// the project's root, it holds `dependencies/<name>-<version>` for each
// dependency, and nothing else of the project. What Soldeer writes beside
// it — the lockfile again, remappings, foundry.toml's libs — is not
// written, and where writing it fails after the install, as Soldeer may on
// a remappings.txt it does not read, that is not followed.
//
// Each dependency's zip is fetched from Soldeer's registry, as Soldeer
// 0.12 asks the registry for it again rather than taking the lockfile's
// URL, and held to the lockfile's checksum, its sha256. It is extracted as
// Soldeer extracts it, with the zip crate, into a folder of its own: no
// root folder taken off; of two entries of one name, the later alone,
// where the first was; anything under a `.git` passed over, as Windows
// reads the name — trailing dots and spaces dropped, ASCII letters in
// either case; each symlink written as a file holding its target. Each
// directory is 0o755; each file's mode is its Unix mode as the zip crate
// reads it — from the upper half of its external attributes, by whatever
// system made it, or none at all for Unix where that is 0, else for MS-DOS
// from its read-only bit — without the
// type, setuid, setgid, sticky and group and other write bits; or 0o644,
// where the zip crate reads none, or for a symlink, or for a file written
// again by a name the zip crate reads no mode of, the mode it had. Both
// are as a umask of 0o022 leaves them. The lockfile's integrity, which
// Soldeer records anew as it installs and does not check, is not checked.
//
// The lockfile is held to what the lockfile reader holds it to, with the
// config: each dependency has its entry, which Soldeer installs it from,
// and each entry a dependency. And to more than Soldeer holds it to: a zip
// is read with @preventive/archive/zip.js, which refuses what it does not
// read — a `..`, absolute or backslashed name, one starting with a drive
// letter, zip64, encryption, an entry inside one that is not a directory,
// two entries of one name that differ, a directory by its name or its
// attributes and not by the other, entries that come to more than 512
// MiB — where Soldeer would take some of it;
// and what the zip crate reads otherwise than the archive reader is
// refused: a name with a byte past ASCII that is not flagged UTF-8, which
// it reads as CP437, and an AES or a Unicode comment extra field. What
// Soldeer fails on is refused: a name with a `:` in it, an NTFS extra
// field or an extended timestamp the zip crate does not read. A folder
// Soldeer downloads another dependency's zip into, `<folder>.zip`, is
// refused. On macOS, two names in one directory that differ only in case
// or normalization are refused, as they would be one name there, and so
// is a folder that is one there with another dependency's zip.
//
// Dependencies come from Soldeer's registry alone, each by a name and a
// version the registry takes: a dependency from a git repository, which
// Soldeer clones with its history, from a URL the config gives, or one the
// registry keeps private, which it hands out to those signed in alone, is
// refused.
//
// Nothing is left to a guess: a lockfile the lockfile reader refuses, a
// config this does not read as Soldeer reads it, a dependency from
// anywhere but the registry, a check above that fails — each is refused
// with a DeptreeError, a LockfileError or a TomlError that says where. A
// TypeError is thrown for options of the wrong type.
export function buildSoldeerTree(options: SoldeerTreeOptions): Promise<SoldeerTree>

// `where` is what a refusal is about — `foundry.toml: profile.default`,
// `dependencies["forge-std"]`, an entry of a zip — or undefined for the
// call as a whole; the message leads with it. `cause` is what a package
// beneath refused with, where one did.
export class DeptreeError extends Error {
  constructor(detail: string, where?: string, options?: { cause?: unknown })
  where: string | undefined
}
