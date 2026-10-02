// Hand-written against cocoapods.js; a change to either belongs with the other.

// Reads a Podfile.lock as CocoaPods 1.5 to 1.17 write it, laid out as they
// lay it out, with the quoting of the release COCOAPODS names: from 1.10,
// `yes`, `no`, `on` and `off` quoted, and from 1.13 what reads as a date.
// Its values are read as CocoaPods reads them back, with Psych: a plain
// value Psych reads as a number, a date or null, where CocoaPods wrote a
// string, is refused; so is an escape but `\"` and `\\` in a quoted one,
// such as the `\#` CocoaPods writes before `{`, `$` and `@`, which Psych
// does not read. So is a control, format, private-use or unassigned
// character anywhere, and a line end of another kind than the first.
//
// Each section is held to the others, as Lockfile.generate writes them:
// every pod is reached from the Podfile's dependencies; each root is at one
// version, has a checksum, and comes from one spec repo or from an
// external source, which a dependency of the Podfile describes as
// Dependency#to_s does, and which has the checkout options CocoaPods keeps
// of it. What a pod's podspec depends on may name no pod in PODS: CocoaPods
// lists what it depends on on every platform, and installs it on fewer.
// Requirements are read, not held to the versions they ask for.
//
// Throws a LockfileError for anything CocoaPods would not write, or would
// read otherwise, and a TypeError for bad arguments. CocoaPods writes an
// absolute path and one from a home directory, `~/MyPod`, as a Podfile
// gives either for `:path` or `:podspec`; each is refused, as a lockfile
// with one reads on the machine that wrote it alone. So is a repository in
// which git or ssh would read an option, or that names a remote helper, a
// spec repo's among them, and a revision, tag, branch or folder of hg or
// svn that starts with `-` or has ` --` in it, which hg or svn would read
// as an option, and cocoapods-downloader refuses of hg.
export function parsePodfileLock(text: string, options?: PodfileLockOptions): PodfileLock

export interface PodfileLockOptions {
  // The Podfile the lockfile was written for, its text or its bytes, which
  // PODFILE CHECKSUM has to be the sha1 of, as CocoaPods hashes the file's
  // bytes: text is hashed as UTF-8, a byte order mark included. The Podfile
  // is Ruby, and is not read otherwise.
  podfile?: string | Uint8Array
}

// `where` is a property path into the lockfile, `PODS[3]`, `["EXTERNAL
// SOURCES"].Then[":branch"]`; undefined for the file's layout, whose
// message has the line.
export class LockfileError extends Error {
  constructor(detail: string, where?: string)
  where: string | undefined
}

// Every Record has a null prototype, and is in the order the file has it.

export interface PodfileLock {
  // COCOAPODS: the version of CocoaPods that wrote the file.
  cocoapods: string
  // The hex sha1 of the Podfile; undefined where it was not read from a
  // file, which `pod install` always reads it from.
  podfileChecksum: string | undefined
  // By name, `Firebase/Core` for a subspec: every pod installed.
  pods: Record<string, Pod>
  // By the name of a root, `Firebase`: where its pods come from.
  roots: Record<string, PodRoot>
  // What the Podfile asks for: a name may be listed more than once, each
  // asked for by another target.
  dependencies: PodfileDependency[]
}

export interface Pod {
  name: string
  // Its root's name: the name before the first `/`.
  root: string
  // As its podspec has it, a root's and its subspecs' one.
  version: string
  // What its podspec depends on, on every platform the podspec names.
  dependencies: PodDependency[]
}

export interface PodDependency {
  name: string
  // Each `operator version`, as CocoaPods writes them: `~> 5.0`, `= 1.2`.
  // None for any version.
  requirements: string[]
}

// One of an external source has no requirements: the source is its root's.
export interface PodfileDependency extends PodDependency {
  external: boolean
}

export interface PodRoot {
  name: string
  version: string
  // The pods of the root, by name: the root itself, its subspecs, or both.
  pods: string[]
  // The hex sha1 of the podspec CocoaPods read: a spec repo's, as it is
  // there, or of one from an external source, the JSON it wrote under
  // Pods/Local Podspecs.
  checksum: string
  // The spec repo it comes from, by URL, or `trunk` for the CDN; undefined
  // where it comes from an external source.
  repo: string | undefined
  external: PodExternalSource | undefined
  // What CocoaPods downloaded it by, to download it again. Of a pod by
  // `:podspec`, by the source its podspec names, where CocoaPods resolved
  // that to a commit or a revision: a branch, or no reference at all. Of
  // one by `:path`, nothing. Of a file, by `external`'s options. Of any
  // other, by `external`'s options where they name what to download, a
  // commit, a revision or a tag, and else by the commit or the revision
  // they came to, with git's `:submodules` where they ask for them; a git
  // branch is resolved to a commit first, where git finds it.
  checkout: PodDownload | undefined
}

// By `:path`, from the Podfile's directory, as the Podfile gives it, `./`
// and a `/` at the end kept; or by `:podspec`, such a path or an http(s)
// URL. `options` are the others given beside it,
// strings all, which CocoaPods carries and does not read.
export type PodExternalSource =
  | { type: 'path', path: string, options: Record<string, string> }
  | { type: 'podspec', podspec: string, options: Record<string, string> }
  | PodDownload

// By one of cocoapods-downloader's strategies, an option left out
// undefined. A commit is a hash, in hex of either case, and may be short:
// a revision of another form, `main` or `v1~2`, which git checks out and
// CocoaPods keeps as it is, is refused, as it locks no commit. A sha1 or a
// sha256 is the file's, in hex; `fileType` is RemoteFile's `:type`.
export type PodDownload =
  | { type: 'git', url: string, commit: string | undefined, tag: string | undefined, branch: string | undefined, submodules: boolean | undefined }
  | { type: 'hg', url: string, revision: string | undefined, tag: string | undefined, branch: string | undefined }
  | { type: 'svn', url: string, revision: string | undefined, tag: string | undefined, folder: string | undefined, externals: boolean | undefined, checkout: boolean | undefined }
  | {
    type: 'http' | 'scp'
    url: string
    fileType: 'zip' | 'tgz' | 'tar' | 'tbz' | 'txz' | 'dmg' | undefined
    flatten: boolean | undefined
    sha1: string | undefined
    sha256: string | undefined
    headers: string[] | undefined
  }
