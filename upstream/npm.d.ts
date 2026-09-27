// Hand-written against npm.js; a change to either belongs with the other.

// Where cached answers live. Unset by default, and unset means no cache:
// every read misses and every write is skipped.
export function setCacheDir(dir: string): void

// A package's GitHub repo as its registry metadata names it: `repo` is
// `owner/name`, and `directory` is where in the repo the package sits,
// absent for a package at the repo root. Throws when the package cannot
// be fetched or names no GitHub repo.
export interface GitHubLink {
  repo: string
  directory?: string
  url: string
}
export function getGitHub(name: string): Promise<GitHubLink>

// What resolvePackageRepos maps each resolved name to.
export interface PackageRepo {
  github: string
  directory?: string
}
// Fail-soft: a name that resolves to no repo is absent from the map.
// `cachedOnly` answers from the disk cache alone and never fetches.
export function resolvePackageRepos(packageNames: Iterable<string>, options?: { cachedOnly?: boolean }): Promise<Map<string, PackageRepo>>

// The disk cache resolvePackageRepos reads and writes, a month per entry.
// A read answers null for anything but a usable entry; a write answers
// false where it could not write, and never throws.
export function readPackageRepoCache(name: string): Promise<{ repo: string; directory?: string } | null>
export function writePackageRepoCache(name: string, repo: string, directory?: string): Promise<boolean>

// npm's own semver, borrowed from the Node install. Without it, which
// semverAvailable() reports, satisfies answers true for every range and
// compareVersions falls back to a string compare.
export function semverAvailable(): boolean
// Prereleases included; a range npm cannot parse matches everything.
export function satisfies(version: string, range: string): boolean
export function compareVersions(a: string, b: string): number
export function isExactVersion(version: unknown): version is string
