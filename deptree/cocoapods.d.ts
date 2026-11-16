/**
 * The pods' directories `pod install` makes in Pods/ from a Podfile.lock, built in memory
 *
 * ```js
 * import { buildCocoaPodsTree } from '@preventive/deptree/cocoapods.js'
 * ```
 *
 * Each podspec, tarball and archive is fetched through `@preventive/upstream`: a podspec from CocoaPods'
 * own spec repos ($CP_REPOS_DIR, $CP_HOME_DIR/repos or ~/.cocoapods/repos) where one there has the
 * lockfile's checksum, which are never written, else its own cache (`setCacheDir`). That is the one place
 * a filesystem is touched. Nothing is left to a guess: what CocoaPods would read otherwise, what one
 * release of it or of Ruby reads otherwise than another, or what this cannot reproduce exactly, is refused.
 *
 * @module @preventive/deptree/cocoapods.js
 */

import type { Client } from '@preventive/upstream/github.js';
import type { NodeType, Vfs } from '@preventive/vfs';

export { LockfileError } from '@preventive/lockfile/cocoapods.js';

// Where `@preventive/upstream` caches podspecs, tarballs and archives: setCacheDir() the default, false none, as until set
export { setCacheDir } from '@preventive/upstream/npm.js';

/** The machine CocoaPods would install on */
export interface CocoaPodsHost {
  /** The exact CocoaPods that installs, 1.13.0 to 1.17.x */
  cocoapods: string;
  /** As Node names it, `darwin` or `linux` */
  os: string;
}

/** A platform the Podfile's targets are for, as CocoaPods names it */
export type CocoaPodsPlatform = 'ios' | 'osx' | 'tvos' | 'visionos' | 'watchos';

/**
 * The project's root, by paths from `/`: a Vfs, or anything with these methods, such as a view of a
 * directory on disk. Only Podfile.lock (as UTF-8), the Podfile (the first of CocoaPods.podfile.yaml,
 * CocoaPods.podfile, Podfile and Podfile.rb) and, without `podspecs`, Pods/Local
 * Podspecs/<name>.podspec.json are read; nothing is written.
 */
export interface CocoaPodsProject {
  readdir(path: string): string[];
  lstat(path: string): { type: NodeType };
  stat(path: string): { type: NodeType };
  readFile(path: string): Uint8Array;
}

/**
 * The files `pod install` reads, given (`lockfile`, and `podfile` as text or bytes) or read from `project`
 *
 * The Podfile is held to PODFILE CHECKSUM and not read otherwise: its install! options, hooks, targets and
 * platforms are taken to be as `buildCocoaPodsTree` describes. Without a Podfile given, nothing is.
 */
export type CocoaPodsTreeOptions = CocoaPodsTreeGiven | CocoaPodsTreeRead;

/** A download, or what is left of one, by paths from the pod's directory */
export interface CocoaPodsContents {
  dirs: Iterable<string>;
  files: Map<string, { data: Uint8Array; mode: number }>;
  /** Each symlink's target */
  links: Map<string, string>;
}

/** What `prepare` is called with */
export interface CocoaPodsPrepare {
  name: string;
  version: string;
  /** The prepare_command, as the podspec gives it */
  command: string;
  /** A copy of the download */
  contents: CocoaPodsContents;
}

