// A node_modules tree built in memory from a pnpm lockfile, as pnpm 10 or
// 11 installs it with the isolated linker: pnpm.d.ts says what it takes and
// what comes back. Nothing here touches a filesystem; tarballs come
// through @preventive/upstream, and whatever cache it keeps is its own.
export { buildPnpmTree } from './src/pnpm/tree.js'
export { DeptreeError } from './src/error.js'
// Where @preventive/upstream caches what it fetches, tarballs among it;
// unset, nothing is cached and nothing is written.
export { setCacheDir } from '@preventive/upstream/npm.js'
// What the inputs beneath are refused with: the lockfile, and the YAML of
// it and of pnpm-workspace.yaml.
export { LockfileError, YamlError } from '@preventive/lockfile/pnpm.js'
