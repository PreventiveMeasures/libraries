// A node_modules tree built in memory from a package-lock.json, as npm 10
// or 11 installs it with `npm ci`; see npm.d.ts.
export { buildNpmTree } from './src/npm/tree.js'
export { findNpmWorkspaces } from './src/npm/inputs.js'
export { DeptreeError } from './src/error.js'
export { setCacheDir } from '@preventive/upstream/npm.js'
export { LockfileError } from '@preventive/lockfile/npm.js'
