import type { Client } from '@preventive/upstream/github.js'
import type { NodeType, Vfs } from '@preventive/vfs'

export { LockfileError } from '@preventive/lockfile/cocoapods.js'

// Where @preventive/upstream caches what it fetches, podspecs, GitHub's
// tarballs and archives by :http among them. Each is fetched through it,
// and that is the one place anything here touches a filesystem. Before the
// network, it takes a podspec from CocoaPods' own spec repos, under
// $CP_REPOS_DIR, else $CP_HOME_DIR/repos, else ~/.cocoapods/repos, where
// one there has the lockfile's checksum, and writes none of it; then from
// its own cache, where one is set, which is where it writes each it fetches
// -- setCacheDir() sets the default one, and setCacheDir(false) unsets it;
// unset, which it is until set, it writes nothing. CocoaPods' own download
// cache is never read. The project is read only through the view given as
// `project`, and the tree built in a Vfs.
export { setCacheDir } from '@preventive/upstream/npm.js'

// The machine CocoaPods would install on: `cocoapods` is the version that
// installs, exact, 1.13.0 to 1.17.x, which download, clean and lock a pod
// alike; `os` as Node names it -- `darwin` or `linux`. Windows is refused.
export interface CocoaPodsHost {
  cocoapods: string
  os: string
}

// What the Podfile's targets are for, as CocoaPods names a platform.
export type CocoaPodsPlatform = 'ios' | 'osx' | 'tvos' | 'visionos' | 'watchos'

// A view of the project's root, by paths from `/`: a Vfs, or anything with
// its readdir, lstat, stat and readFile, such as one of a directory on
// disk, of which only Podfile.lock and the Podfile are read there: the
// first of CocoaPods.podfile.yaml, CocoaPods.podfile, Podfile and
// Podfile.rb that is a file, as CocoaPods looks for one; and, where no
// `podspecs` are given, Pods/Local Podspecs/<name>.podspec.json for each
// pod by :podspec. The lockfile is read as UTF-8, and refused where it is
// not; the Podfile and the podspecs as bytes, the Podfile not read
// otherwise. Nothing is written to it.
export interface CocoaPodsProject {
  readdir(path: string): string[]
  lstat(path: string): { type: NodeType }
  stat(path: string): { type: NodeType }
  readFile(path: string): Uint8Array
}

// The files `pod install` reads at the project's root: Podfile.lock, and
// the Podfile, whose sha1 PODFILE CHECKSUM has to be, as CocoaPods resolves
// anew what a changed Podfile asks for. The Podfile is Ruby, and is not
// read otherwise: what it says beyond which pods it asks for -- the
// install! options, hooks, the targets and their platforms -- is not
// known here, and is taken to be as below.
//
// The two ways the files come, one or the other: given, with `lockfile`
// and, where it is, `podfile`, as text or bytes; or read, with `project`
// and neither of them. A Podfile given is held to PODFILE CHECKSUM as one
// read is; without one, nothing is.
//
// `platforms` are those the Podfile's targets are for, by CocoaPods' names;
// left out, any. A spec installed has to name the same files on each of
// those it takes, as the lockfile does not say which targets, of which
// platforms, it is installed for; one that names other files on another is
// refused. A spec for none of them is refused too.
//
// `podspecs` are the podspecs of the pods by :podspec, by name, each as
// text or bytes: the JSON CocoaPods writes of one as Pods/Local
// Podspecs/<name>.podspec.json, which is what SPEC CHECKSUMS has the sha1
// of, the podspec it evaluated and not its Ruby, which is not read here.
// Each is held to that checksum. Left out where `project` is given, those
// in the project's Pods/Local Podspecs are read; left out where `lockfile`
// is, there are none. One the lockfile has no pod by :podspec of is not
// read. A pod by :podspec without one is refused, or with `partial`
// skipped.
//
// `manifest` writes Pods/Manifest.lock too, CocoaPods' record of what is
// in Pods/: the lockfile's bytes, as CocoaPods writes the two alike, and
// as the Check Pods Manifest.lock phase of a build holds them to be. With
// it there, `pod install` downloads no pod whose directory is there and
// which the manifest has at the version, checksum, specs and dependency it
// resolves; it downloads only the pods whose directory is not there, or
// holds nothing but names that start with `.`, which it takes to be empty;
// then it generates the rest of Pods/ as it does. Without it, CocoaPods
// takes Pods/ to hold nothing, and downloads every pod again.
//
// `partial` skips each pod refused for where it is downloaded from, as the
// lockfile or its podspec says, rather than refusing the call: one from a
// spec repo but trunk, or an external source but :path and :podspec; one by
// :podspec without its podspec, or with CHECKOUT OPTIONS; one with a
// prepare_command; and one whose source is neither git from GitHub by a
// full commit, without its submodules, nor :http as below: one by a tag
// among them. Nothing is written for it, and it is listed in `skipped`, for
// CocoaPods to download: with `manifest`, it downloads those and no other.
// A podspec is held to the lockfile's checksum all the same, and an archive
// to its hash. Every other refusal stands. So everything written is held to
// a hash the lockfile holds, or that a podspec it holds does, whether
// `partial` is given or not.
//
// `vfs` is a Vfs to mount the tree into, at its root, which is taken to be
// the project's -- it may be `project` too; without one, a new Vfs holds
// the tree alone. A Vfs that holds a `Pods` at its root, or on macOS a name
// that is one there, is refused before anything is fetched, as CocoaPods
// keeps and removes what is in it by its own record of it. Nothing there
// is written over: each directory the tree has is one there or is made,
// and every file is written where nothing is. The tree is built, and held
// to every check below, before any of it is written, so a refusal leaves
// the Vfs as it was.
//
// `github` is the client from @preventive/upstream/github.js's createClient
// each pod is fetched through, with whatever token it was made with, or
// none. It is needed only where the lockfile has a pod CocoaPods
// downloads, and there it is a TypeError to leave it out, before anything
// is fetched.
export type CocoaPodsTreeOptions = CocoaPodsTreeGiven | CocoaPodsTreeRead

