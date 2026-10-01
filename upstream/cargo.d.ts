// Hand-written against cargo.js; a change to either belongs with the other.
//
// A name is asserted to be a crate name, a version an exact semver
// version, and a checksum 64 lowercase hex digits, before any request or
// cache path. The cache is setCacheDir's (npm.js).

export { HttpError } from './npm.js'

// Reads crates.io's index for that version and throws unless its sha256
// is the one given, as for a checksum read off Cargo.lock. The index is
// read on every call; nothing is cached.
export function verifyChecksum(name: string, version: string, checksum: string): Promise<void>

// A published version's .crate, whole, in memory. `checksum` is its
// sha256 as Cargo.lock records it; without one, crates.io's index is read
// for it on every call, cached crate or not. Either way the bytes are
// checked against it, whether they were downloaded from static.crates.io
// (before they are cached) or read from a cache.
//
// Cargo's own cache is read first, and never written: each registry's
// `<name>-<version>.crate` under $CARGO_HOME/registry/cache, else under
// `~/.cargo`. A file there that does not match is passed over. One in
// setCacheDir's cache that does not match throws.
export function getCrate(name: string, version: string, checksum?: string): Promise<Uint8Array>

// What resolveCrateRepos maps each resolved name to: `owner/name`, the
// GitHub repo the crate's `repository` on crates.io names.
export interface CrateRepo {
  github: string
}
// Fail-soft, as npm.js's resolvePackageRepos: a crate crates.io does not
// have, one naming no GitHub repo, and those of a request that fails are
// absent from the map. crates.io is asked a hundred names a request, a
// second apart, as it asks; a repo found is cached for a month, and
// `cachedOnly` answers from that cache alone and never fetches.
export function resolveCrateRepos(crateNames: Iterable<string>, options?: { cachedOnly?: boolean }): Promise<Map<string, CrateRepo>>
