// package-lock.json, `lockfileVersion: 3`, as npm 9 to 12 write it: every
// field checked, and the tree npm installs from it resolved and held to
// what it says. npm.d.ts says what comes back. Reading only; nothing here
// writes a lockfile.
export { parseNpmLockfile } from './src/npm/parse.js'
export { LockfileError } from './src/error.js'
