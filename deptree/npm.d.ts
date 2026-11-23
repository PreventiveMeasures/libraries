/**
 * A node_modules tree built in memory from a package-lock.json, as npm 10 or 11 installs it with `npm ci`
 *
 * ```js
 * import { buildNpmTree, findNpmWorkspaces } from '@preventive/deptree/npm.js'
 * ```
 *
 * Nothing is left to a guess: a lockfile the reader refuses, a setting not followed, a package from
 * anywhere but the registry (git, another tarball, a directory by `file:`) or with no resolved URL, a
 * bundled package, a link but to a workspace, overrides, acceptDependencies, or a check that fails is
 * refused with a DeptreeError or a LockfileError saying where. Options of the wrong type throw a TypeError.
 *
 * @module @preventive/deptree/npm.js
 */

import type { CacheOptions, PackageBugs, PackageRepository } from '@preventive/upstream/npm.js';
import type { NodeType, Vfs } from '@preventive/vfs';

export { LockfileError } from '@preventive/lockfile/npm.js';

/**
 * Sets where @preventive/upstream caches what it fetches, which is unset until set
 *
 * Tarballs are fetched through it, the one place anything here touches a filesystem: before the network
 * it reads npm's cache, ~/.audit/cache/tgz and its own or stasis's default directory for one of the
 * lockfile's integrity, writing none of them, then this one, which it writes each tarball it fetches to.
 * `setCacheDir()` sets the default directory and `setCacheDir(false)` unsets it.
 */
export { setCacheDir } from '@preventive/upstream/npm.js';

/**
 * The machine npm would install on; Windows is refused, as npm links bins there with shims
 *
 * A package whose os, cpu, libc or engines the host does not take is left out where npm takes it as
 * optional, with what npm leaves out with it. One not optional is refused where its platform is not the
 * host's, as npm fails on it, and installed where its engines are not, as npm warns, unless engine-strict
 * is set; so for the root and each workspace. A libc a package names fails a host with none.
 */
export interface NpmHost {
  /** The npm that installs, exact: 10.9.3 to 10.9.9, or 11.11.1 to 11.21.0; no packageManager is read */
  npm: string;
  /** The Node npm runs on, exact, or left out for one unknown, which every engines.node and devEngines takes */
  node?: string;
  /** As Node names it, such as `linux` */
  os: string;
  /** As Node names it, such as `x64` */
  cpu: string;
  /** The C library npm finds on Linux, and left out elsewhere */
  libc?: 'glibc' | 'musl';
}

/**
 * A view of the lockfile's directory by paths from `/`, such as a Vfs; nothing is written to it
 *
 * Each method throws an error whose `code` is ENOENT, ENOTDIR or ELOOP for a path that leads nowhere.
 */
export interface NpmProject {
  readdir(path: string): string[];
  /** What a path is */
  lstat(path: string): { type: NodeType };
  /** What a path leads to */
  stat(path: string): { type: NodeType };
  readFile(path: string): Uint8Array;
}

/**
 * The files `npm ci` reads, either given as text or read from `project`
 *
 * Read, they are package-lock.json and the root's package.json, which have to be there; the package.json
 * of each directory the root's `workspaces` globs take, outside node_modules and on macOS whatever the case;
 * and the .npmrc. Each is UTF-8, and a refusal names it as it would given: `manifests["packages/x"]`.
 * Refused there: an npm-shrinkwrap.json, and a link the globs reach. Settings from anywhere else, NODE_ENV
 * among them, are taken at their defaults, and npm as run in the lockfile's directory.
 *
 * Of the .npmrc, as ini reads it before npm checks it (`bin-links=0` links bins): a setting that can change
 * what npm installs is read only as a bare key and value, neither quoted, escaped, cut at `;` or `#`, nor
 * taken from the environment. legacy-peer-deps, engine-strict and bin-links are followed, true or false;
 * install-strategy has to be hoisted, lockfile-version 1, 2 or 3, the allow-* settings all, and
 * install-links, force, dry-run, global, package-lock-only, usage and include-workspace-root false. omit,
 * include, production, dev, optional, os, cpu, libc, workspace, location, umask, prefix, the config paths,
 * allow-scripts, an unscoped credential, two exclusive settings together and a section are refused; any
 * other setting is passed over, as npm reads it for where it fetches from, how, or what it prints.
 */
export type NpmTreeOptions = NpmTreeGiven | NpmTreeRead;

export type NpmLayoutOptions = NpmTreeOptions & { sizeEstimateOnly: true; vfs?: undefined };

