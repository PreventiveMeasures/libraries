// rubygems.org's gems. Names, versions, platforms (`ruby` for none) and
// checksums are checked before any request, and pass as
// @preventive/lockfile's BundlerSpec has them.

export { HttpError } from './npm.js'

// Throws unless the compact index has `checksum` for that version and platform.
export function verifyChecksum(name: string, version: string, platform: string, checksum: string): Promise<void>

// A published .gem, checked against `checksum`, else the compact index's.
// RubyGems' own caches are read first; setCacheDir's (npm.js) is written.
export function getGem(name: string, version: string, platform: string, checksum?: string): Promise<Uint8Array>
