// Hand-written against npm.js; a change to either belongs with the other.
//
// Every call that reaches the registry first asserts that the name is a
// string of the shape npm takes, and a version a string that npm's
// semver.valid answers with unchanged; neither goes near a request, or a
// cache path, otherwise. Responses are read up to a size limit and within
// a timeout, as github.d.ts describes, and lookups for many names go to
// the registry eight at a time.

// Where cached answers live, resolved when set. Unset by default, and
// unset means no cache: every read misses and every write is skipped.
//
// The directory is trusted: a package's repo is answered from it as it
// was written, with no request. Point it only at storage that nothing
// less trusted than the caller can write, never a cache shared with or
// restored from lower-trust jobs. Tarballs don't rely on this, since they
// are checked against the registry's integrity on every call.
export function setCacheDir(dir: string): void

// A failed request: `status` is the HTTP status the registry answered
// with (404 for a package or version it does not have).
export class HttpError extends Error {
  name: 'HttpError'
  status: number
}

// A package's GitHub repo as its registry metadata names it — getRepo
// (package.js) over its `latest` document: `github` is `owner/name`, and
// `directory` is where in the repo the package sits, absent for a
// package at the repo root. Throws when the package cannot be fetched or
// names no GitHub repo.
export interface GitHubLink {
  github: string
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
export function readPackageRepoCache(name: string): Promise<PackageRepo | null>
export function writePackageRepoCache(name: string, github: string, directory?: string): Promise<boolean>

// Where a published version's tarball is and what it hashes to: exactly
// these two, `tarball` the registry's own URL for that version and
// `integrity` one `sha512-<base64>`, nothing else (no sha1, second hash
// or option). A dist given to a function below is held to the same.
export interface Dist {
  tarball: string
  integrity: string
}

export interface PackageMeta {
  name: string
  version: string
  dist: Dist
}

// The registry's version document, refused unless it is for that name and
// version and its dist is held to the rules above.
export function getMeta(name: string, version: string): Promise<PackageMeta>

// Fetches the registry's dist for that version and throws unless its
// integrity is the one given, as for a dist read off a lockfile.
export function verifyDist(name: string, version: string, dist: Dist): Promise<void>

// A published version's gzipped tarball, whole, in memory. Without `dist`,
// the version document is fetched on every call, cached tarball or not;
// with one, it is trusted as given and nothing but the tarball is asked
// for. Either way the bytes are checked against `dist.integrity`, whether
// they were downloaded (before they are cached) or read from a cache.
//
// Other tools' caches are read first, and never written: npm's (cacache
// under npm_config_cache, else npm's default, `~/.npm` outside Windows;
// and npm 4's `<name>/<version>/package.tgz` there), then
// `~/.audit/cache/tgz/<org>:<name>-<version>.tgz`. A file there that does
// not match is passed over. One in setCacheDir's cache that does not
// match throws.
export function getTarball(name: string, version: string, dist?: Dist): Promise<Uint8Array>
