// The dependencies folder built in memory from a soldeer.lock, as Soldeer
// 0.12 installs it; see soldeer.d.ts.
export { buildSoldeerTree } from './src/soldeer/tree.js'
export { DeptreeError } from './src/error.js'
export { setCacheDir } from '@preventive/upstream/npm.js'
export { LockfileError, TomlError } from '@preventive/lockfile/soldeer.js'
