/**
 * The node_modules tree `pnpm install --frozen-lockfile --ignore-scripts` makes, built in memory from a
 * pnpm lockfile: with the isolated linker of pnpm 10, 11 or 12, or the hoisted one of pnpm 10, 11 or 12
 *
 * ```js
 * import { buildPnpmTree, findPnpmProjects } from '@preventive/deptree/pnpm.js'
 * ```
 *
 * Packages come from https://registry.npmjs.org/ alone, through `@preventive/upstream`, each tarball
 * held to the lockfile's integrity and each patch to its hash, applied only where every hunk matches.
 * Nothing is left to a guess: whatever this does not build exactly as that pnpm would is refused with
 * a DeptreeError saying where.
 *
 * @module @preventive/deptree/pnpm.js
 */

import type { CacheOptions, PackageBugs, PackageRepository } from '@preventive/upstream/npm.js';
import type { NodeType, Vfs } from '@preventive/vfs';

/** What the lockfile reader and the YAML parser refuse with, as the `cause` of a DeptreeError naming the file */
export { LockfileError, YamlError } from '@preventive/lockfile/pnpm.js';

/**
 * Sets where `@preventive/upstream` caches the tarballs it fetches, or with false unsets it
 *
 * Before the network, a tarball is taken from npm's cache ($npm_config_cache or ~/.npm),
 * ~/.audit/cache/tgz, or upstream's or stasis's default cache, where one has the lockfile's integrity,
 * none of which is written. Unset, which it is until set, nothing is written, and a tarball is fetched
 * every time.
 */
export { setCacheDir } from '@preventive/upstream/npm.js';

/**
 * The machine pnpm would install on
 *
 * An optional package the host cannot run is left out, as pnpm leaves it out; supportedArchitectures in
 * the settings widens what is taken. Windows is refused, as pnpm links there with junctions to absolute
 * paths.
 */
export interface PnpmHost {
  /**
   * The pnpm that installs, a 10.x, 11.x or 12.x, each built for as it differs (12 checked from 12.8.1)
   *
   * Default: the one the root package.json's packageManager pins, which pnpm switches to.
   */
  pnpm?: string;
  /** The exact Node it runs on (default: the settings' nodeVersion, or pnpm 11's engines.runtime pin, else any) */
  node?: string;
  /** As Node names it, such as `linux` */
  os: string;
  /** As Node names it, such as `x64` */
  cpu: string;
  /** As pnpm names it, `unknown` outside Linux */
  libc: 'glibc' | 'musl' | 'unknown';
}

/**
 * A read-only view of the lockfile's directory, by paths from `/`: a Vfs, or one of a directory on disk
 *
 * Each method throws an error whose `code` is ENOENT, ENOTDIR or ELOOP for a path that leads nowhere.
 */
export interface PnpmProject {
  readdir(path: string): string[];
  lstat(path: string): { type: NodeType; mode: number };
  stat(path: string): { type: NodeType };
  readFile(path: string): Uint8Array;
}

/**
 * How the tree is built: from the files an install reads, given as text (PnpmTreeGiven) or read from
 * `project` as pnpm reads them from disk (PnpmTreeRead)
 *
 * Settings are read as `pnpm install` reads them for the host's pnpm: pnpm 10 the .npmrc, then
 * pnpm-workspace.yaml, then package.json's `pnpm` field, each over the one before; pnpm 11 and 12
 * pnpm-workspace.yaml alone, and of the .npmrc only its registries. Settings from anywhere else are at
 * their defaults. Each setting that can change the tree is held to what is built, and each other one is
 * passed over.
 */
export type PnpmTreeOptions = PnpmTreeGiven | PnpmTreeRead;

export type PnpmLayoutOptions = PnpmTreeOptions & { sizeEstimateOnly: true; vfs?: undefined };

export type PnpmLazyOptions = PnpmTreeOptions & { lazy: true; sizeEstimateOnly?: false; vfs?: undefined };

