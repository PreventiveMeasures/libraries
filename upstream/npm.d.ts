// Names and versions are checked before any request. A scoped package is
// read with PREVENTIVE_MEASURES_NPM_TOKEN, STASIS_NPM_TOKEN or NPM_TOKEN,
// the first set.

// The platform's cache directory for a program called `name` (6 to 32 of
// a-z, A-Z, 0-9, `_`, `-`); undefined without an absolute home. Nothing is made.
export function cacheDirFor(name: string): string | undefined

// cacheDirFor('PreventiveMeasures'), where setCacheDir() caches by default.
export const defaultCacheDir: string | undefined

// Where cached answers are kept: `dir`, else defaultCacheDir (which throws
// where there is none); `false` turns the cache off. What's cached is
// trusted, so point it only at storage nothing less trusted can write.
export function setCacheDir(dir?: string | false): void

// A caller's store in place of setCacheDir's: `read` answers what `write`
// last stored under `type` and `key`, or null. Values are JSON, a tarball's
// a Uint8Array; it is trusted as setCacheDir's directory is.
export interface CacheStore {
  read(type: string, key: string): Promise<unknown>
  write(type: string, key: string, value: unknown): Promise<void>
}

// setCacheDir's cache where `cache` is left out, a caller's store in its
// place, or `false` for none.
export interface CacheOptions {
  cache?: CacheStore | false
}

// A failed request, by its HTTP status: 404 for a package or version the
// registry hasn't.
export class HttpError extends Error {
  name: 'HttpError'
  status: number
  headers?: Headers
}

// A package's GitHub repo as its `latest` document names it, and where in it
// the package sits (`''` the root). Throws where it names none.
export interface GitHubLink {
  github: string
  directory?: string
  url: string
}
export function getGitHub(name: string): Promise<GitHubLink>

export interface PackageRepo {
  github: string
  directory?: string
}
// A name that resolves to no repo is left out. `cachedOnly` never fetches.
export function resolvePackageRepos(packageNames: Iterable<string>, options?: { cachedOnly?: boolean }): Promise<Map<string, PackageRepo>>

// resolvePackageRepos' disk cache, a month an entry: a read answers null for
// nothing usable, a write false where it couldn't write.
export function readPackageRepoCache(name: string): Promise<PackageRepo | null>
export function writePackageRepoCache(name: string, github: string, directory?: string): Promise<boolean>

// Exactly a version's own tarball URL and one `sha512-<base64>`.
export interface Dist {
  tarball: string
  integrity: string
}

// All of it the publisher's word, held to no repository or tarball. A field
// missing or not of its shape is absent.
export interface PackageMeta {
  name: string
  version: string
  dist: Dist
  gitHead?: string
  repository?: string | PackageRepository
  homepage?: string
  bugs?: string | PackageBugs
  unpackedSize?: number
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

// `dist`: one the caller already has, as a lockfile gives it.
export interface MetaOptions extends CacheOptions {
  dist?: Dist
}

// A version's registry document, refused unless it is for that name and
// version. With `dist`, npm's own cache or ours may answer with no request;
// without one, the registry is always asked. Kept for good.
export function getMeta(name: string, version: string, options?: MetaOptions): Promise<PackageMeta>

// When each version was published, as Date#toISOString writes it; versions
// without a valid time are left out. Reads the whole package's document.
export function getPublishTimes(name: string): Promise<Map<string, string>>

// Throws unless that version's integrity is the one given.
export function verifyDist(name: string, version: string, dist: Dist, options?: CacheOptions): Promise<void>

// A published version's gzipped tarball, checked against its integrity. npm's
// and other tools' caches are read first, never written; setCacheDir's (or
// `cache`) is written.
export function getTarball(name: string, version: string, dist?: Dist, options?: CacheOptions): Promise<Uint8Array>
