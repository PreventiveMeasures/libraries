// The Pods directory built in memory from a Podfile.lock, as CocoaPods 1.13
// to 1.17 download pods into it; see cocoapods.d.ts.
export { buildCocoaPodsTree } from './src/cocoapods/tree.js'
export { DeptreeError } from './src/error.js'
export { setCacheDir } from '@preventive/upstream/npm.js'
export { LockfileError } from '@preventive/lockfile/cocoapods.js'