export type NpmLazyOptions = NpmTreeOptions & { lazy: true; sizeEstimateOnly?: false; vfs?: undefined };

interface NpmTreeShared {
  host: NpmHost;
  /**
   * A Vfs to mount the tree into, at the lockfile's directory, beside what it holds (default: a new one)
   *
   * One holding a node_modules, or on macOS a name that is one there, is refused before anything is
   * fetched. Nothing there is written over, and the tree is built and checked first, so a refusal leaves
   * it as it was. Not taken with `sizeEstimateOnly` or `lazy`.
   */
  vfs?: Vfs;
  /**
   * Fetch each registry package's version document by @preventive/upstream's getMeta, its dist held to the
   * lockfile's, for `commit`, `repository`, `homepage` and `bugs` (default: true)
   */
  metadata?: boolean;
  /** Where tarballs and version documents are kept, as @preventive/upstream's CacheOptions take it */
  cache?: CacheOptions['cache'];
  /**
   * Build the directories and links alone, fetching each package's version document and no tarball, and
   * list each package with its `size` (default: false)
   *
   * `size` is the document's dist.unpackedSize, the bytes of its files as the registry counted them, or
   * undefined. A package's tarball and files go unchecked, so a lockfile those checks refuse is laid out.
   */
  sizeEstimateOnly?: boolean;
  /**
   * Build the directories and links alone, fetching nothing, each package unpacked once the tree's
   * `unpack` asks for it, and fetched only then (default: false)
   *
   * An unpacked package is what the full tree has, file for file, with the bins it links fixed, and held
   * to every check the full tree holds it to; one never asked for is never fetched, nor refused.
   */
  lazy?: boolean;
  /**
   * The tree `--omit=dev` makes: each package only dev dependencies reach by the lockfile's flags left out,
   * with what is beneath it (default: false)
   *
   * npm 10 makes every directory before it leaves those out, leaving the directories they were in empty,
   * and holds each not optional to the host as without it; npm 11 holds to the host only the optional.
   */
  production?: boolean;
}

export interface NpmTreeGiven extends NpmTreeShared {
  lockfile: string;
  /**
   * Each project's package.json by its directory from the lockfile's, `.` for the root, as
   * findNpmWorkspaces lists them: every workspace npm would find, and those alone
   */
  manifests: Record<string, string> | Map<string, string>;
  npmrc?: string;
  project?: undefined;
}

export interface NpmTreeRead extends NpmTreeShared {
  lockfile?: undefined;
  manifests?: undefined;
  npmrc?: undefined;
  project: NpmProject;
}

/** What buildNpmTree counts */
export interface NpmTreeStats {
  /** The lockfile's, each a copy in a node_modules */
  packages: number;
  /** Those in the tree */
  installed: number;
  /** Those left out as the host cannot run them, or only such need them; not those `production` leaves out */
  skipped: number;
  /** Those fetched, each once; with `sizeEstimateOnly` by their document, with `lazy` as unpacked */
  tarballs: number;
  /** Written; 0 with `sizeEstimateOnly`, and with `lazy` as unpacked */
  files: number;
  /** Written; with `sizeEstimateOnly` the sizes of those installed, with `lazy` as unpacked */
  bytes: number;
  /** The workspaces linked */
  links: number;
}

/** A package in the tree, as an SBOM would list it */
export interface NpmInstalled {
  /** Where its files are, the lockfile's key of it, from the lockfile's directory */
  path: string;
  /** The package's own, whatever alias it is installed as */
  name: string;
  version: string;
  /** The sha512 its tarball is held to */
  integrity: string;
  /** Its version document's gitHead, where fetched and a full commit id: the publisher's word */
  commit: string | undefined;
  /** Its version document's, as getMeta reads it, where fetched; held to no repository */
  repository: string | PackageRepository | undefined;
  homepage: string | undefined;
  bugs: string | PackageBugs | undefined;
  /** Whether only dev dependencies reach it, as --omit=dev leaves out; none with `production` */
  dev: boolean;
  /** Whether only optional dependencies reach it, as --omit=optional leaves out */
  optional: boolean;
  /** Whether either does, or both together, as --omit=dev with --omit=optional leaves out */
  devOptional: boolean;
  /** Whether only peer dependencies reach it, as --omit=peer leaves out */
  peer: boolean;
}

export interface NpmTree {
  /** The Vfs given, the tree mounted into it, or a new one */
  vfs: Vfs;
  stats: NpmTreeStats;
  /** Each package in the tree, in the lockfile's order; no workspace, whose files the tree does not hold */
  installed: NpmInstalled[];
}