interface CocoaPodsTreeCommon {
  host: CocoaPodsHost;
  /**
   * What the Podfile's targets are for (default: any). A spec installed has to name the same files on
   * each of them it takes, as the lockfile does not say which it is installed for, and one for none of
   * them is refused.
   */
  platforms?: CocoaPodsPlatform[];
  /**
   * The podspecs of pods by :podspec, by name, as the JSON CocoaPods writes as Pods/Local
   * Podspecs/<name>.podspec.json, each held to SPEC CHECKSUMS (default: the project's, or none). A pod
   * by :podspec without one is refused, or with `partial` skipped.
   */
  podspecs?: Record<string, string | Uint8Array>;
  /**
   * Write Pods/Manifest.lock too, the lockfile's bytes, as CocoaPods does. With it there, `pod install`
   * downloads only the pods whose directory is missing or holds only names starting with `.`; without
   * it, every pod again.
   */
  manifest?: boolean;
  /**
   * Skip, rather than refuse, each pod refused for where it is downloaded from, listing it in `skipped`
   * for CocoaPods to download: one from a spec repo but trunk or an external source but :path and
   * :podspec, one by :podspec without its podspec or with CHECKOUT OPTIONS, one with a prepare_command
   * without `prepare`, and one whose source is not one supported, such as a tag. Hashes hold all the same.
   */
  partial?: boolean;
  /** The pods to download, by the lockfile's names, each once; no other is looked at (default: every pod) */
  only?: string[];
  /**
   * Run a pod's prepare_command, which nothing here runs, giving back the contents as they are after it,
   * which are then cleaned. No hash holds what it makes; without it, such a pod is refused or skipped.
   */
  prepare?: (pod: CocoaPodsPrepare) => CocoaPodsContents | Promise<CocoaPodsContents>;
  /**
   * A Vfs to mount the tree into, at the project's root (it may be `project`), or a new one. One that
   * holds a `Pods` (on macOS, a name that is one there) is refused before anything is fetched. Nothing
   * there is written over, and a refusal leaves it as it was.
   */
  vfs?: Vfs;
  /** From upstream's `createClient`, which each pod is fetched through; a TypeError where one is downloaded without it */
  github?: Client;
}

export interface CocoaPodsTreeGiven extends CocoaPodsTreeCommon {
  lockfile: string;
  podfile?: string | Uint8Array;
  project?: undefined;
}

export interface CocoaPodsTreeRead extends CocoaPodsTreeCommon {
  lockfile?: undefined;
  podfile?: undefined;
  project: CocoaPodsProject;
}

/** What was installed */
export interface CocoaPodsTreeStats {
  /** The lockfile's roots */
  pods: number;
  /** Those written into Pods/, each a podspec and a tarball or archive fetched; the rest by :path, or skipped */
  downloaded: number;
  /** Files written, Manifest.lock among them */
  files: number;
  /** Bytes written */
  bytes: number;
  /** Symlinks written */
  links: number;
}

/** A pod as an SBOM would list it */
export type CocoaPodsInstalled = CocoaPodsInstalledGit | CocoaPodsInstalledHttp;

export interface CocoaPodsInstalledPod {
  /** `Pods/<name>`, from the project's root */
  path: string;
  /** The root's, as the lockfile has it */
  name: string;
  version: string;
  /** The hex sha1 its podspec is held to, SPEC CHECKSUMS' */
  checksum: string;
  /** The specs installed, as PODS names them */
  pods: string[];
}

export interface CocoaPodsInstalledGit extends CocoaPodsInstalledPod {
  /** The repository's URL, as the podspec gives it */
  git: string;
  /** The commit the podspec names, which is checked out */
  commit: string;
}

export interface CocoaPodsInstalledHttp extends CocoaPodsInstalledPod {
  /** The archive's URL, as the podspec gives it */
  http: string;
  /** The podspec's hash of it, which it is held to */
  sha256: string;
}

/** A pod `partial` skips */
export interface CocoaPodsSkipped {
  name: string;
  version: string;
  /** What the call would throw without `partial`, leading with `pods["<name>"]` */
  reason: string;
}

export interface CocoaPodsTree {
  /** The one given, the tree mounted into it, or a new one */
  vfs: Vfs;
  stats: CocoaPodsTreeStats;
  /** In the lockfile's order */
  installed: CocoaPodsInstalled[];
  /** In the lockfile's order; none without `partial` */
  skipped: CocoaPodsSkipped[];
}