export interface CocoaPodsTreeGiven {
  lockfile: string
  podfile?: string | Uint8Array
  project?: undefined
  host: CocoaPodsHost
  platforms?: CocoaPodsPlatform[]
  podspecs?: Record<string, string | Uint8Array>
  manifest?: boolean
  partial?: boolean
  vfs?: Vfs
  github?: Client
}

export interface CocoaPodsTreeRead {
  lockfile?: undefined
  podfile?: undefined
  project: CocoaPodsProject
  host: CocoaPodsHost
  platforms?: CocoaPodsPlatform[]
  podspecs?: Record<string, string | Uint8Array>
  manifest?: boolean
  partial?: boolean
  vfs?: Vfs
  github?: Client
}

// What buildCocoaPodsTree counts, all of it plain numbers: `pods` the
// lockfile's roots; `downloaded` those written into Pods/, each a podspec
// and a tarball or an archive fetched, and the others those by :path, or
// skipped;
// `files` and `bytes` what is written, Manifest.lock among them, and
// `links` the symlinks.
export interface CocoaPodsTreeStats {
  pods: number
  downloaded: number
  files: number
  bytes: number
  links: number
}

// A pod in the tree, as an SBOM would list it: `path` is its directory,
// from the project's root, which is `/` of the Vfs -- Pods/<name>; `name`
// and `version` the lockfile's, of the root; `checksum` the hex sha1 its
// podspec is held to, SPEC CHECKSUMS'; `pods` the specs of it installed,
// the root and its subspecs as PODS names them.
export type CocoaPodsInstalled = CocoaPodsInstalledGit | CocoaPodsInstalledHttp

export interface CocoaPodsInstalledPod {
  path: string
  name: string
  version: string
  checksum: string
  pods: string[]
}

// From git: `git` is the repository's URL as the podspec gives it, and
// `commit` the commit the podspec names, which is checked out.
export interface CocoaPodsInstalledGit extends CocoaPodsInstalledPod {
  git: string
  commit: string
}

// By :http: `http` is the archive's URL as the podspec gives it, and
// `sha256` the podspec's hash of it, which it is held to.
export interface CocoaPodsInstalledHttp extends CocoaPodsInstalledPod {
  http: string
  sha256: string
}

// A pod `partial` skips: `name` and `version` the lockfile's, of the root;
// `reason` the refusal's message, as the call throws it without `partial`,
// leading with `pods["<name>"]`.
export interface CocoaPodsSkipped {
  name: string
  version: string
  reason: string
}

// `vfs` is the one given, the tree mounted into it, or a new one.
// `installed` is each pod downloaded, in the lockfile's order; `skipped`
// each pod `partial` skips, in the lockfile's order, and none without it.
export interface CocoaPodsTree {
  vfs: Vfs
  stats: CocoaPodsTreeStats
  installed: CocoaPodsInstalled[]
  skipped: CocoaPodsSkipped[]
}

