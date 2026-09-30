// Hand-written against yarn.js; a change to either belongs with the other.

// Reads a yarn.lock of `# yarn lockfile v1`, as yarn 1 writes it. Nothing
// is dropped: a field this reader does not know the meaning of is refused
// (`registry`, `permissions`, `prebuiltVariants`), and so is anything yarn
// 1 does not write, down to how a string is quoted and a line indented,
// where its own reader would take it otherwise than another reader does:
// a bare `1.0` or `true`, a blank line within an entry, a comment below
// the header, the markers of a merge conflict.
//
// So is a lockfile that contradicts itself, or that yarn installs
// otherwise than it says: a pattern twice, a dependency whose pattern is
// not there, a sha1 integrity that is not the one after `resolved`'s `#`;
// an entry whose patterns give it two names, which yarn 1.22.21 and
// earlier write for one tarball, and a `name` other than its patterns',
// which they go on to write, as yarn installs such a package under one of
// its names alone; and an entry that gives a pattern asking for the
// registry a tarball, a directory or a repository that another pattern
// names, as yarn does for a resolution to one and for a dependency on one
// with the same name and version, and so a resolution to anything but the
// registry.
//
// A yarn.lock does not say which projects ask for what: `manifests` does,
// by directory from the lockfile's, `.` for the one beside it and the
// others its workspaces, each as JSON.parse reads its package.json. With
// them, `importers` is read, and every pattern is held to be asked for, by
// a manifest, a package or the root's `resolutions`; without, `importers`
// is undefined.
//
// Throws a TypeError for anything but a string, and a LockfileError for
// the rest.
export function parseYarnLockfile(text: string, manifests?: Record<string, object>): YarnLockfile

// `where` is the place a refusal is about, as a property path: from the
// top of the lockfile, `["q@1.5.1"].resolved`, or from `manifests`; or
// undefined, for the file as a whole, and for how it is written, when the
// message ends with the line.
export class LockfileError extends Error {
  constructor(detail: string, where?: string)
  where: string | undefined
}

// Every Record below has a null prototype: a key is only ever a key, and an
// absent one reads as undefined. Each is in the order the lockfile, or the
// manifest, has it.

// What a dependency leads to: a pattern, a key of `packages`; or, from a
// manifest, `link:` and the directory of a workspace, as yarn links it.
export type Target = string

export interface YarnLockfile {
  // By pattern, `name@range` as a dependency asks for a package, the
  // package it resolved to: the patterns of one entry share one object.
  packages: Record<string, YarnPackage>
  // By project directory relative to the lockfile's, `.` for its own, as
  // `manifests` has them: what each manifest asks for, by alias. Undefined
  // where the manifests are not handed over.
  importers: Record<string, YarnImporter> | undefined
}

export interface YarnImporter {
  dependencies: Record<string, Target>
  devDependencies: Record<string, Target>
  optionalDependencies: Record<string, Target>
}

export interface YarnPackage {
  // The patterns of its entry, in the order the lockfile lists them.
  patterns: string[]
  // The name its patterns give it, which yarn installs it as: not its own
  // where they alias another package, `my-q@npm:q@1.5.1`, or name a
  // tarball, a directory or a repository by another name.
  name: string
  // SemVer, as the package's manifest has it; for a directory, `file:` or
  // `link:`, what yarn read there last, or `0.0.0` in its place.
  version: string
  // What yarn tells two packages of one version apart by, where it wrote
  // one: `""` for a `link:`, and a commit or a hash in older lockfiles.
  uid: string | undefined
  resolution: YarnResolution | undefined
  // By name, the pattern each dependency asks for: a key of `packages`.
  dependencies: Record<string, string>
  optionalDependencies: Record<string, string>
}

// Where the package's files come from, as `resolved` says. A tarball is
// fetched from an http(s) URL, or read from `file:` and a path from the
// lockfile's directory; `sha1` is the hex digest yarn wrote after its `#`,
// which it checks where there is no `integrity`, one or more subresource
// integrities, a space apart. A git repository is fetched with git, at a
// full commit. Undefined where yarn wrote nothing, for a directory, `file:`
// or `link:`, which it reads again at every install: the lockfile does not
// lock it.
export type YarnResolution =
  | { type: 'tarball', tarball: string, sha1: string | undefined, integrity: string | undefined }
  | { type: 'git', repo: string, commit: string }