/**
 * The pods' directories `pod install` makes, with `host.cocoapods`, in a project with no Pods directory
 * yet: `Pods/<name>` for each root CocoaPods downloads, and nothing else but Manifest.lock with `manifest`
 *
 * Taken to be as they are by default: the install! options, no hook that changes a download, CocoaPods'
 * download cache used, each pod in one pod target, and the project's and cache's paths with no glob
 * character and as NFKC normalizes them, as CocoaPods cleans by them. A pod by :path is read where it is.
 *
 * Each root's podspec is fetched from trunk (a :podspec one is `podspecs`'), held to the lockfile's sha1,
 * and every podspec is checked whole before any download, each download fetched once for all its pods.
 * Its source has to be one of:
 * - git from GitHub by a full commit, without submodules: the tarball of the commit's tree, held to the
 *   commit's id and in the history of the default branch, written as git checks out with no config under
 *   a 0o022 umask. A tag is refused, as nothing would hold it to a hash. Refused: what upstream or
 *   `@preventive/archive/tar.js` refuses, and a path git refuses to check out (a `.git` or `git~1` in it).
 * - :http from https://github.com/<owner>/<repo>/ or, a .tar.gz or .zip, from Maven Central's
 *   com/facebook/, as `isPodArchiveUrl` takes a URL, held to its lowercase :sha256 (a :sha1 alone, or no
 *   hash, is refused), of the type RemoteFile reads off :type or the URL; a dmg, or :headers, is refused.
 *
 * A tar is read as GNU tar and bsdtar extract it for a user but root under a 0o022 umask, a hard link a
 * copy of its target; refused is what one machine's tar makes otherwise than another's: compression but
 * gzip, a zip, a setuid, setgid or sticky bit, a directory its owner cannot list and write in or a file it
 * cannot read, a name starting with `._`, a `.git`, a FIFO or a device. A zip is read as Info-ZIP's unzip
 * 6.0 extracts it; refused is what unzip would ask about or write otherwise than `@preventive/archive/zip.js`
 * reads it: an empty archive, a name again, PKZIP past 4.5, VMS, an Amiga or THEOS maker, a name outside
 * ASCII or ending in `.` or `;` and digits, the same modes as of a tar, a `.git`. Either is flattened as
 * RemoteFile flattens it; what its moves would meet is refused.
 *
 * The download is cleaned as CocoaPods' PodDirCleaner cleans it, by every spec on every platform in the
 * cache and by the specs installed in Pods/, with File.fnmatch as Ruby has it, and each source file made
 * read-only by its owner, as lock_files! leaves it. A link is followed as the machine follows it; one
 * that leads out of the download is refused. Refused too:
 * - what CocoaPods fails on: a podspec that is not JSON, a value of a type it fails on, a source file
 *   linking to nothing, a pod named as what it writes in Pods/, a path or name too long for the machine
 * - what it cleans otherwise than the patterns say: a pod named with a glob character, and before 1.16
 *   patterns that keep the clone's .git
 * - what one release reads otherwise than another: a platform in another case or `xros`, a backslash in
 *   braces, a letter whose case Ruby maps otherwise from 2.6 on
 * - a pattern over 4096 characters or expanding to over 4096, a pod taking over 200,000,000 matches to
 *   clean, a readme or license of two files one name but for case
 * - on macOS, two names in a download that are one there
 *
 * A pod from a spec repo but trunk, from an external source but :podspec and :path, by :podspec with
 * CHECKOUT OPTIONS, with a prepare_command and no `prepare`, or of a source not above is refused, or
 * with `partial` skipped.
 *
 * @param options - The files and where to build
 * @returns The tree, what it holds, its pods, and those skipped
 * @throws DeptreeError or LockfileError saying where; TypeError for options of the wrong type, or a pod
 *   to download without `github`
 */
export function buildCocoaPodsTree(options: CocoaPodsTreeOptions): Promise<CocoaPodsTree>;

/** A refusal */
export class DeptreeError extends Error {
  constructor(detail: string, where?: string, options?: { cause?: unknown });
  /** What it is about, such as `pods["Alamofire"]`, which the message leads with; undefined for the call */
  where: string | undefined;
}
