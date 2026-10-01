// Reads a yarn.lock v1. Throws a LockfileError for anything yarn 1 would
// not write, would read otherwise than other parsers, or would install
// otherwise than the lockfile says, the alias entries yarn 1.22.21 and
// earlier merge among them; and a TypeError for bad arguments.
export function parseYarn1Lockfile(text: string, options?: Yarn1Options): Yarn1Lockfile

export interface Yarn1Options {
  // Each package.json, parsed, by directory from the lockfile's: `.` and its
  // workspaces. Without them there are no importers, and a resolution or a
  // dependency on a workspace, which only they can explain, is refused.
  manifests?: Record<string, object>
  // Checks versions against ranges with `semver`, which it then requires.
  // On by default.
  checkVersions?: boolean
  // The semver package.
  semver?: Yarn1Semver
}

export interface Yarn1Semver {
  valid(version: string): string | null
  clean(version: string, options: { loose: boolean }): string | null
  validRange(range: string): string | null
  satisfies(version: string, range: string, options?: { loose: boolean }): boolean
}

// `where` is a property path, into the result, `["q@1.5.1"].resolved`, or
// into `manifests`; undefined for a syntax error, whose message has the line.
export class LockfileError extends Error {
  constructor(detail: string, where?: string)
  where: string | undefined
}

// Each Record has a null prototype, and keeps the order of its source.

// A key of `packages`, or `link:` and the directory of a workspace.
export type Target = string

export interface Yarn1Lockfile {
  // By pattern, `name@range`; the patterns of one entry share one object.
  packages: Record<string, Yarn1Package>
  // By directory, as `manifests` has them; undefined without them.
  importers: Record<string, Yarn1Importer> | undefined
}

export interface Yarn1Importer {
  dependencies: Record<string, Target>
  devDependencies: Record<string, Target>
  optionalDependencies: Record<string, Target>
}

export interface Yarn1Package {
  patterns: string[]
  // What it is installed as: an alias, `my-q@npm:q@1.5.1`, is `my-q`.
  name: string
  // For a directory, `file:` or `link:`, what yarn last read there.
  version: string
  uid: string | undefined
  // Undefined for a directory, `file:` or `link:`: the lockfile does not
  // lock it.
  resolution: Yarn1Resolution | undefined
  dependencies: Record<string, Target>
  optionalDependencies: Record<string, Target>
}

// `tarball` is an http(s) URL, or `file:` and a path from the lockfile's
// directory; `sha1` is the hex after `resolved`'s `#`, and `integrity` one
// or more subresource integrities, a space apart.
export type Yarn1Resolution =
  | { type: 'tarball', tarball: string, sha1: string | undefined, integrity: string | undefined }
  | { type: 'git', repo: string, commit: string }
