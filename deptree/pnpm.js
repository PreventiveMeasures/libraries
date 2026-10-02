// A node_modules tree built in memory from a pnpm lockfile, as pnpm 9, 10,
// 11 or 12 installs it with the isolated linker; see pnpm.d.ts.
export { buildPnpmTree } from './src/pnpm/tree.js'
export { findPnpmProjects } from './src/pnpm/inputs.js'
export { DeptreeError } from './src/error.js'
export { setCacheDir } from '@preventive/upstream/npm.js'
export { LockfileError, YamlError } from '@preventive/lockfile/pnpm.js'
