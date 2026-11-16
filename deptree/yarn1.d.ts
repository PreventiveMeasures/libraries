/**
 * A node_modules tree built in memory from a yarn.lock, as yarn 1.22 installs it with its node_modules
 * linker
 *
 * ```js
 * import { buildYarn1Tree, findYarn1Workspaces } from '@preventive/deptree/yarn1.js'
 * ```
 *
 * Nothing is left to a guess: a lockfile the reader refuses, a setting not followed, a package from
 * anywhere but npm's registry or a directory of the project, bundled dependencies, another package
 * manager, or a check that fails is refused with a DeptreeError or a LockfileError saying where. Options of
 * the wrong type throw a TypeError.
 *
 * @module @preventive/deptree/yarn1.js
 */

import type { CacheOptions, PackageBugs, PackageRepository } from '@preventive/upstream/npm.js';
import type { NodeType, Vfs } from '@preventive/vfs';

export { LockfileError } from '@preventive/lockfile/yarn1.js';

/**
 * Sets where @preventive/upstream caches what it fetches, which is unset until set
 *
 * Tarballs are fetched through it, the one place anything here touches a filesystem: before the network
 * it reads npm's cache, ~/.audit/cache/tgz and its own or stasis's default directory for one of the
 * lockfile's integrity, writing none of them, then this one, which it writes each tarball it fetches to.
 * `setCacheDir()` sets the default directory and `setCacheDir(false)` unsets it. yarn's cache is never read.
 */
export { setCacheDir } from '@preventive/upstream/npm.js';

/**
 * The machine yarn would install on; Windows is refused, as yarn links bins there with shims
 *
 * A package whose os, cpu or engines the host does not take is left out where optional and refused where
 * not, as yarn fails on it; so is the root. Engines `node` (and `iojs`) and `yarn` are checked as yarn
 * checks them and one yarn has no version for is passed over; one Node reports in process.versions, such
 * as `v8`, is refused but for a Node unknown. ignore-engines and ignore-platform, set, skip the checks.
 * Of two references yarn's cache keeps as one, as a tag asked for twice makes, the second has its lockfile
 * entry for package.json, so it is never left out and links no bins.
 */
export interface Yarn1Host {
  /** The yarn that installs, a 1.22.x (default: what the root's packageManager pins, which it has to be) */
  yarn?: string;
  /** The Node yarn runs on, exact, or left out for one unknown, which takes every range */
  node?: string;
  /** As Node names it, such as `linux` */
  os: string;
  /** As Node names it, such as `x64` */
  cpu: string;
}

/**
 * A view of the lockfile's directory by paths from `/`, such as a Vfs; nothing is written to it
 *
 * Each method throws an error whose `code` is ENOENT, ENOTDIR or ELOOP for a path that leads nowhere.
 */
export interface Yarn1Project {
  readdir(path: string): string[];
  /** What a path is, and its mode */
  lstat(path: string): { type: NodeType; mode: number };
  /** What a path leads to */
  stat(path: string): { type: NodeType };
  readFile(path: string): Uint8Array;
}

/**
 * The files an install reads, either given as text or read from `project`
 *
 * Read, they are yarn.lock and the root's package.json, which have to be there; the package.json of each
 * directory the root's `workspaces` globs take, outside node_modules; the .yarnrc and the .npmrc. Each is
 * UTF-8, a byte order mark dropped, and a refusal names it as it would given: `manifests["packages/x"]`.
 * Refused there: a link the globs reach, a node_modules they would take, a yarn.json, a .yarnrc.yml.
 * Settings from anywhere else are taken at their defaults.
 *
 * Of the .yarnrc and .npmrc, as yarn reads them, an option of the .yarnrc over the .npmrc's and a `--`
 * line of the .yarnrc as a flag: ignore-engines is followed, by its flag or by the option where truthy as
 * yarn reads it, and ignore-platform by its flag alone. One that may change what yarn installs is refused,
 * such as production, ignore-optional, bin-links, yarn-path, global-folder, --flat or --modules-folder, and
 * so is an indented .yarnrc line; one for where and how yarn fetches, or no install, is passed over.
 *
 * A workspace project is the root, marked private, and each directory its `workspaces` take (`*`, `?`,
 * `**`) with a package.json naming a name and a version; nohoist, Plug'n'Play and `flat` are refused.
 */
export type Yarn1TreeOptions = Yarn1TreeGiven | Yarn1TreeRead;

interface Yarn1TreeShared {
  host: Yarn1Host;
  /**
   * A Vfs to mount the tree into, at the lockfile's directory, beside what it holds (default: a new one)
   *
   * One holding a node_modules, or on macOS a name that is one there, is refused before anything is
   * fetched. Nothing there is written over, and the tree is built and checked first, so a refusal leaves
   * it as it was.
   */
  vfs?: Vfs;
  /**
   * Fetch each registry package's version document by @preventive/upstream's getMeta, its dist held to the
   * lockfile's, for `commit`, `repository`, `homepage` and `bugs` (default: true)
   *
   * One whose sha512 the lockfile does not record has its document fetched either way.
   */
  metadata?: boolean;
  /** Where tarballs and version documents are kept, as @preventive/upstream's CacheOptions take it */
  cache?: CacheOptions['cache'];
  /**
   * The tree `--production` makes (default: false)
   *
   * No workspace's devDependencies are asked for. The root's are resolved, fetched, checked and hoisted all
   * the same, taking the places they hoist to, but each copy is installed only where something else needs it.
   */
  production?: boolean;
}

