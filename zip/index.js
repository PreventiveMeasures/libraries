// The public surface; nothing outside reaches past it. Inside, zip/ runs on
// browser APIs alone — CompressionStream and DecompressionStream for
// deflate — plus @exodus/bytes for hardened UTF-8 and CRC-32
// (self-contained.test.js enforces both).

// Entries in, one Uint8Array out. Strict: a duplicate name, a name that
// could reach outside the archive, or a value the format cannot hold is
// refused rather than written down wrong.
export { zip } from './src/zip.js'

// An archive in, its entries out, under the same rules — and with every
// header, size and checksum in it checked against every other.
export { unzip } from './src/unzip.js'

export { ZipError } from './src/error.js'
