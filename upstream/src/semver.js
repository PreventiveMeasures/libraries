import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { basename, dirname, resolve } from 'node:path'

// npm's own semver, borrowed from the npm next to node rather than added
// as a dependency: the same implementation `npm audit` uses, passed
// through as it is. Without npm beside node, every call throws, except
// `valid` on a plain release.

// Plain releases that semver.valid answers unchanged, so it need not be
// loaded for them: no leading zeros, and at most 15 digits a part, under
// Number.MAX_SAFE_INTEGER. Anything else, or any call with options, goes
// to semver.
const PLAIN_RELEASE = /^(?:0|[1-9]\d{0,14})\.(?:0|[1-9]\d{0,14})\.(?:0|[1-9]\d{0,14})$/u

// `undefined`: not looked for yet; `null`: not there.
let found

function find() {
  const argv0 = process.argv[0]
  // Another host executable's `../lib` is not npm's.
  if (!['node', 'node.exe'].includes(basename(argv0 ?? ''))) return null
  const require = createRequire(import.meta.url)
  // POSIX keeps npm in <prefix>/lib beside <prefix>/bin/node; Windows, beside node.exe.
  for (const prefix of ['../lib', '.']) {
    try {
      const lib = require(resolve(dirname(argv0), prefix, 'node_modules/npm/node_modules/semver'))
      if (['compare', 'satisfies', 'valid'].every((name) => typeof lib?.[name] === 'function')) return lib
    } catch {
      // Try the next layout.
    }
  }
  return null
}

function semver() {
  if (found === undefined) found = find()
  assert.ok(found, 'semver: no npm beside node to borrow it from')
  return found
}

export const satisfies = (...args) => semver().satisfies(...args)
export const compareVersions = (...args) => semver().compare(...args)
export const valid = (version, ...rest) => (rest.length === 0 && typeof version === 'string' && PLAIN_RELEASE.test(version) ? version : semver().valid(version, ...rest))
// Spelled exactly as semver spells it: not `v1.2.3`, not `1.2.3+build`.
export const isExactVersion = (version) => typeof version === 'string' && valid(version) === version
