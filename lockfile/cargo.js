// Cargo.lock of version 3 or 4, the Cargo.toml files of what it locks, and
// a vendor directory, read strictly and tied together: the graph, the
// features each package declares and asks of others, the features a build
// turns on, and which vendored copy is which package. Texts in, nothing
// read from a filesystem; cargo.d.ts says what comes back.
export { parseCargoLock } from './src/cargo/lock.js'
export { parseCargoManifest } from './src/cargo/manifest.js'
export { readCargoVendor } from './src/cargo/vendor.js'
export { linkCargo } from './src/cargo/graph.js'
export { resolveCargoFeatures } from './src/cargo/features.js'
export { LockfileError } from './src/error.js'
// What the TOML beneath is refused with, from the parser in toml.js.
export { TomlError } from './src/toml/error.js'
