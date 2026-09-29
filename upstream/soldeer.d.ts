// Hand-written against soldeer.js; a change to either belongs with the
// other.
//
// The name is asserted to be one Soldeer takes, the version a string of
// letters, digits, `.`, `_`, `+` and `-`, and the checksum 64 lowercase hex
// digits, before any request or cache path. The cache is setCacheDir's
// (npm.js).

export { HttpError } from './npm.js'

// A version's zip from Soldeer's registry, whole, in memory. The registry
// says where the zip is but not what it hashes to, so `checksum` is
// required: the zip's sha256, as soldeer.lock records it. The bytes are
// checked against it, whether they were downloaded (before they are
// cached) or read from setCacheDir's cache, where one that does not match
// throws. A cached zip that matches is answered with no request at all.
export function getZip(name: string, version: string, checksum: string): Promise<Uint8Array>