// The pods' directories `pod install` makes in Pods/ from the lockfile,
// with host.cocoapods, in a project with no Pods directory yet, its
// install! options at their defaults and no hook that changes what is
// downloaded, CocoaPods' download cache used, as it is unless
// COCOAPODS_SKIP_CACHE is set, and each pod in one pod target, as where
// the Podfile's targets that use a pod ask for the same specs of it: where
// they ask for others, CocoaPods makes a pod target of each, and makes the
// source files of the first of them read-only alone, which is not followed,
// as the lockfile has the specs of them all and not which target has
// which. The project's path and the cache's, ~/Library/Caches/CocoaPods or
// $CP_CACHE_DIR, are taken to have none of a glob's `*`, `?`, `[`, `]`, `{`
// and `}`, and to be as NFKC normalizes them, as CocoaPods cleans a pod's
// directory by its path as it is. Rooted at the project's root, it holds
// Pods/<name> for each root CocoaPods downloads, but those `partial`
// skips, and nothing else of the project; none at all where every pod is
// by :path, as CocoaPods reads those where they are. What CocoaPods writes
// beside them in Pods/ -- Manifest.lock, Local Podspecs, Headers, Target
// Support Files, Pods.xcodeproj -- is not written, but Manifest.lock with
// `manifest`, which is written whatever pods there are; nor is anything of
// the user's project.
//
// Each root's podspec is fetched from trunk and held to the lockfile's
// checksum, its sha1, with @preventive/upstream/cocoapods.js's getPodspec;
// that of a pod by :podspec is `podspecs`', held to it alike. Its `source`
// has to be a git repository on GitHub, by a full commit, or an archive on
// GitHub by :http, as below. A git source by a tag is refused: CocoaPods
// records no commit for one, and GitHub can move it, so nothing would hold
// what is downloaded to a hash. Of git, CocoaPods clones the repository and
// checks the commit out, and here GitHub's tarball of the commit's tree is
// fetched instead, by `github`: the tree read off the commit's own object,
// which upstream's getCommitTree fetches from github.com as git fetches it
// and holds to the commit's id, so that it is the commit's whatever
// GitHub's API says; and the tarball, which getRepoTreeTarball holds to
// that tree. A repository renamed or transferred since is fetched by the
// name GitHub gives it now, as upstream's getRepo follows that redirect
// with `followRedirect`. The checkout is as git writes one with no git
// config and a umask of 0o022: each directory 0o755, each file 0o644, or
// 0o755 where git has it executable; each symlink a symlink to its target;
// a submodule an empty directory; a file the tree's .gitattributes mark
// `eol=crlf` with CRLF, as upstream reads them. What git config on the
// machine would change -- `core.autocrlf`, a filter such as Git LFS's -- is
// not followed. GitHub's tarball is refused where upstream refuses it, and
// where the tar reader of @preventive/archive/tar.js does, and so is a path
// git refuses to check out: one with a `.git` in it, or its short name
// `git~1`, in any case, dots and spaces after it, or a `:` after that. A
// commit the podspec names has to be in the history of the repository's
// default branch, as GitHub answers for a commit of any fork, and for one
// no branch or tag reaches, which a clone does not have; one on another
// branch alone is refused too.
//
// An archive by :http has to be on GitHub, over https: its URL
// https://github.com/<owner>/<repo>/ and a path under it, such as GitHub's
// archive of a tag or a release's asset, with no query, fragment,
// credentials or port, each segment of the path letters, digits, `_`, `.`,
// `~`, `@`, `-` or a %-escape in capitals. The podspec has to hold it to
// its :sha256, in lowercase hex, as RemoteFile checks one before a :sha1,
// and does: so the lockfile's checksum of the podspec is the archive's as
// well. One held to a :sha1 alone, which two archives can be made to share,
// is refused. It is fetched with upstream's getPodArchive, which
// follows GitHub's redirects and holds the bytes to that hash. It has to be
// of a type RemoteFile extracts with `tar xf`, by :type or else by the end
// of its URL's path -- tgz, tar, tbz or txz; and is read by what it is, as
// `tar xf` reads it, a tar gzipped or not, as GNU tar and bsdtar extract
// one for a user other than root, under a umask of 0o022: each file of its
// mode but the group's and others' write, each symlink to its target, a
// hard link a copy of what it links to, as CocoaPods' copies into its cache
// and into Pods/ make it. It is then flattened as RemoteFile flattens it,
// by :flatten where that is given, as Ruby reads a value, and else always:
// where it holds one thing, and that a directory, its contents in its
// place. What one machine's tar would make otherwise than another's is
// refused: another compression than gzip, which `tar xf` would read; a
// setuid, setgid or sticky bit; a directory its owner cannot list and write
// in, or a file it cannot read, which CocoaPods' cleaner and copy would
// fail on; a name starting with `._`, which bsdtar on macOS reads as the
// extended attributes of another; a `.git` in a path; a FIFO or a device.
// So is what RemoteFile's moves would meet: the name it downloads the
// archive under, `file.<type>`, at its root; the one thing to flatten a
// link, or of a name ending in `.`, or holding its name and `.tmp`. An
// :http source with :headers, which curl sends, is refused, and so is a
// zip and a dmg.
//
// Every podspec is fetched and held to all that it says, below as here,
// before any tarball or archive is fetched, so that a pod refused costs no
// download; a tarball or an archive is fetched once, for all the pods of
// it.
//
// What CocoaPods then keeps of the download is what it keeps: it cleans
// the download in its cache, by the file patterns of every spec of the
// podspec on every platform each takes, copies that into Pods/, and cleans
// it again there by those of the specs the lockfile installs, each a
// Sandbox::PodDirCleaner, with a FileAccessor per spec and platform over a
// PathList of what is there. Each is followed as CocoaPods has it, with
// File.fnmatch as Ruby has it, case folded for ASCII alone: a pattern that
// is a path there taken as it is, else one that names a directory with
// what lies under it, then the braces expanded as PathList expands them
// and matched; exclude_files taken out; the readme and the license the
// first found where the podspec names no license file there; a path
// removed with all under it but where it ends in `.` or, downcased, it is a
// used file's path or one of the two is at the start of the other, as
// Ruby's `include?` finds it in the pod's directory's path. Each source
// file is then made read-only by its owner, through a link to the file it
// leads to, as lock_files! leaves it. A link is followed as the machine
// follows it, on macOS to a name whatever its case and normalization, up to
// 40 links on the way on Linux and 32 on macOS, past which the path leads
// nowhere, and a link to nothing at all leads nowhere. A link CocoaPods
// follows to find whether it leads to a directory, which is every link, and
// which leads out of the download, is refused, as what it finds there is
// the machine's.
//
// What CocoaPods fails on is refused: a podspec that is not JSON, a value
// of a type it fails on, a source file that links to nothing, a pod named
// as what it writes beside the pods in Pods/, a path in the download of
// 4096 bytes or more on Linux, 1024 on macOS, or with a name of more than
// 255. So is what CocoaPods cleans otherwise than its patterns say: a pod
// named with a glob's `*`, `?`, `[`, `]`, `{` or `}`, whose directory it
// then cleans by that glob; and, from 1.13 to 1.15, a pod whose patterns
// keep the .git of the clone that they copy into their cache, as what is in
// it is not known. And what one release of CocoaPods or Ruby reads
// otherwise than another: a platform named in another case, or `xros`; a
// value that breaks braces apart by a backslash; a path, a link's target or
// a pattern with a letter whose case Ruby maps otherwise in a release from
// 2.6 on than in another, as one encoded after Unicode 12.1. A pattern
// longer than 4096 characters, or that expands to more than 4096, is
// refused, and so is a pod whose patterns take more than 200,000,000
// matches of a path to clean it, and a readme or a license of two files of
// one name but for case, of which CocoaPods takes either. On macOS, a
// download with two names in one directory that differ only in case or
// normalization is refused, as they would be one name there and git's
// checkout writes one of them alone, whatever CocoaPods keeps of it.
//
// Pods come from trunk, as SPEC REPOS has it, by `trunk` or by the git
// repository of CocoaPods/Specs, by :podspec, or by :path: one from another
// spec repo, one from any other external source, one by :podspec that
// CHECKOUT OPTIONS has, which CocoaPods downloads by those, one with a
// prepare_command, which CocoaPods runs as a script in the download, and
// one whose source is neither git from GitHub, by a full commit and
// without its submodules, nor :http as above, is refused, or with `partial`
// skipped: one by a tag or a branch among them.
//
// Nothing is left to a guess: a lockfile the lockfile reader refuses, a pod
// from anywhere but trunk and :podspec, a check above that fails -- each is
// refused with a DeptreeError or a LockfileError that says where. A
// TypeError is thrown for options of the wrong type, and for a pod to
// download without `github`.
export function buildCocoaPodsTree(options: CocoaPodsTreeOptions): Promise<CocoaPodsTree>

// `where` is what a refusal is about -- `pods["Alamofire"]`, a path in a
// pod's download -- or undefined for the call as a whole; the message leads
// with it. `cause` is what a package beneath refused with, where one did.
export class DeptreeError extends Error {
  constructor(detail: string, where?: string, options?: { cause?: unknown })
  where: string | undefined
}
