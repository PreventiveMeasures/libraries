// Reads a Package.resolved, version 1, 2 or 3, as SwiftPM 5.0 to 6.4 write
// it, and Xcode with it. SwiftPM writes version 1 of a root package of a
// tools version below 5.6, 2 of one below 5.10, and 3 of the rest. The file
// is held to the layout of the writer of its version: TSCBasic's JSON of
// version 1, `"key": value`, and JSONEncoder of 2 and 3, `"key" : value`,
// each two spaces a level, the keys of each object sorted, each once, and
// the file ended at the last `}` or a line end after it. A string escapes
// `"` and `\` alone, as no field has a control; a line end of another kind
// than the first, a byte order mark, and a line longer than 2^20
// characters are refused.
//
// Every pin is held to what SwiftPM writes of its kind, and the pins to the
// order SwiftPM sorts them in, by identity without case, as it tells them
// apart: a second pin of an identity, in any case, is refused. So is a pin
// of no package SwiftPM writes, and the empty file of no pins, as SwiftPM
// removes the file instead.
//
// A repository's location is held to a URL of a host git fetches from,
// http(s), ssh or git, or scp's `user@host:path`, in ASCII, and its
// identity to the one SwiftPM finds in it: a pin SwiftPM writes where a
// mirror of another name is configured, whose identity is the mirror's, is
// refused, as SwiftPM without the mirror finds the package no pin. So is a
// repository by its path or a file URL, `localSourceControl`, which reads
// on the machine that wrote it alone; and a location in which git or ssh
// would read an option, or that names a remote helper.
//
// Throws a LockfileError for anything SwiftPM would not write, or would
// read otherwise, and a TypeError for bad arguments.
export function parsePackageResolved(text: string, options?: PackageResolvedOptions): PackageResolved

export interface PackageResolvedOptions {
  // The root package's manifest SwiftPM read, Package.swift or the
  // Package@swift-<version>.swift it picks, its text or its bytes, which
  // originHash has to be the sha256 of, as SwiftPM hashes it when it
  // resolves a package alone: decoded as UTF-8, a byte of no character as
  // U+FFFD, and encoded again. A lockfile of version 1 or 2 has no
  // originHash to hold it to, and is refused with one. One Xcode writes of
  // a project or a workspace, or SwiftPM of more than one root package, is
  // of more than a manifest, which this does not take.
  manifest?: string | Uint8Array
}

// `where` is a property path into the lockfile, `pins[2].state.revision`,
// `object.pins[0].repositoryURL`; undefined for the file's layout, whose
// message has the line.
export class LockfileError extends Error {
  constructor(detail: string, where?: string)
  where: string | undefined
}

export interface PackageResolved {
  version: 1 | 2 | 3
  // Of version 3: the hex sha256 of the root package's manifest, by which
  // SwiftPM tells the lockfile is of the manifest as it is, and resolves
  // anew where it is not. Undefined of 1 and 2.
  originHash: string | undefined
  // By identity, in the file's order, SwiftPM's: every package SwiftPM
  // resolved the root's dependencies to, those of the packages it depends on
  // too. A Record with a null prototype.
  pins: Record<string, Pin>
}

// What SwiftPM fetches of the package, and at what: a repository at a
// commit, by a version, a branch or the commit alone; or a registry's
// package at a version.
export type Pin = RepositoryPin | RegistryPin

export interface RepositoryPin {
  // The last component of its location, but a `/` that ends it, less a
  // `.git` that ends it, in lowercase, as SwiftPM finds it: `swift-log` of
  // `https://github.com/Apple/swift-log.git`. Version 1 writes none, and
  // SwiftPM finds it so.
  identity: string
  kind: 'remoteSourceControl'
  // The repository, as the manifest gives it, not a mirror's.
  location: string
  // Of version 1, the package's name, as its own manifest gives it; of 2
  // and 3, which write none, undefined.
  name: string | undefined
  originalLocation: undefined
  // As TSCUtility.Version describes the one it read of a tag, `v1.2` as
  // `1.2.0`: SemVer 2.0.0's form, but that a pre-release or build
  // identifier may be empty, or a number with a leading zero, as SwiftPM
  // takes a tag of either. No number past 2^53.
  version: string | undefined
  // A branch the manifest gives; or the revision it gives where that is
  // not a full commit hash, `0a5bc04`, which SwiftPM keeps as a branch.
  // Refused where git check-ref-format refuses it as a branch's name, as of
  // `HEAD~1`. Never with a version.
  branch: string | undefined
  // The commit SwiftPM checked out, a full hash, in lowercase hex.
  revision: string
}

export interface RegistryPin {
  // `scope.name`, in the case the manifest gives it, as a registry's
  // package is: a scope of 1 to 39 letters, digits and hyphens, a name of 1
  // to 100 of those and underscores, ASCII, and neither with a hyphen or
  // underscore first, last, or after another.
  identity: string
  kind: 'registry'
  // SwiftPM writes "", which is read as none.
  location: undefined
  name: undefined
  // Where SwiftPM looked the package up from a repository's URL, as
  // `--replace-scm-with-registry` has it do: that URL, held as a location
  // is. Undefined otherwise.
  originalLocation: string | undefined
  version: string
  branch: undefined
  revision: undefined
}
