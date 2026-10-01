// A node_modules tree built in memory from a yarn.lock, as yarn 1.22
// installs it with its node_modules linker: yarn1.d.ts says what it takes
// and what comes back. The project is read through the view given, and
// the tree built in a Vfs; the one filesystem touched is that of the
// tarball caches @preventive/upstream reads, and writes where it keeps its
// own.
export { buildYarn1Tree } from './src/yarn1/tree.js'
export { findYarn1Workspaces } from './src/yarn1/inputs.js'
export { DeptreeError } from './src/error.js'
// Where @preventive/upstream caches what it fetches, tarballs among it;
// unset, it keeps no cache of its own, and writes nothing.
export { setCacheDir } from '@preventive/upstream/npm.js'
// What the lockfile, and the manifests read with it, are refused with.
export { LockfileError } from '@preventive/lockfile/yarn1.js'