/** What both ways of giving the files take */
interface PnpmTreeCommon {
  host: PnpmHost;
  /**
   * A Vfs to mount the tree into at its root, the lockfile's directory, beside what it holds
   *
   * Default: a new one. One holding a node_modules anywhere is refused before anything is fetched;
   * nothing in it is written over, and a refusal leaves it as it was.
   */
  vfs?: Vfs;
  /**
   * Fetch each registry package's version document, through getMeta of `@preventive/upstream`, for its
   * commit, repository, homepage and bugs; its dist has to be the lockfile's (default: true)
   */
  metadata?: boolean;
  /**
   * Where tarballs and version documents are kept: setCacheDir's (the default), a store with `read` and
   * `write`, or false for nowhere
   */
  cache?: CacheOptions['cache'];
  /**
   * Lay out the directories and links alone, fetching no tarball: each copy is listed with the size
   * its version document gives (default: false)
   *
   * A package's files are not checked, but where they could change the layout, which is refused.
   */
  sizeEstimateOnly?: boolean;
  /**
   * Lay out the directories and links alone, fetching nothing, and unpack each package into the tree
   * once asked for by `unpack`, held then to every check the full tree holds it to (default: false)
   */
  lazy?: boolean;
  /**
   * Build the tree `--prod` makes, from the lockfile pnpm leaves of it, each project's devDependencies
   * dropped; all else is held to the whole lockfile (default: false)
   */
  production?: boolean;
}

/** The files given as text */
export interface PnpmTreeGiven extends PnpmTreeCommon {
  /** pnpm-lock.yaml */
  lockfile: string;
  /**
   * Each project's package.json, by its directory from the lockfile's as its importer is keyed, `.` for
   * the root: every project pnpm would find (findPnpmProjects), and no other
   */
  manifests: Record<string, string> | Map<string, string>;
  /** pnpm-workspace.yaml */
  workspace?: string;
  /** The .npmrc beside the lockfile */
  npmrc?: string;
  /** Each patch patchedDependencies names, by the path it names it by, and no other */
  patches?: Record<string, string> | Map<string, string>;
  /** Read only for the directories a `link:` or an override leads to, where it is given */
  project?: PnpmProject;
}

/** The files read from `project`, as pnpm reads them; none of them may be given */
export interface PnpmTreeRead extends PnpmTreeCommon {
  lockfile?: undefined;
  manifests?: undefined;
  workspace?: undefined;
  npmrc?: undefined;
  patches?: undefined;
  project: PnpmProject;
}

/** What a build counts */
export interface PnpmTreeStats {
  /** The importers */
  projects: number;
  /** The lockfile's snapshots */
  snapshots: number;
  /** The snapshots in the tree */
  installed: number;
  /** The optional ones left out, as the host cannot run them or only such reach them */
  skipped: number;
  /** Those installed though the host does not take their platform or engines, which pnpm warns of */
  incompatible: number;
  /** The packages fetched, each once; with `sizeEstimateOnly` by their version document, with `lazy` as unpacked */
  tarballs: number;
  /** The snapshots a patch is applied to */
  patched: number;
  /** The files written; 0 with `sizeEstimateOnly`, and with `lazy` those unpacked */
  files: number;
  /** Their bytes; with `sizeEstimateOnly`, the sizes of the copies installed */
  bytes: number;
  /** The symlinks */
  links: number;
}

/** A snapshot in the tree, as an SBOM would list it */
export interface PnpmInstalled {
  /** Where its files are, from the lockfile's directory: node_modules/.pnpm/<dir>/node_modules/<name>, or a hoisted copy's */
  path: string;
  /** The lockfile's snapshot key, its peers and patch hash in it */
  key: string;
  /** The package's own, which its package.json is held to */
  name: string;
  /** Undefined for a package installed from a directory */
  version: string | undefined;
  /** The sha512 its tarball is held to; undefined for a directory */
  integrity: string | undefined;
  /** The directory a `file:` override installs it from, from the lockfile's (`.` for its own) */
  directory: string | undefined;
  /** The gitHead of its version document, where `metadata` fetched it and it is a full commit id */
  commit: string | undefined;
  /** As its version document gives it: the publisher's word, held to no repository */
  repository: string | PackageRepository | undefined;
  homepage: string | undefined;
  bugs: string | PackageBugs | undefined;
  /** Whether devDependencies alone reach it, so `--prod` would leave it out */
  dev: boolean;
  /** Whether optional dependencies alone reach it, as the lockfile records */
  optional: boolean;
  /** The patch applied, by pnpm's hash and the path the settings name it by (the first, of two of one text) */
  patch: { hash: string; path: string } | undefined;
}

export interface PnpmTree {
  /** The one given, the tree mounted into it, or a new one */
  vfs: Vfs;
  stats: PnpmTreeStats;
  /** Each snapshot in the tree in lockfile order; with the hoisted linker each copy, in the order pnpm makes them */
  installed: PnpmInstalled[];
}

export interface PnpmLaidOut extends PnpmInstalled {
  /** Its version document's dist.unpackedSize, or a directory's files' bytes */
  size: number | undefined;
}

/** With `sizeEstimateOnly`: a new Vfs of the tree's directories and links */
export interface PnpmLayout {
  vfs: Vfs;
  stats: PnpmTreeStats;
  installed: PnpmLaidOut[];
}

