// Gemfile.lock, or gems.locked, as Bundler 2.2 to 4.0 write it: every line
// checked, every source, gem and dependency held to the form Bundler
// writes it in, and every dependency to the gems locked under its name.
// bundler.d.ts says what comes back. Reading only; nothing here writes a
// lockfile.
export { parseGemfileLock } from './src/bundler/parse.js'
export { LockfileError } from './src/error.js'
