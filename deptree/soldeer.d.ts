/**
 * The dependencies folder `soldeer install` makes from a soldeer.lock, built in memory
 *
 * ```js
 * import { buildSoldeerTree } from '@preventive/deptree/soldeer.js'
 * ```
 *
 * Everything is fetched through `@preventive/upstream`, whose cache (`setCacheDir`) is the one place
 * a filesystem is touched; Soldeer's own folders are never read. Nothing is left to a guess: what
 * Soldeer would read otherwise, or what this cannot reproduce exactly, is refused.
 *
 * @module @preventive/deptree/soldeer.js
 */

import type { Client } from '@preventive/upstream/github.js';
import type { NodeType, Vfs } from '@preventive/vfs';

export { LockfileError, TomlError } from '@preventive/lockfile/soldeer.js';

// Where `@preventive/upstream` caches zips and GitHub's tarballs: setCacheDir() the default, false none, as until set
export { setCacheDir } from '@preventive/upstream/npm.js';

/** The machine Soldeer would install on */
export interface SoldeerHost {
  /** The Soldeer that installs, alone or as `forge soldeer`: 0.12.0, which extracts zips otherwise than 0.11 */
  soldeer: string;
  /** As Node names it, `linux` or `darwin`; Windows is refused, as Soldeer names folders otherwise there */
  os: string;
}

/**
 * The project's root, by paths from `/`: a Vfs, or anything with these methods, such as a view of a
 * directory on disk. Only soldeer.lock, foundry.toml and, without that, soldeer.toml are read, as
 * UTF-8; nothing is written.
 */
export interface SoldeerProject {
  readdir(path: string): string[];
  lstat(path: string): { type: NodeType };
  stat(path: string): { type: NodeType };
  readFile(path: string): Uint8Array;
}

/**
 * The files an install reads, given as text (`lockfile`, and `foundry` and `soldeer` where there) or
 * read from `project`
 *
 * The config is foundry.toml where it has a `[dependencies]` table, else soldeer.toml where there is
 * no foundry.toml; otherwise Soldeer asks which file to make its config, which is refused. Refused too:
 * - in foundry.toml, a profile or profile.default that is not a table, or libs that are not an array,
 *   which Soldeer fails on as it adds `dependencies` to them
 * - in `[soldeer]`, a value of a type Soldeer fails on, `recursive_deps = true`, and a setting Soldeer
 *   0.12 does not have, as a later Soldeer may install otherwise by it
 * - an inline `dependencies`, which Soldeer reads none from
 */
export type SoldeerTreeOptions = SoldeerTreeGiven | SoldeerTreeRead;

interface SoldeerTreeCommon {
  host: SoldeerHost;
  /**
   * A Vfs to mount the tree into, at the project's root (it may be `project`), or a new one. One that
   * holds a `dependencies` (on macOS, a name that is one there) is refused before anything is fetched.
   * Nothing there is written over, and a refusal leaves it as it was.
   */
  vfs?: Vfs;
  /** From upstream's `createClient`, for each git dependency; a TypeError where one needs it and it is missing */
  github?: Client;
}

export interface SoldeerTreeGiven extends SoldeerTreeCommon {
  lockfile: string;
  foundry?: string;
  soldeer?: string;
  project?: undefined;
}

export interface SoldeerTreeRead extends SoldeerTreeCommon {
  lockfile?: undefined;
  foundry?: undefined;
  soldeer?: undefined;
  project: SoldeerProject;
}

/** What was installed */
export interface SoldeerTreeStats {
  /** Dependencies installed, each a zip or a tarball fetched */
  dependencies: number;
  /** Files written */
  files: number;
  /** Bytes written */
  bytes: number;
  /** Symlinks, which git dependencies alone have: a zip's are written as files */
  links: number;
}

/** A dependency as an SBOM would list it */
export type SoldeerInstalled = SoldeerInstalledZip | SoldeerInstalledGit;

export interface SoldeerInstalledZip {
  /** `dependencies/<name>-<version>`, from the project's root */
  path: string;
  name: string;
  version: string;
  /** The hex sha256 its zip is held to */
  checksum: string;
}

export interface SoldeerInstalledGit {
  /** `dependencies/<name>-<version>`, from the project's root */
  path: string;
  /** The config's */
  name: string;
  /** The config's */
  version: string;
  /** The repository's URL, as the lockfile has it */
  git: string;
  /** The commit, as the lockfile has it */
  rev: string;
  /** `rev` again, as the other trees name a commit */
  commit: string;
}

export interface SoldeerTree {
  /** The one given, the tree mounted into it, or a new one */
  vfs: Vfs;
  stats: SoldeerTreeStats;
  /** In the lockfile's order */
  installed: SoldeerInstalled[];
}

/**
 * The dependencies folder `soldeer install` makes, with `host.soldeer`, in a project with no
 * dependencies folder yet: `dependencies/<name>-<version>` for each dependency, and nothing else
 *
 * What Soldeer writes beside it (the lockfile again, remappings, foundry.toml's libs) is not written.
 * The lockfile is held to the config, each dependency to have its entry and each entry a dependency.
 *
 * A registry dependency's zip is fetched anew from Soldeer's registry, as 0.12 does, held to the
 * lockfile's sha256, and extracted as the zip crate extracts it: no root folder taken off; of two
 * entries of one name the later, where the first was; anything under a `.git` (as Windows reads the
 * name) passed over; a symlink written as a file of its target. Directories are 0o755, a file its Unix
 * mode as the zip crate reads it, or 0o644 where it reads none, as a 0o022 umask leaves them. Refused:
 * - what `@preventive/archive/zip.js` refuses, such as a `..` or absolute name, zip64 or encryption
 * - what the zip crate reads otherwise: a name past ASCII not flagged UTF-8, an AES or Unicode comment
 *   extra field
 * - what Soldeer fails on: a `:` in a name, an NTFS field or extended timestamp the zip crate does not read
 * - a folder another dependency's zip is downloaded into, `<folder>.zip`
 * - on macOS, two names that are one there
 *
 * A git dependency is fetched from GitHub alone, by `github`, as the tarball of the commit's tree (held
 * to the commit's id), and written as a checkout with no git config under a 0o022 umask: files 0o644,
 * or 0o755 where git has them executable, symlinks as symlinks, a submodule an empty directory, a file
 * `.gitattributes` marks `eol=crlf` with CRLF. Its URL is GitHub's over https or ssh, and its folder one
 * Soldeer's sanitize_filename leaves as it is. Refused: what upstream refuses of the tarball (such as
 * `export-ignore` or Git LFS), and a path git refuses to check out (a `.git` or `git~1` in it).
 *
 * A dependency from another git host, a URL of its own, or a private one is refused.
 *
 * @param options - The files and where to build
 * @returns The tree, what it holds, and its dependencies
 * @throws DeptreeError, LockfileError or TomlError saying where; TypeError for options of the wrong type
 */
export function buildSoldeerTree(options: SoldeerTreeOptions): Promise<SoldeerTree>;

/** A refusal */
export class DeptreeError extends Error {
  constructor(detail: string, where?: string, options?: { cause?: unknown });
  /** What it is about, such as `dependencies["forge-std"]`, which the message leads with; undefined for the call */
  where: string | undefined;
}