export interface Yarn1TreeGiven extends Yarn1TreeShared {
  lockfile: string;
  /**
   * Each project's package.json by its directory from the lockfile's, `.` for the root, as
   * findYarn1Workspaces lists them; every workspace yarn would find has to be among them
   */
  manifests: Record<string, string> | Map<string, string>;
  yarnrc?: string;
  npmrc?: string;
  /** Read only to tell whether a tag a top-level dependency asks for is a directory, which yarn would install */
  project?: Yarn1Project;
}

export interface Yarn1TreeRead extends Yarn1TreeShared {
  lockfile?: undefined;
  manifests?: undefined;
  yarnrc?: undefined;
  npmrc?: undefined;
  project: Yarn1Project;
}

/** What buildYarn1Tree counts */
export interface Yarn1TreeStats {
  /** The packages yarn resolves, each fetched from the registry or read from a directory of the project */
  packages: number;
  /** The optional ones left out, as the host cannot run them */
  skipped: number;
  /** Their copies in the tree */
  installed: number;
  /** Written */
  files: number;
  /** Written */
  bytes: number;
  /** The workspaces linked */
  links: number;
}

/** A copy of a package in the tree, as an SBOM would list it */
export interface Yarn1Installed {
  /** Where its files are, from the lockfile's directory: node_modules/<alias>, or in a workspace's own */
  path: string;
  /** The package's own, whatever alias it is installed as */
  name: string;
  version: string;
  /** The sha512 a registry package's tarball is held to */
  integrity?: string;
  /** The directory of the project a `file:` package is copied from */
  directory?: string;
  /** Its version document's gitHead, where fetched and a full commit id: the publisher's word */
  commit?: string;
  /** Its version document's, as getMeta reads it, where fetched; held to no repository */
  repository?: string | PackageRepository;
  homepage?: string;
  bugs?: string | PackageBugs;
  /** Whether only dev dependencies reach this copy, past what the host cannot run; none with `production` */
  dev: boolean;
  /** Whether only optional dependencies reach this copy */
  optional: boolean;
}

export interface Yarn1Tree {
  /** The Vfs given, the tree mounted into it, or a new one */
  vfs: Vfs;
  stats: Yarn1TreeStats;
  /** Each copy once per path, by path in code point order; no workspace, whose files the tree does not hold */
  installed: Yarn1Installed[];
}

/**
 * The node_modules tree `yarn install --frozen-lockfile --ignore-scripts` makes with host.yarn into a
 * project with no node_modules yet
 *
 * Each package's files are copied where yarn hoists it, and each workspace linked where yarn hoists it by
 * a relative link, with what is hoisted beneath it in its own node_modules; nothing else of the projects is
 * in the tree. The lockfile is resolved in yarn's order (the resolutions, the root's lists, then the
 * workspaces, each request with all beneath it), peers looked for along the shortest chain of names that
 * asked, and the tree laid out as yarn's hoister lays it out, quirks and all.
 *
 * Scripts never run, and no .bin or .yarn-integrity is written, but each bin's target is made 0o755 in every
 * copy, as yarn's fetcher makes it. Each file's mode is the tarball's with read for all and a 0o022 umask
 * taken off; .bin, .yarn-metadata.json and .yarn-tarball.tgz are left out, as yarn's copy leaves them.
 *
 * Held to the lockfile reader's checks and a frozen install's: every pattern has its entry, in its range,
 * and the root's packageManager, where set, is `yarn@` host.yarn. And to what yarn's lockfiles and the
 * registry always hold: each tarball gzipped, under one directory, with nothing in its own node_modules, no
 * link or device, a package.json of its name and version, the lockfile's sha512 and sha1. A sha1 alone is
 * taken only for a version published before 2018-08-05T14:58:16.253Z, and held to the registry's sha512
 * too. On macOS, two names in a directory differing only in case or normalization are refused.
 *
 * Packages come from npm's registry, by its own tarball URL or that on yarn's mirror, asked for by a semver
 * range, an `npm:` alias, the tarball URL, or a tag where the project is given and has no directory of
 * that name; or from a directory of the project by `file:` or `./`, read from `project`, copied whole as
 * yarn copies it, and held to its lockfile entry's name, version and lists. Tags that wait on the
 * filesystem at once, which answers in no set order, are refused where that order could change anything.
 * Ranges are read with the semver of the npm beside node, as @preventive/upstream borrows it.
 *
 * @param options - The files, the host and where the tree goes; `sizeEstimateOnly` or `lazy` is a TypeError
 * @returns The tree
 */
export function buildYarn1Tree(options: Yarn1TreeOptions): Promise<Yarn1Tree>;

export interface Yarn1WorkspacesOptions {
  project: Yarn1Project;
}

/**
 * The directories of the projects yarn finds in `project`, by which buildYarn1Tree takes their
 * package.json given; refused as buildYarn1Tree refuses them, as is a root with no package.json
 *
 * @returns `.` first, then each directory with a package.json a glob of the root's `workspaces` takes
 */
export function findYarn1Workspaces(options: Yarn1WorkspacesOptions): string[];

/** A refusal; `cause` is what a package beneath refused with, where one did */
export class DeptreeError extends Error {
  constructor(detail: string, where?: string, options?: { cause?: unknown });
  /** What it is about, which the message leads with (`.yarnrc:3`, `manifests["."]`, a pattern), or undefined */
  where: string | undefined;
}
