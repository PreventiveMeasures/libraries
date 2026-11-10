// Package.resolved, version 1, 2 or 3, as SwiftPM 5.0 to 6.4 write it, and
// Xcode with it: every pin checked, the file held to the layout SwiftPM
// writes it in, and the pins to each other; and the manifest held to it by
// its originHash. swiftpm.d.ts says what comes back. Reading only; nothing
// here writes a lockfile.
export { parsePackageResolved } from './src/swiftpm/parse.js'
export { LockfileError } from './src/error.js'
