// The zip half of @preventive/archive, reached as
// `@preventive/archive/zip.js`. Deflate is the platform's
// CompressionStream and DecompressionStream, raw; the rest is shared with
// the tar half or browser APIs alone.

// Entries in, one Uint8Array out. Strict: a duplicate name, a name that
// could reach outside the archive, or a value the format cannot hold is
// refused rather than written down wrong.
export { zip } from './src/zip/zip.js'

// An archive in, its entries out, under the same rules — and with every
// header, size and checksum in it checked against every other, and the
// sizes all together held to a limit where one is given.
export { unzip } from './src/zip/unzip.js'

export { ArchiveError } from './src/error.js'
