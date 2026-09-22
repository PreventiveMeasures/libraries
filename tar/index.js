// The package's public surface: everything outside `tar/` goes through
// this file, and nothing outside it reaches for a module by name. What is
// listed here is what a caller actually needs — a name absent from it is
// internal, free to move between the modules below without a single edit
// elsewhere.
//
// Inside, `tar/` stands alone on browser APIs — Uint8Array, BigInt, and the
// hardened UTF-8 of @exodus/bytes — with nothing from node: at all
// (self-contained.test.js enforces it), so the same modules run wherever
// the archive has to be built or read.

// Entries in, one Uint8Array out — byte for byte what GNU tar writes for the
// same entries, under the format asked for. Strict: a duplicate name, a
// name that could reach outside the archive, or a value the format cannot
// hold is refused rather than written down wrong.
export { pack } from './src/pack.js'

// The other direction: an archive in, its entries out, in order, under the
// same rules — what pack() would refuse to write, this refuses to read.
export { unpack } from './src/unpack.js'

// The same two, a piece at a time. packStream yields the archive's chunks
// as each entry goes in; unpackStream takes the archive's chunks however
// they arrive and yields each entry as it completes. Both are plain
// generators over plain iterables; the Async pair take async iterables
// too, which is what a fetch body or a directory being read is.
export { packStream, packStreamAsync } from './src/pack.js'
export { unpackStream, unpackStreamAsync } from './src/unpack.js'

// What either direction throws when it refuses; `offset` says where in the
// archive the reader was, and is unset from the writer.
export { TarError } from './src/error.js'
