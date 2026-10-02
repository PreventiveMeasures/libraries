// Podfile.lock, as CocoaPods 1.5 to 1.17 write it: every section checked,
// the text held to what CocoaPods writes for it, and the sections to each
// other; and the Podfile held to it by its checksum. cocoapods.d.ts says
// what comes back. Reading only; nothing here writes a lockfile.
export { parsePodfileLock } from './src/cocoapods/parse.js'
export { LockfileError } from './src/error.js'
