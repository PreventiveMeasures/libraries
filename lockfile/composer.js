// composer.lock, as Composer 2.0 to 2.10 write it: every field of every
// package held to what Composer writes back of it, and the packages
// resolved as `composer install` checks them before it installs, each
// requirement to what meets it. composer.d.ts says what comes back.
// Reading only; nothing here writes a lockfile.
export { parseComposerLock } from './src/composer/lock.js'
export { LockfileError } from './src/error.js'
