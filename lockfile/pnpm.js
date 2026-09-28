// pnpm-lock.yaml, `lockfileVersion: '9.0'`, as pnpm 9 to 12 write it: every
// field checked and the indirections resolved. pnpm.d.ts says what comes
// back. Reading only; nothing here writes a lockfile.
export { parsePnpmLockfile } from './src/pnpm/parse.js'
export { packageKeyOf } from './src/pnpm/key.js'
export { LockfileError } from './src/error.js'
// What the YAML beneath is refused with, from the parser this reads it by.
export { YamlError } from '@preventive/yaml'