export interface NpmLaidOut extends NpmInstalled {
  /** dist.unpackedSize, or undefined where the document names none */
  size: number | undefined;
}

/** With `sizeEstimateOnly`: a new Vfs of the tree's directories and links */
export interface NpmLayout {
  vfs: Vfs;
  stats: NpmTreeStats;
  installed: NpmLaidOut[];
}

/** With `lazy`: a new Vfs of the tree's directories and links, and nothing a version document says yet */
export interface NpmLazyTree extends NpmTree {
  /**
   * Unpack the packages at `paths`, as `installed` lists them, a few tarballs at a time
   *
   * Each is unpacked once however often it is asked for, written whole or not at all; one refused rejects
   * this call and each after that asks for it, with the full tree's DeptreeError, once the rest are done.
   *
   * @param paths - Paths of packages; one the tree has no package at is a TypeError
   * @returns Their entries in that order, with what each version document says where `metadata` fetches it
   */
  unpack(paths: Iterable<string>): Promise<NpmInstalled[]>;
}

/**
 * The node_modules tree `npm ci --ignore-scripts` makes with host.npm into a project with no node_modules
 * yet
 *
 * Each package's files are unpacked where the lockfile puts it, and each workspace linked as
 * node_modules/<its name> by a relative link, with what is beneath it in its own node_modules; nothing else
 * of the projects is in the tree. Unpacked as npm's tar unpacks it: the first segment dropped, files alone
 * (no link, device or empty directory), modes with read and write for all and a 0o022 umask taken off, a
 * .gitignore renamed .npmignore unless one came before it, and directories 0o755.
 *
 * Scripts never run (a workspace with a prepare script, which npm 10 runs anyway, is refused), and no .bin
 * or .package-lock.json is written. Unless bin-links is false, each bin's target is changed as linking it
 * changes it: of a node_modules' packages, by path, the first bin of each name is linked, its target made
 * 0o755, and a CRLF shebang in its first 2048 bytes made LF. A target that is a directory, runs through a
 * file, or is in its own node_modules is refused, as is a workspace's bin in its node_modules, by
 * directories.bin, or under the root's allowScripts.
 *
 * Held to the lockfile reader's checks, with the flags npm installs by: npm 11 works them out again, npm 10
 * takes them as written unless the root asks for other than its entry to the letter. Each project's
 * package.json is held to its lockfile entry (the same names, lists and specs) and each workspace to its
 * name and version; the root's devEngines are checked against the host. Refused too, as npm's releases read
 * them otherwise: a wildcard before a number (`1.x.0`), and for npm 10 an optional peer the lockfile does
 * not meet. npm 10.9.9 and 11.18 on give up on a tarball inflating 1000 times what they read, so one near
 * that is refused.
 *
 * And held to what npm's lockfiles and the registry always hold: each tarball gzipped, under one directory,
 * named as tar reads it (no `\`, at most 1024 segments), with nothing in its own node_modules, no setuid,
 * setgid or sticky bit, no link name on a file, no global pax header but one of a comment alone (as git
 * archive writes its commit), no pax size ahead of another extended header, and the lockfile's sha512. On macOS, two names in a directory differing only in case or
 * normalization are refused. Each package's `resolved` has to be the registry's own tarball URL, a scope's
 * `/` as `%2f` or not, or that on yarn's mirror. Ranges are read with the semver of the npm beside node.
 *
 * @param options - The files, the host and where the tree goes
 * @returns The tree
 */
export function buildNpmTree(options: NpmLayoutOptions): Promise<NpmLayout>;
export function buildNpmTree(options: NpmLazyOptions): Promise<NpmLazyTree>;
export function buildNpmTree(options: NpmTreeOptions): Promise<NpmTree>;

export interface NpmWorkspacesOptions {
  project: NpmProject;
  /** `darwin` matches the globs whatever the case, as npm's glob does on macOS */
  os?: string;
}

/**
 * The directories of the projects npm finds in `project`, by which buildNpmTree takes their package.json
 * given; refused as buildNpmTree refuses them, as is a root with no package.json
 *
 * @returns `.` first, then each directory with a package.json a glob of the root's `workspaces` takes
 */
export function findNpmWorkspaces(options: NpmWorkspacesOptions): string[];

/** A refusal; `cause` is what a package beneath refused with, where one did */
export class DeptreeError extends Error {
  constructor(detail: string, where?: string, options?: { cause?: unknown });
  /** What it is about, which the message leads with (`.npmrc:3`, `packages["node_modules/a"]`), or undefined */
  where: string | undefined;
}
