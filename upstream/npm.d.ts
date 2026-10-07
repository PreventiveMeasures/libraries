// Hand-written against npm.js; a change to either belongs with the other.
//
// Every call that reaches the registry first asserts that the name is a
// string of the shape npm takes, and a version a string that npm's
// semver.valid answers with unchanged; neither goes near a request, or a
// cache path, otherwise. Responses are read up to a size limit and within
// a timeout, as github.d.ts describes, and lookups for many names go to
// the registry eight at a time.
//
// Where NPM_TOKEN is set, it is sent with the requests for a scoped
// package, so a private one can be read.

// Where a program called `name` keeps its cache for this user, as each
// platform has it, read from the environment when called. macOS:
// ~/Library/Caches/<name>. Windows: %LOCALAPPDATA%\<name>\Cache, the
// `Cache` apart from the program's other local data there. Elsewhere, the
// XDG Base Directory spec's: $XDG_CACHE_HOME/<name>, or ~/.cache/<name>
// where it is unset, empty or relative, which the spec has ignored.
// Undefined where no absolute directory is found to start from: a home
// directory that is relative, empty or unknown. Nothing is made. `name` is
// 6 to 32 of a-z, A-Z, 0-9, `_` and `-`, so one directory name the same on
// every platform.
export function cacheDirFor(name: string): string | undefined

// cacheDirFor('PreventiveMeasures'), read once, when this module is first
// imported: where setCacheDir() caches.
export const defaultCacheDir: string | undefined

// Where cached answers are written and read, resolved when set: `dir`, or
// defaultCacheDir where it is left out, which throws where there is none.
// Unset until this is called, and unset again by `false`, which means no
// cache: every read of it misses and every write is skipped. getTarball
// reads ours all the same, set or not.
//
// The directory is trusted: a package's repo is answered from it as it
// was written, with no request. Point it only at storage that nothing
// less trusted than the caller can write, never a cache shared with or
// restored from lower-trust jobs. Tarballs, crates (cargo.js), zips
// (soldeer.js) and tree tarballs (github.js) don't rely on this, since
// they are checked against their integrity on every call.
export function setCacheDir(dir?: string | false): void

// A failed request: `status` is the HTTP status the registry answered
// with (404 for a package or version it does not have).
export class HttpError extends Error {
  name: 'HttpError'
  status: number
}

// A package's GitHub repo as its registry metadata names it — getRepo
// (package.js) over its `latest` document: `github` is `owner/name`, and
// `directory` is where in the repo the package sits, `''` at the repo
// root, absent where it declares none. Throws when the package cannot be
// fetched or names no GitHub repo.
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
// A read answers null for anything but a usable entry, one written by a
// release that resolved repos by other rules included; a write answers
// false where it could not write, and never throws. A write takes the
// `github` a lookup gives, `owner/name` with no trailing `.git`, so what
// it writes reads back; a `directory` left out is unknown, and `''` the
// repo root.
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
// Other caches are read first, and never written: npm's (cacache under
// npm_config_cache, else npm's default, `~/.npm` outside Windows; and npm
// 4's `<name>/<version>/package.tgz` there), then
// `~/.audit/cache/tgz/<org>:<name>-<version>.tgz`, then defaultCacheDir
// and cacheDirFor('stasis'), as setCacheDir files a tarball in either,
// whether set or not. A file there that does not match is passed over.
// Then setCacheDir's cache, where one that does not match throws.
export function getTarball(name: string, version: string, dist?: Dist): Promise<Uint8Array>
