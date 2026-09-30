// A node_modules tree built in memory from a pnpm lockfile, as pnpm 10 or
// 11 installs it with the isolated linker: pnpm.d.ts says what it takes and
// what comes back. The project is read through the view given, and the
// tree built in a Vfs; the one filesystem touched is that of the tarball
// caches @preventive/upstream reads, and writes where it keeps its own.
export { buildPnpmTree } from './src/pnpm/tree.js'
export { findPnpmProjects } from './src/pnpm/inputs.js'
export { DeptreeError } from './src/error.js'
// Where @preventive/upstream caches what it fetches, tarballs among it;
// unset, it keeps no cache of its own, and writes nothing.
export { setCacheDir } from '@preventive/upstream/npm.js'
// What the inputs beneath are refused with: the lockfile, and the YAML of
// it and of pnpm-workspace.yaml.
export { LockfileError, YamlError } from '@preventive/lockfile/pnpm.js'
