/**
 * The vendor directory `cargo vendor` makes from a Cargo.lock, built in memory
 *
 * ```js
 * import { buildCargoTree } from '@preventive/deptree/cargo.js'
 * ```
 *
 * Each .crate is fetched through `@preventive/upstream`: from cargo's own cache ($CARGO_HOME/registry/cache)
 * where one there has the lockfile's checksum, which is never written, else its own (`setCacheDir`). That
 * is the one place a filesystem is touched. Nothing is left to a guess: what cargo would read otherwise,
 * or what this cannot reproduce exactly, is refused.
 *
 * @module @preventive/deptree/cargo.js
 */

import type { NodeType, Vfs } from '@preventive/vfs';

export { LockfileError, TomlError } from '@preventive/lockfile/cargo.js';

// Where `@preventive/upstream` caches .crate files: setCacheDir() the default, false none, as until set
export { setCacheDir } from '@preventive/upstream/npm.js';

/** The machine cargo would vendor on */
export interface CargoHost {
  /** The exact cargo that vendors, 1.94.0 to 1.99.x; from 1.97 each .cargo-checksum.json has a `$comment` */
  cargo: string;
  /** As Node names it, `linux` or `darwin`; Windows is refused, as cargo unpacks and names files otherwise there */
  os: string;
}

/**
 * The project's root, by paths from `/`: a Vfs, or anything with these methods, such as a view of a
 * directory on disk. Read as UTF-8: Cargo.lock, the Cargo.toml of every path package cargo reads and of
 * each directory between one and the root, the directories workspace.members takes, and .cargo/config or
 * .cargo/config.toml. A link at or on the way to any of them is refused; nothing is written.
 */
export interface CargoProject {
  readdir(path: string): string[];
  lstat(path: string): { type: NodeType };
  stat(path: string): { type: NodeType };
  /** Throws with `code` ENOENT, ENOTDIR or ELOOP for a path that leads nowhere */
  readFile(path: string): Uint8Array;
}

/**
 * The files `cargo vendor` reads at the project's root, taken to be the workspace's, with no workspace
 * above it: given as text (`lockfile`, `manifests` and `config`) or read from `project`
 *
 * The path packages are the members (the root's, each directory workspace.members takes and exclude does
 * not, each path dependency of a member in the root and not excluded), and every other package cargo reads
 * from a path: path dependencies of members, each `[patch]` from a path, and their normal and build path
 * dependencies. Each inherits from the root's `[workspace]` where cargo has it inherit.
 *
 * Refused, as cargo reads it otherwise: a `**` or `[` in a members glob, a path that is absolute, leads
 * out of the project or has a `..` after a name, a package.workspace pointing elsewhere than the root,
 * and a `[workspace]` between a package and the root. Refused, as cargo refuses it: a glob that takes
 * nothing, a member without a Cargo.toml or with a `[workspace]`, a root excluded from its workspace, a
 * default member that is no member, and a path dependency or `[patch]` to no package or another of the
 * name. Of the config, `[patch]` is read and `paths` and `include` refused; settings from anywhere else
 * are taken to be at their defaults.
 */
export type CargoTreeOptions = CargoTreeGiven | CargoTreeRead;

interface CargoTreeCommon {
  host: CargoHost;
  /**
   * A Vfs to mount the tree into, at the project's root (it may be `project`), or a new one. One that
   * holds a `vendor` (on macOS, a name that is one there) is refused before anything is fetched. Nothing
   * there is written over, and a refusal leaves it as it was.
   */
  vfs?: Vfs;
}

export interface CargoTreeGiven extends CargoTreeCommon {
  lockfile: string;
  /**
   * Each Cargo.toml cargo reads, and none else, by directory: `.` for the root, and each other's path
   * from it with no `.`, `..` or empty segment
   */
  manifests: Record<string, string> | Map<string, string>;
  /** .cargo/config.toml */
  config?: string;
  project?: undefined;
}

export interface CargoTreeRead extends CargoTreeCommon {
  lockfile?: undefined;
  manifests?: undefined;
  config?: undefined;
  project: CargoProject;
}

/** What was vendored */
export interface CargoTreeStats {
  /** The lockfile's packages */
  packages: number;
  /** Those copied into vendor/, each a .crate fetched */
  vendored: number;
  /** Files written, each .cargo-checksum.json among them */
  files: number;
  /** Bytes written */
  bytes: number;
}

/** A package as an SBOM would list it; all of it the publisher's word, held to no repository */
export interface CargoInstalled {
  /** `vendor/<name>`, or `vendor/<name>-<version>` for all but the greatest version of a name */
  path: string;
  name: string;
  version: string;
  source: string;
  /** The hex sha256 its .crate is held to */
  checksum: string;
  /** The full commit its .cargo_vcs_info.json names, where `cargo package` packed a clean checkout */
  commit: string | undefined;
  /** Its packed Cargo.toml's */
  repository: string | undefined;
  /** Its packed Cargo.toml's */
  homepage: string | undefined;
}

export interface CargoTree {
  /** The one given, the tree mounted into it, or a new one */
  vfs: Vfs;
  stats: CargoTreeStats;
  /** In the lockfile's order */
  installed: CargoInstalled[];
}

/**
 * The vendor directory `cargo vendor` makes, with `host.cargo` and none of its options, in a project
 * with no vendor directory yet: `vendor/<directory>` for each package but path ones, and nothing else
 *
 * A package's directory is its name, or `<name>-<version>` for all but the greatest version of the name
 * by the semver crate's order. The lockfile is held to the manifests, as cargo resolves anew one out of
 * date with them: every package's (a vendored one's from its .crate) laid over it by `linkCargo`, each
 * path dependency to the package its path leads to, every path package of it one cargo reads, and every
 * member in it.
 *
 * Each .crate is fetched from crates.io, held to the lockfile's sha256, and unpacked as cargo unpacks
 * it: `<name>-<version>/` taken off; anything under a `.git`, a .gitattributes, .gitignore or .cargo-ok
 * passed over; directories 0o755 or their own entry's mode, files their mode within 0o777, as a 0o022
 * umask leaves them; then a .cargo-checksum.json, 0o644, as cargo writes it. Refused:
 * - what `@preventive/archive`'s readers refuse, such as a `..` name or two entries of one name that differ
 * - what cargo reads otherwise: more than one gzip member, a gzip header CRC or reserved flag, a pax size
 * - what cargo refuses: past 512 MiB unpacked (or twenty times the .crate), an entry not under
 *   `<name>-<version>` or not a file or directory, a .crate's own .cargo-checksum.json
 * - what cargo fails on as any user but root: a file without its owner's read, a directory with anything
 *   in it without its owner's read and search, or written into after its entry without its owner's write
 * - on macOS, two names that are one there
 *
 * A package from git, or from a registry but crates.io, is refused.
 *
 * @param options - The files and where to build
 * @returns The tree, what it holds, and its packages
 * @throws DeptreeError, LockfileError or TomlError saying where; TypeError for options of the wrong type
 */
export function buildCargoTree(options: CargoTreeOptions): Promise<CargoTree>;

/** A refusal */
export class DeptreeError extends Error {
  constructor(detail: string, where?: string, options?: { cause?: unknown });
  /** What it is about, such as `crates/a/Cargo.toml`, which the message leads with; undefined for the call */
  where: string | undefined;
}