/** With `lazy`: a new Vfs of the tree's directories and links, which `unpack` writes packages into */
export interface PnpmLazyTree extends PnpmTree {
  /**
   * Unpack the packages at `paths`, as `installed` lists them, a few fetched at a time
   *
   * Each is unpacked once, however often asked for, and written whole or not at all; one refused rejects
   * this call and each later one asking for it, with the DeptreeError the full tree is refused with. A
   * path the tree has no package at is a TypeError.
   *
   * @returns Their entries in that order, with what each version document says where `metadata` fetched it
   */
  unpack(paths: Iterable<string>): Promise<PnpmInstalled[]>;
}

/**
 * Build the node_modules tree a frozen, script-less install of `host.pnpm` makes
 *
 * Rooted at the lockfile's directory, with relative links, a `link:` leading where the lockfile says,
 * outside the tree. No .bin is written, nor pnpm's state, but each file a bin pnpm links runs is left as
 * linking leaves it: executable, and with a CRLF `#!` line made LF but by pnpm 12. Every file is its own,
 * as where pnpm clones or copies from its store. pnpm 11's and 12's ways of linking bins and hoisting
 * are built as each makes them; the hoisted linker as @yarnpkg/nm hoists for pnpm 10 and 11, and as pnpm
 * 12's own hoister does from 12.21.0, a copy where a project's `link:` goes moved aside to
 * .ignored_<name>; where packageImportMethod is copy, clone or clone-or-copy, refused past 50,000,000
 * weighted steps or 100,000 packages.
 *
 * The lockfile is held to what a frozen install holds it to: the settings it was resolved with
 * (catalogs, overrides, package extensions, patches, autoInstallPeers, dedupePeers,
 * peersSuffixMaxLength, optional dependencies left out), and each project's package.json read through
 * pnpm's read-package hook; with pnpm 11 and 12 to their further checks. It is held to more where every
 * lockfile pnpm writes and package the registry serves holds: each tarball gzipped, under one
 * directory, with no link or device, and with a package.json for exactly its name and version, whose
 * platforms, bins, bundled and other dependencies are what the lockfile records. On macOS, two names of
 * one directory that differ only in case or normalization are refused.
 *
 * Refused, among the rest: a setting not built for, a pnpmfile, an injected dependency, a package from
 * anywhere but the registry, a `file:` tarball, another package manager or a runtime to download, a
 * lockfile not up to date, two projects of one name, a patch that does not hash or apply or would change
 * a bin between two links, a file whose mode would turn on the order a directory is read in, and pnpm
 * 12's hoisted linker before 12.21.0, or with hoistingLimits, externalDependencies or autoInstallPeers
 * false.
 *
 * @param options - The files, the host, and how to build
 * @returns The tree, its counts, and the snapshots installed
 * @throws DeptreeError, naming where; TypeError for options of the wrong type
 */
export function buildPnpmTree(options: PnpmLayoutOptions): Promise<PnpmLayout>;
export function buildPnpmTree(options: PnpmLazyOptions): Promise<PnpmLazyTree>;
export function buildPnpmTree(options: PnpmTreeOptions): Promise<PnpmTree>;

export interface PnpmProjectsOptions {
  /** Read for pnpm-workspace.yaml, the root package.json and the directories pnpm walks into */
  project: PnpmProject;
  /** Default: the pnpm the root package.json's packageManager pins */
  host?: Pick<PnpmHost, 'pnpm'>;
}

/**
 * The directories of the projects pnpm finds, by which buildPnpmTree takes their package.json given
 *
 * pnpm-workspace.yaml's `packages` globs are followed as that pnpm follows them: `*`, `**` as a whole
 * name, and a leading `!`, never into a node_modules or bower_components or a dotted name no glob spells.
 * Refused: a root with no manifest, a manifest that is a link or not package.json, a project found
 * through a link, a path a lockfile could not key an importer by, and a pnpm-workspace.yaml pnpm refuses.
 *
 * @param options - The project, and the pnpm whose finding is followed
 * @returns `.` first, then each project, in the order that pnpm finds them
 */
export function findPnpmProjects(options: PnpmProjectsOptions): string[];

/** What anything here is refused with */
export class DeptreeError extends Error {
  constructor(detail: string, where?: string, options?: { cause?: unknown });
  /**
   * What the refusal is about, which the message leads with: `pnpm-workspace.yaml: nodeLinker`,
   * `.npmrc:3: node-linker`, a package's key; undefined for the call as a whole
   */
  where: string | undefined;
}
