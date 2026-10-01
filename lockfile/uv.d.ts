// Hand-written against uv.js; a change to either belongs with the other.

export { LockfileError } from './pnpm.js'
export { TomlError } from './toml.js'

// Reads a uv.lock of `version = 1`, revision 3 or older, as uv 0.3 and
// later write it. Throws a TypeError for anything but a string, a
// TomlError where the text is not TOML, and a LockfileError where it is
// but is not read here, or would be read two ways: `where` is a property
// path into the lockfile, `package[3].dependencies[1]`, and the message
// says what.
//
// Refused: a field this reader does not know, which uv would drop; a
// revision past 3, of which uv writes 4 only as a preview; a name, an
// extra, a group or a version not in the normal form uv writes it in; a
// marker or a specifier PEP 508 or PEP 440 does not read; an absolute path;
// a git source without the commit it resolved to, or with a `rev` of a
// full commit that is another one; an sdist or wheels a source of that
// kind does not have, a hash where uv writes none or none where it writes
// one, a wheel of another name or version than its package; a package
// listed twice; an edge that names no package or could be any of two, or
// asks for an extra its package has no dependencies for, which uv drops;
// an override of one package's dependencies, new in uv 0.12.
export function parseUvLock(text: string): UvLockfile

// Every Record has a null prototype, and is in the order the file has it.
// A package goes by its key, as uv shows a package: `name==version @
// source`, the source as UvSource's `id`; `name @ source` for a source
// tree's of a dynamic version.

export interface UvLockfile {
  version: 1
  // 0 where none is written, as by uv 0.5 and older.
  revision: 0 | 1 | 2 | 3
  requiresPython: string
  // The forks the resolution split into, as markers.
  resolutionMarkers: string[]
  // `environments` and `required-environments`, as markers.
  supportedMarkers: string[]
  requiredMarkers: string[]
  // Sets of extras and groups that cannot be installed together.
  conflicts: UvConflictItem[][]
  options: UvOptions
  manifest: UvManifest
  // The keys of the workspace's own packages: each of manifest.members,
  // or, where it names none, the project at the workspace root, if any.
  members: string[]
  packages: Record<string, UvPackage>
}

export interface UvConflictItem {
  package: string
  extra: string | undefined
  group: string | undefined
}

export interface UvPackage {
  name: string
  // In normal form; undefined for a source tree of a dynamic version.
  version: string | undefined
  source: UvSource
  // The forks it is in, where not all.
  resolutionMarkers: string[]
  dependencies: UvDependency[]
  // By extra, then by group: what each adds.
  optionalDependencies: Record<string, UvDependency[]>
  devDependencies: Record<string, UvDependency[]>
  sdist: UvSdist | undefined
  wheels: UvWheel[]
  metadata: UvMetadata
}

export interface UvDependency {
  // The key of the package it is.
  package: string
  // Extras of that package it turns on, each one of its optionalDependencies.
  extras: string[]
  // Relative to the resolution's own markers and requires-python.
  marker: string | undefined
}

// Paths are relative to the workspace root, `/` between segments. `id` is
// the source as uv shows it: `registry+URL`, `git+URL`, `direct+URL`, a
// subdirectory added as `#subdirectory=`, or the kind, `+`, and the path.
export type UvSource =
  // A registry by its index URL, or a local one by its directory.
  | { type: 'registry', url: string | undefined, path: string | undefined, id: string }
  // `url` as written; `repository` without its query and fragment.
  | {
    type: 'git'
    url: string
    repository: string
    reference: { kind: 'branch' | 'tag' | 'rev', name: string } | undefined
    commit: string
    subdirectory: string | undefined
    // An archive in the repository, which the package is.
    path: string | undefined
    lfs: boolean
    id: string
  }
  // An archive, an sdist or a wheel, by URL.
  | { type: 'url', url: string, subdirectory: string | undefined, id: string }
  // An archive by path.
  | { type: 'path', path: string, id: string }
  // A source tree: built, built as editable, or not built at all.
  | { type: 'directory' | 'editable' | 'virtual', path: string, id: string }

// A registry's file by `url`, a local registry's by `path` from its
// directory; a URL's, a path's or a git archive's by neither. `hash` is
// `algorithm:hex`.
export interface UvSdist {
  url: string | undefined
  path: string | undefined
  hash: string | undefined
  size: number | undefined
  // RFC 3339, UTC.
  uploadTime: string | undefined
}

export interface UvWheel extends UvSdist {
  filename: string
}

// What the package asked for when it was locked: its requirements, the
// extras it provides, and its dependency groups'. Empty for a registry's.
export interface UvMetadata {
  requiresDist: UvRequirement[]
  providesExtras: string[]
  requiresDev: Record<string, UvRequirement[]>
}

export interface UvRequirement {
  name: string
  extras: string[]
  groups: string[]
  marker: string | undefined
  source: UvRequirementSource
  // A build constraint's alone.
  hashes?: string[]
}

export type UvRequirementSource =
  | { type: 'registry', specifier: string | undefined, index: string | undefined, conflict: UvConflictItem | undefined }
  | { type: 'git', url: string, repository: string, reference: { kind: 'branch' | 'tag' | 'rev', name: string } | undefined, commit: string | undefined, subdirectory: string | undefined, path: string | undefined, lfs: boolean }
  | { type: 'url', url: string, subdirectory: string | undefined }
  | { type: 'path' | 'directory' | 'editable' | 'virtual', path: string }

// A setting at its default is uv's default.
export interface UvOptions {
  resolutionMode: 'highest' | 'lowest' | 'lowest-direct'
  prereleaseMode: 'disallow' | 'allow' | 'if-necessary' | 'explicit' | 'if-necessary-or-explicit'
  forkStrategy: 'fewest' | 'requires-python'
  // RFC 3339, UTC; undefined where a span is set instead.
  excludeNewer: string | undefined
  // ISO 8601, `P3W`.
  excludeNewerSpan: string | undefined
  // By name: false where the cutoff is lifted.
  excludeNewerPackage: Record<string, { timestamp: string, span: string | undefined } | false>
  prereleasePackage: Record<string, UvOptions['prereleaseMode']>
  minimumLibcVersion: { glibc: string | undefined, musl: string | undefined } | undefined
}

// What the workspace asked for beside its members' own requirements.
export interface UvManifest {
  members: string[]
  requirements: UvRequirement[]
  constraints: UvRequirement[]
  overrides: UvRequirement[]
  excludes: string[]
  buildConstraints: UvRequirement[]
  dependencyGroups: Record<string, UvRequirement[]>
  // Metadata given in place of a package's own; requiresDist in PEP 508's text.
  dependencyMetadata: { name: string, version: string | undefined, requiresDist: string[], requiresPython: string | undefined, providesExtras: string[] }[]
}
