// The vendor directory built in memory from a Cargo.lock, as `cargo vendor`
// makes it; see cargo.d.ts.
export { buildCargoTree } from './src/cargo/tree.js'
export { DeptreeError } from './src/error.js'
export { setCacheDir } from '@preventive/upstream/npm.js'
export { LockfileError, TomlError } from '@preventive/lockfile/cargo.js'
