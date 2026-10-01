// Hand-written against poetry.js; a change to either belongs with the other.

export { LockfileError } from './pnpm.js'
export { TomlError } from './toml.js'

// Reads a poetry.lock of lock-version 2.0, as Poetry 1.5 to 1.8 write it,
// or 2.1, as Poetry 2 does. Throws a TypeError for anything but a string,
// a TomlError where the text is not TOML, and a LockfileError where it is
// but is not read here: `where` is a property path into the lockfile,
// `package[3].source.url`, and the message says what.
//
// Refused: lock-version 1, of Poetry 1.4 and older, with its
// [metadata.files] and `category`; a field Poetry does not write, or does
// not write for a source or a dependency of its kind; a name PEP 508 does
// not take, a version PEP 440 does not, a marker or an extra's requirement
// PEP 508 does not, which Poetry reads with a fallback; a git source
// without the full commit it resolved to; a path out of normal form; a
// hash of an algorithm an index does not use, or not in lowercase hex; a
// package listed twice; a root extra that names no package.
//
// Poetry's version constraints, `^1.2`, `>=1.5,<1.5.7 || >1.5.7`, which
// are its own grammar, are handed back as written.
export function parsePoetryLock(text: string): PoetryLockfile

// Every Record has a null prototype, and is in the order the file has it.

export interface PoetryLockfile {
  lockVersion: '2.0' | '2.1'
  // The project's, as a Poetry constraint.
  pythonVersions: string
  // The sha256 of what pyproject.toml asks for, which Poetry checks the
  // lockfile is fresh by.
  contentHash: string
  // The project's extras, by name: the packages, by name, each turns on.
  extras: Record<string, string[]>
  // A name may be listed more than once, at other versions or from other
  // sources, each for its own markers.
  packages: PoetryPackage[]
}

export interface PoetryPackage {
  // As the index or the package has it; normal form is PEP 503's.
  name: string
  version: string
  description: string
  // Installed only for an extra of the project.
  optional: boolean
  pythonVersions: string
  // Of lock-version 2.1: the groups that need it, and by group, where:
  // undefined where everywhere. Undefined of 2.0.
  groups: string[] | undefined
  markers: Record<string, string | undefined> | undefined
  // The files Poetry may install it from, with their hashes,
  // `algorithm:hex`. None for a directory or a git repository.
  files: { file: string, hash: string }[]
  // By name as written: what the package asks for, each name one way or
  // more, by marker.
  dependencies: Record<string, PoetryDependency[]>
  // By extra: what it adds, in PEP 508's text, as the package has it.
  extras: Record<string, string[]>
  // Undefined for PyPI.
  source: PoetrySource | undefined
  // Of a directory or a git source: whether installed as editable.
  develop: boolean | undefined
}

export type PoetryDependency = {
  extras: string[]
  // Asked for only for an extra of the package.
  optional: boolean
  markers: string | undefined
} & (
  | { type: 'version', version: string }
  // From the lockfile's directory.
  | { type: 'path', path: string, develop: boolean }
  | { type: 'url', url: string }
  | { type: 'git', git: string, reference: { kind: 'branch' | 'tag' | 'rev', name: string } | undefined, subdirectory: string | undefined }
)

// Paths are from the lockfile's directory, `/` between segments.
export type PoetrySource =
  // An index other than PyPI, by its URL and the name the project gives it.
  | { type: 'legacy', url: string, name: string }
  // `reference` is what was asked for: a branch, a tag or a commit.
  | { type: 'git', url: string, reference: string | undefined, commit: string, subdirectory: string | undefined }
  | { type: 'url', url: string, subdirectory: string | undefined }
  | { type: 'file' | 'directory', path: string }
