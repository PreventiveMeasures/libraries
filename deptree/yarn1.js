// A node_modules tree built in memory from a yarn.lock, as yarn 1.22
// installs it with its node_modules linker; see yarn1.d.ts.
export { buildYarn1Tree } from './src/yarn1/tree.js'
export { findYarn1Workspaces } from './src/yarn1/inputs.js'
export { DeptreeError } from './src/error.js'
export { setCacheDir } from '@preventive/upstream/npm.js'
export { LockfileError } from '@preventive/lockfile/yarn1.js'
