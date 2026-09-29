// Hand-written against cargo.js; a change to either belongs with the other.
//
// The name is asserted to be a crate name, the version an exact semver
// version, and a checksum 64 lowercase hex digits, before any request or
// cache path. The cache is setCacheDir's (npm.js).

export { HttpError } from './npm.js'

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
