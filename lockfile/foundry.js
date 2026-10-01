// foundry.lock, as forge 1.3 and later write it: every entry checked, and,
// with .gitmodules, where each comes from. foundry.d.ts says what comes back.
// Reading only; nothing here writes a lockfile.
export { parseFoundryLockfile } from './src/foundry/parse.js'
// .gitmodules on its own, as git reads it, for a dependency's submodules.
export { parseGitmodules } from './src/foundry/gitmodules.js'
export { LockfileError } from './src/error.js'
