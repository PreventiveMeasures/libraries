// Hand-written against npm.js; a change to either belongs with the other.
//
// Every call that reaches the registry first asserts that the name is a
// string of the shape npm takes, and a version a string that npm's
// semver.valid answers with unchanged; neither goes near a request, or a
// cache path, otherwise.

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

// A published version's gzipped tarball, whole, in memory, downloaded
// only where `dist.tarball` is exactly that version's registry URL.
// Checked against the registry's sha512 `dist.integrity` on download,
// before it is cached, and again on every load from the cache; a mismatch
// throws.
export function getTarball(name: string, version: string): Promise<Uint8Array>
