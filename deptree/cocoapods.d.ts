import type { Client } from '@preventive/upstream/github.js'
import type { NodeType, Vfs } from '@preventive/vfs'

export { LockfileError } from '@preventive/lockfile/cocoapods.js'

// Where @preventive/upstream caches what it fetches, podspecs and GitHub's
// tarballs among them. Both are fetched through it, and that is the one
// place anything here touches a filesystem. Before the network, it takes a
// podspec from CocoaPods' own spec repos, under $CP_REPOS_DIR, else
// $CP_HOME_DIR/repos, else ~/.cocoapods/repos, where one there has the
// lockfile's checksum, and writes none of it; then from its own cache,
// where one is set, which is where it writes each it fetches --
// setCacheDir() sets the default one, and setCacheDir(false) unsets it;
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
// Podfile.rb that is a file, as CocoaPods looks for one. The lockfile is
// read as UTF-8, and refused where it is not; the Podfile as bytes, which
// are not read otherwise. Nothing is written to it.
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
  vfs?: Vfs
  github?: Client
}

export interface CocoaPodsTreeRead {
  lockfile?: undefined
  podfile?: undefined
  project: CocoaPodsProject
  host: CocoaPodsHost
  platforms?: CocoaPodsPlatform[]
  vfs?: Vfs
  github?: Client
}

// What buildCocoaPodsTree counts, all of it plain numbers: `pods` the
// lockfile's roots; `downloaded` those written into Pods/, each a podspec
// and a tarball fetched, and the others those by :path; `files` and
// `bytes` what is written, and `links` the symlinks.
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
// the root and its subspecs as PODS names them. `git` is the repository's
// URL as the podspec gives it, and `tag` the tag it names, or undefined
// where it names a commit; `commit` the commit checked out, which GitHub
// names for the tag, as the lockfile holds it to no hash.
export interface CocoaPodsInstalled {
  path: string
  name: string
  version: string
  checksum: string
  pods: string[]
  git: string
  tag: string | undefined
  commit: string
}

// `vfs` is the one given, the tree mounted into it, or a new one.
// `installed` is each pod downloaded, in the lockfile's order.
export interface CocoaPodsTree {
  vfs: Vfs
  stats: CocoaPodsTreeStats
  installed: CocoaPodsInstalled[]
}

// The pods' directories `pod install` makes in Pods/ from the lockfile,
// with host.cocoapods, in a project with no Pods directory yet, its
// install! options at their defaults and no hook that changes what is
// downloaded: rooted at the project's root, it holds Pods/<name> for each
// root CocoaPods downloads, and nothing else of the project; none at all
// where every pod is by :path, as CocoaPods reads those where they are.
// What CocoaPods writes beside them in Pods/ -- Manifest.lock, Local
// Podspecs, Headers, Target Support Files, Pods.xcodeproj -- is not
// written, nor is anything of the user's project.
//
// Each root's podspec is fetched from trunk and held to the lockfile's
// checksum, its sha1, with @preventive/upstream/cocoapods.js's getPodspec.
// Its `source` has to be a git repository on GitHub, by a tag or a full
// commit: CocoaPods clones it, `git clone --branch <tag> --depth 1` or a
// clone and a checkout of the commit, and here GitHub's tarball of the
// commit's tree is fetched instead, by `github`, which upstream holds to
// the tree GitHub names for the commit. A tag is taken to the commit
// GitHub names for it, through an annotated one, and is held to no hash,
// as the lockfile has none of what a podspec's source downloads; a tag of
// the name of a branch, which git's clone takes before it, is refused. A
// repository renamed or transferred since is fetched by the name GitHub
// gives it now, as upstream's getRepo follows that redirect with
// `followRedirect`. The checkout is as git writes one with no git config
// and a umask of 0o022: each directory 0o755, each file 0o644, or 0o755
// where git has it executable; each symlink a symlink to its target; a
// submodule an empty directory; a file the tree's .gitattributes mark
// `eol=crlf` with CRLF, as upstream reads them. What git config on the
// machine would change -- `core.autocrlf`, a filter such as Git LFS's --
// is not followed. GitHub's tarball is refused where upstream refuses it,
// and where the tar reader of @preventive/archive/tar.js does, and so is a
// path with a `.git` in it, in any case.
//
// What CocoaPods then keeps of the checkout is what it keeps: it cleans
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
// leads to, as lock_files! leaves it. A link CocoaPods follows to find
// whether it leads to a directory, which is every link, and which leads
// out of the download, is refused, as what it finds there is the
// machine's.
//
// What CocoaPods fails on is refused: a podspec that is not JSON, a value
// of a type it fails on, a source file that links to nothing, a pod named
// as what it writes beside the pods in Pods/. And what one release of
// CocoaPods or Ruby reads otherwise than another: a platform named in
// another case, or `xros`, and a value that breaks braces apart by a
// backslash. A pattern that expands to more than 4096 is refused, and so
// is a readme or a license of two files of one name but for case, of which
// CocoaPods takes either. On macOS, two names in one directory that differ
// only in case or normalization are refused, as they would be one name
// there.
//
// Pods come from trunk, as SPEC REPOS has it, by `trunk` or by the git
// repository of CocoaPods/Specs, or by :path: one from another spec repo,
// one from any other external source, one with a prepare_command, which
// CocoaPods runs as a script in the download, and one whose source is not
// git from GitHub, by a branch, or with its submodules, is refused.
//
// Nothing is left to a guess: a lockfile the lockfile reader refuses, a
// pod from anywhere but trunk, a check above that fails -- each is refused
// with a DeptreeError or a LockfileError that says where. A TypeError is
// thrown for options of the wrong type, and for a pod to download without
// `github`.
export function buildCocoaPodsTree(options: CocoaPodsTreeOptions): Promise<CocoaPodsTree>

// `where` is what a refusal is about -- `pods["Alamofire"]`, a path in a
// pod's download -- or undefined for the call as a whole; the message leads
// with it. `cause` is what a package beneath refused with, where one did.
export class DeptreeError extends Error {
  constructor(detail: string, where?: string, options?: { cause?: unknown })
  where: string | undefined
}
