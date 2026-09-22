// The tar half of @preventive/archive, reached as
// `@preventive/archive/tar.js`; the zip half is beside it, and the two
// share only the name rules and text helpers at the top of src/. Inside,
// archive/ runs on browser APIs alone, plus @exodus/bytes for hardened
// UTF-8 and CRC-32 (self-contained.test.js enforces both).

// Entries in, one Uint8Array out: byte for byte what GNU tar writes.
export { pack } from './src/tar/pack.js'

// An archive in, its entries out, under the same rules pack() writes by.
export { unpack } from './src/tar/unpack.js'

// The same as plain generators, a chunk or an entry at a time; the Async
// pair also take async iterables.
export { packStream, packStreamAsync } from './src/tar/pack.js'
export { unpackStream, unpackStreamAsync } from './src/tar/unpack.js'

export { ArchiveError } from './src/error.js'
