// Hand-written against pylock.js; a change to either belongs with the other.

import type { TomlTable } from './toml.js'

export { LockfileError } from './pnpm.js'
export { TomlError } from './toml.js'

// Reads a pylock.toml of `lock-version = "1.0"`, or 1.x, as PEP 751 and
// the pylock.toml specification lay it out and uv, pip and PDM write it.
// Throws a TypeError for anything but a string, a TomlError where the text
// is not TOML, and a LockfileError where it is but is not read here:
// `where` is a property path into the lockfile, `packages[3].wheels[0]`,
// and the message says what.
//
// Refused, past what packaging's Pylock refuses: a key the specification
// does not name, which a minor version past 1.0 may add; a name not in
// normal form; a version, a marker or a specifier PEP 440 and PEP 508 do
// not read; a hash of an algorithm hashlib does not guarantee or of no
// fixed size, or not in lowercase hex; a git or hg commit but in full; an
// upload time not in UTC; a path that is absolute or has backslashes, as
// the specification takes, which reads one way on one machine alone; two
// entries of one name with no marker, which an installer must refuse; an
// entry of `dependencies` that names no entry of packages, or more than one.
export function parsePylock(text: string): Pylock

// Every Record has a null prototype.

export interface Pylock {
  lockVersion: string
  // Markers, one of which the environment has to meet.
  environments: string[] | undefined
  requiresPython: string | undefined
  // What a multi-use lockfile can install: its extras and dependency
  // groups, which markers test as `extras` and `dependency_groups`, and the
  // groups installed by default.
  extras: string[]
  dependencyGroups: string[]
  defaultGroups: string[]
  createdBy: string
  // A name may be listed more than once, each for its own marker.
  packages: PylockPackage[]
  tool: TomlTable | undefined
}

export interface PylockPackage {
  // In normal form.
  name: string
  // As written; undefined where the lockfile does not say.
  version: string | undefined
  // Installed where it is met, everywhere where undefined.
  marker: string | undefined
  requiresPython: string | undefined
  // The indexes, into packages, of the entries this one depends on, which
  // an installer does not read.
  dependencies: number[]
  // Where it comes from: one of vcs, directory and archive, or else an
  // sdist, wheels, or both, by index.
  vcs: PylockVcs | undefined
  directory: PylockDirectory | undefined
  archive: PylockArchive | undefined
  index: string | undefined
  sdist: PylockDistribution | undefined
  wheels: PylockDistribution[]
  // Each as written, with its `kind`.
  attestationIdentities: TomlTable[]
  tool: TomlTable | undefined
}

// Paths are from the lockfile's directory, `/` between segments; a
// subdirectory is within what it is of, and climbs out of it nowhere. `url`
// is one in which git reads no option or remote helper.
export interface PylockVcs {
  type: 'git' | 'hg' | 'bzr' | 'svn'
  url: string | undefined
  path: string | undefined
  requestedRevision: string | undefined
  commitId: string
  subdirectory: string | undefined
}

export interface PylockDirectory {
  path: string
  editable: boolean
  subdirectory: string | undefined
}

// A file by URL, path, or both. `hashes` is by algorithm, the digest in
// hex; `uploadTime` RFC 3339, in UTC.
export interface PylockFile {
  url: string | undefined
  path: string | undefined
  size: number | undefined
  uploadTime: string | undefined
  hashes: Record<string, string>
}

export interface PylockArchive extends PylockFile {
  subdirectory: string | undefined
}

// `name` is the file's: as given, or the last segment of its path or URL.
export interface PylockDistribution extends PylockFile {
  name: string
}
