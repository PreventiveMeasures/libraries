// The dependencies folder built in memory from a soldeer.lock, as Soldeer
// 0.12 installs it: soldeer.d.ts says what it takes and what comes back.
// The project is read through the view given, and the tree built in a Vfs;
// the one filesystem touched is that of the cache @preventive/upstream
// reads, and writes where it keeps one.
export { buildSoldeerTree } from './src/soldeer/tree.js'
export { DeptreeError } from './src/error.js'
// Where @preventive/upstream caches what it fetches, zips among it; unset,
// it keeps no cache of its own, and writes nothing.
export { setCacheDir } from '@preventive/upstream/npm.js'
// What the lockfile, and the config read with it, are refused with.
export { LockfileError, TomlError } from '@preventive/lockfile/soldeer.js'
