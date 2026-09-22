// The public surface; nothing outside reaches past it. Inside, tar/ runs on
// browser APIs alone, plus @exodus/bytes for hardened UTF-8
// (self-contained.test.js enforces both).

// Entries in, one Uint8Array out: byte for byte what GNU tar writes.
export { pack } from './src/pack.js'

// An archive in, its entries out, under the same rules pack() writes by.
export { unpack } from './src/unpack.js'

// The same as plain generators, a chunk or an entry at a time; the Async
// pair also take async iterables.
export { packStream, packStreamAsync } from './src/pack.js'
export { unpackStream, unpackStreamAsync } from './src/unpack.js'

export { TarError } from './src/error.js'
