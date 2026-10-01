// yarn.lock, `# yarn lockfile v1`, as yarn 1 writes it: every entry checked
// and every pattern resolved, and with the manifests the projects that ask
// for them. yarn1.d.ts says what comes back. Reading only; nothing here
// writes a lockfile.
export { parseYarn1Lockfile } from './src/yarn1/parse.js'
export { LockfileError } from './src/error.js'
