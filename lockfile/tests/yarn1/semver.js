import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'

// npm's own semver, from the npm beside node, as the readers' callers pass
// it: POSIX keeps npm in <prefix>/lib beside <prefix>/bin/node; Windows,
// beside node.exe.
const require = createRequire(import.meta.url)
const tryRequire = (path) => {
  try {
    return require(path)
  } catch {
    return undefined
  }
}

export const semver = ['../lib', '.'].map((prefix) => tryRequire(resolve(dirname(process.execPath), prefix, 'node_modules/npm/node_modules/semver'))).find(Boolean)
if (semver === undefined) throw new Error('no npm beside node to borrow semver from')
