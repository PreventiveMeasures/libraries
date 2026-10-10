// Hand-written against npm.js; a change to either belongs with the other.
//
// Every call that reaches the registry first asserts that the name is a
// string of the shape npm takes, and a version a string that npm's
// semver.valid answers with unchanged; neither goes near a request, or a
// cache path, otherwise. Responses are read up to a size limit and within
// a timeout, as github.d.ts describes, and lookups for many names go to
// the registry eight at a time.
//
// Where PREVENTIVE_MEASURES_NPM_TOKEN, STASIS_NPM_TOKEN or NPM_TOKEN is
// set, the first of them not empty, in that order, is sent with the
// requests for a scoped package, so a private one can be read.

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
// The directory is trusted: a package's repo, as recorded or as a version
// document kept here names it, and for 90 minutes a repository's published
// advisories (advisories.js), are answered from it as they were written,
// with no request. Point it only at storage that
// nothing less trusted than the caller can write, never a cache shared
// with or restored from lower-trust jobs. Tarballs, crates (cargo.js), zips
// (soldeer.js) and tree tarballs (github.js) don't rely on this, since
// they are checked against their integrity on every call; and the version
// documents kept here (getMeta) never supply an integrity, only confirm
// one a caller gives (verifyDist, and getMeta with a `dist`). A call's `cache` option, where it has
// one, keeps what it caches elsewhere, or writes none of it here.
export function setCacheDir(dir?: string | false): void

// A store of the caller's, a database's say, for what would otherwise be
// kept in setCacheDir's cache: `read` answers the value last written
// under that `type` and `key`, or null or undefined for none. A `type` is
// what is kept and a `key` which one: `npm/versions` and `npm/tarballs`
// with `<name>@<version>` for a version's document and tarball; and for
// advisories.js, `github/advisories` with the repository's `owner/name` in
// lowercase for its listing, and `cargo/repos`, `composer/repos` and
// `soldeer/repos` with a package's name for the repository it names.
// Values are plain JSON data, which `read` may answer as written or as a
// copy, but a tarball's are its bytes, a Uint8Array. Whatever it answers
// is checked as a cached file is: one malformed, stale or kept differently
// is a miss, and a tarball's bytes that do not match throw. A rejection
// from either is the call's. It is trusted as setCacheDir's directory is.
export interface CacheStore {
  read(type: string, key: string): Promise<unknown>
  write(type: string, key: string, value: unknown): Promise<void>
}

// Where a call keeps what it caches: in setCacheDir's cache where `cache`
// is left out; in a store of the caller's in place of it; or with `false`,
// nowhere, though setCacheDir's cache is read all the same. Other tools'
// caches and ours are read for tarballs whatever it is (getTarball).
export interface CacheOptions {
  cache?: CacheStore | false
}

// A failed request: `status` is the HTTP status the registry answered
// with (404 for a package or version it does not have).
export class HttpError extends Error {
  name: 'HttpError'
  status: number
}

// A package's GitHub repo as its registry metadata names it -- getRepo
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

// `gitHead` is the commit the document names, as npm reads it off the git
// checkout it publishes from, where it is a full commit id: 40 lowercase
// hex digits, or 64. `repository`, `homepage` and `bugs` are the
// document's, as the package.json published had them, or npm filled them
// in from one another: each a string as it is, or for `repository` and
// `bugs` an object, of which only the strings named below are read. Each is
// absent where the document has none, or has another shape, or an object
// with none of those strings. All of it is the publisher's word, held to no
// repository.
export interface PackageMeta {
  name: string
  version: string
  dist: Dist
  gitHead?: string
  repository?: string | PackageRepository
  homepage?: string
  bugs?: string | PackageBugs
}

export interface PackageRepository {
  type: string | undefined
  url: string | undefined
  directory: string | undefined
}

export interface PackageBugs {
  url: string | undefined
  email: string | undefined
}

// getMeta's options: `cache`, and the `dist` a caller already has of that
// version, as a lockfile gives it, held to the rules above.
export interface MetaOptions extends CacheOptions {
  dist?: Dist
}

// The registry's version document, refused unless it is for that name and
// version and its dist is held to the rules above.
//
// With `dist`, npm's own cache comes first, where getTarball looks for
// npm's tarballs: where it keeps the full packument of that name, as npm 10
// and later fetch it, and that version's entry there has the given dist's
// tarball and integrity, that entry answers, with no request, and neither
// `cache` nor setCacheDir's cache is read or written. An abbreviated
// packument, as earlier npm fetches, is passed over, as is one whose
// content does not match the sha512 npm filed it by. What it answers
// beside the dist is taken from npm's cache as it is from setCacheDir's.
// Else the document `cache` keeps answers, with no request, where its
// tarball and integrity are the given dist's; else the registry's is asked
// for, and throws where they are not.
//
// Without `dist`, the registry is asked on every call: a cache never
// supplies a dist. Kept whole, as `cache` says, and for good once it
// passes, as the registry never takes a version twice: in setCacheDir's
// cache, compressed, where `cache` is left out. One refused is not kept.
export function getMeta(name: string, version: string, options?: MetaOptions): Promise<PackageMeta>

// When the registry says each version of a package it lists was published,
// by version, as Date#toISOString writes it: from the whole package's
// document, the only one with `time`, megabytes for some. A version whose
// time is missing, not an ISO 8601 UTC time, or not one there is, as
// 2018-02-29, is left out. Refused unless the document is for that name.
export function getPublishTimes(name: string): Promise<Map<string, string>>

// Throws unless the integrity of that version is the one given, as for a
// dist read off a lockfile: by the version document `cache` keeps, with no
// request, else by the registry's, kept then as getMeta keeps it. One kept
// with another integrity, refused, or for another name or version, is
// passed over for the registry's, which throws where it has another.
export function verifyDist(name: string, version: string, dist: Dist, options?: CacheOptions): Promise<void>

// A published version's gzipped tarball, whole, in memory. Without `dist`,
// the version document is fetched on every call, cached tarball or not,
// and kept as getMeta keeps it; with one, it is trusted as given and
// nothing but the tarball is asked for. Either way the bytes are checked
// against `dist.integrity`, whether they were downloaded (before they are
// cached) or read from a cache.
//
// Other caches are read first, and never written: npm's (cacache under
// npm_config_cache, else npm's default, `~/.npm` outside Windows; and npm
// 4's `<name>/<version>/package.tgz` there), then
// `~/.audit/cache/tgz/<org>:<name>-<version>.tgz`, then defaultCacheDir
// and cacheDirFor('stasis'), as setCacheDir files a tarball in either,
// whether set or not. A file there that does not match is passed over.
// Then setCacheDir's cache, or a `cache` store in its place, where bytes
// that do not match throw. A tarball downloaded is kept there, unless
// `cache` is false.
export function getTarball(name: string, version: string, dist?: Dist, options?: CacheOptions): Promise<Uint8Array>
