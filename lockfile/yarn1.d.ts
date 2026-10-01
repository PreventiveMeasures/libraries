// Hand-written against yarn1.js; a change to either belongs with the other.

// Reads a yarn.lock of `# yarn lockfile v1`, as yarn 1 writes it. Nothing
// is dropped: a field this reader does not know the meaning of is refused
// (`registry`, `permissions`, `prebuiltVariants`), and so is anything yarn
// 1 does not write, down to how a string is quoted and a line indented,
// where its own reader would take it otherwise than another reader does:
// a bare `1.0` or `true`, a blank line within an entry, a comment below
// the header, the markers of a merge conflict.
//
// So is a lockfile that contradicts itself, or that yarn installs
// otherwise than it says, and line ends of both kinds. Within an entry: a
// pattern twice, a dependency whose pattern is not there, but for a
// workspace the manifests name, two integrities of one algorithm, a sha1
// integrity that is not the one after `resolved`'s `#`, a uid that is the
// version, and a tarball with no hash at all; a pattern that resolved
// from another source than it names, as yarn picks a resolver for it: a
// tarball's URL or path, a repository at a commit, a git host's
// `user/repo` by its tarball or by ssh, nothing for a directory; `file:`
// patterns of two directories, or a `link:` beside another; registry
// patterns that ask for two packages, or a tarball of npm's registry, or
// yarn's, of another package or version than the entry's. An entry whose
// patterns give it two names, which yarn 1.22.21 and earlier write for one
// tarball, and any `name`, which they go on to write, as yarn installs
// such a package under one of its names alone; an entry that gives a
// pattern asking for the registry a tarball, a directory or a repository
// that another pattern names, as yarn does for a dependency on one with
// the same name and version. Across entries: two of one name and
// `resolved`, or of one name and directory, which yarn writes as one; two
// of one tarball or commit, of two versions or hashes; and two of one
// name and version where a range of the registry asks for either, as yarn
// gives it whichever it resolves first.
//
// A name, of a package, an alias or a dependency, is held to npm's rule
// for one and its 214 characters. An entry's version is SemVer 2.0.0, as
// yarn writes it once cleaned: no `v` or space around it, at most 256
// characters, and no major, minor or patch past 2^53. A workspace's,
// which yarn cleans loosely, is held without semver to 256 of the
// characters semver reads in one: letters, digits, whitespace, `.`, `+`,
// `-` and `=`. With `semver`, an entry's version is one semver.valid reads
// too, and a workspace's one it reads once cleaned, as yarn does; and
// each range of the registry, an alias's too, has to be satisfied by the
// version it resolved to, as yarn otherwise takes the entry as outdated
// and resolves the range again, but where a resolution gives it. Without
// `semver`, a tag is told from a range by its look, and a workspace's
// version is known to satisfy a range that is that version alone.
//
// A yarn.lock does not say which projects ask for what: `manifests` does,
// by directory from the lockfile's, `.` for the one beside it and the
// others its workspaces, each as JSON.parse reads its package.json. With
// them, `importers` is read, and every pattern is held to be asked for, by
// a manifest, a package or the root's `resolutions`, the pattern of each
// of which has to be there. A workspace has to be one yarn reads: in a
// private root, found by its `workspaces` outside node_modules, with a
// name and a version, and no `resolutions`; a manifest has no dependency
// in two lists, nor a list yarn only warns of, `devdependencies` and the
// like; and no entry is of a workspace's name and a range its version
// satisfies, and none missing for one it does not, as yarn links the
// workspace for the one and the other not. Without them, `importers` is
// undefined.
//
// A resolution to a tarball, a directory or a repository shares its entry
// with the patterns it was applied to, which ask for the registry, and is
// read where the manifests say it applies to every request of them, along
// every path yarn may request each by, as its minimatch reads the path; a
// glob of more than `**`, `*` and `?` is refused. Not where yarn gives what
// the resolution names to a request the resolution does not apply to: a
// dependency of the root manifest's own, a dependency on the tarball
// itself, or another entry of it. Without the manifests, such an entry is
// refused, as nothing says a resolution made it. Nor is a request read
// that the first resolution to match it does not give its pattern.
//
// Throws a TypeError for anything but a string, for options it does not
// know or of the wrong type, and for checkVersions without semver; and a
// LockfileError for the rest.
export function parseYarn1Lockfile(text: string, options?: Yarn1Options): Yarn1Lockfile

export interface Yarn1Options {
  // By directory from the lockfile's, `.` for its own, each as JSON.parse
  // reads its package.json.
  manifests?: Record<string, object>
  // On by default, which needs semver; off, versions are read without it,
  // unless it is passed all the same.
  checkVersions?: boolean
  // The semver package, npm's: this reader depends on no package itself.
  semver?: Yarn1Semver
}

// What this reader calls of semver.
export interface Yarn1Semver {
  valid(version: string): string | null
  clean(version: string, options: { loose: boolean }): string | null
  validRange(range: string): string | null
  satisfies(version: string, range: string, options?: { loose: boolean }): boolean
}

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

// What a dependency leads to: a pattern, a key of `packages`; or `link:`
// and the directory of a workspace, as yarn links it.
export type Target = string

export interface Yarn1Lockfile {
  // By pattern, `name@range` as a dependency asks for a package, the
  // package it resolved to: the patterns of one entry share one object.
  packages: Record<string, Yarn1Package>
  // By project directory relative to the lockfile's, `.` for its own, as
  // `manifests` has them: what each manifest asks for, by alias. Undefined
  // where the manifests are not handed over.
  importers: Record<string, Yarn1Importer> | undefined
}

export interface Yarn1Importer {
  dependencies: Record<string, Target>
  devDependencies: Record<string, Target>
  optionalDependencies: Record<string, Target>
}

export interface Yarn1Package {
  // The patterns of its entry, in the order the lockfile lists them.
  patterns: string[]
  // The name its patterns give it, which yarn installs it as: not its own
  // where they alias another package, `my-q@npm:q@1.5.1`, or name a
  // tarball, a directory or a repository by another name.
  name: string
  // SemVer 2.0.0, as yarn cleans the package's manifest's; for a
  // directory, `file:` or `link:`, what yarn read there last, or `0.0.0` in
  // its place.
  version: string
  // What yarn tells two packages of one version apart by, where it wrote
  // one: `""` for a `link:`, and a commit or a hash in older lockfiles.
  uid: string | undefined
  resolution: Yarn1Resolution | undefined
  // By name, what each dependency leads to: the pattern it asks for, or,
  // where the lockfile has none, a workspace the manifests name, which
  // yarn links for a range its version satisfies.
  dependencies: Record<string, Target>
  optionalDependencies: Record<string, Target>
}

// Where the package's files come from, as `resolved` says. A tarball is
// fetched from an http(s) URL, or read from `file:` and a path from the
// lockfile's directory; `sha1` is the hex digest yarn wrote after its `#`,
// which it checks where there is no `integrity`, one or more subresource
// integrities, a space apart. A git repository is fetched with git, at a
// full commit. Undefined where yarn wrote nothing, for a directory, `file:`
// or `link:`, which it reads again at every install: the lockfile does not
// lock it.
export type Yarn1Resolution =
  | { type: 'tarball', tarball: string, sha1: string | undefined, integrity: string | undefined }
  | { type: 'git', repo: string, commit: string }
