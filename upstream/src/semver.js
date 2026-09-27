import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { basename, dirname, resolve } from 'node:path'

// npm's own semver, borrowed from the npm next to node rather than added
// as a dependency: the same implementation `npm audit` uses, passed
// through as it is. Without npm beside node, every call throws, except
// `valid` on a plain release.

const CANDIDATE_PATHS = [
  // POSIX: <prefix>/bin/node, <prefix>/lib/node_modules/npm.
  '../lib/node_modules/npm/node_modules/semver',
  // Windows: npm sits beside node.exe.
  './node_modules/npm/node_modules/semver',
]
const USED = ['compare', 'satisfies', 'valid']
// Plain releases that semver.valid answers unchanged, so it need not be
// loaded for them: no leading zeros, and at most 15 digits a part, under
// Number.MAX_SAFE_INTEGER. Anything else goes to semver.
const PLAIN_RELEASE = /^(?:0|[1-9]\d{0,14})\.(?:0|[1-9]\d{0,14})\.(?:0|[1-9]\d{0,14})$/u

// `undefined`: not looked for yet; `null`: not there.
let found

function find() {
  const argv0 = process.argv[0]
  // Another host executable's `../lib` is not npm's.
  if (!['node', 'node.exe'].includes(basename(argv0 ?? ''))) return null
  const require = createRequire(import.meta.url)
  for (const candidate of CANDIDATE_PATHS) {
    try {
      const lib = require(resolve(dirname(argv0), candidate))
      if (USED.every((name) => typeof lib?.[name] === 'function')) return lib
    } catch {
      // Try the next layout.
    }
  }
  return null
}

const lookUp = () => (found === undefined ? (found = find()) : found)

function semver() {
  assert.ok(lookUp(), 'semver: no npm beside node to borrow it from')
  return found
}

export const semverAvailable = () => lookUp() !== null
export const satisfies = (...args) => semver().satisfies(...args)
export const compareVersions = (...args) => semver().compare(...args)
export const valid = (version, ...rest) => (typeof version === 'string' && PLAIN_RELEASE.test(version) ? version : semver().valid(version, ...rest))
// Spelled exactly as semver spells it: not `v1.2.3`, not `1.2.3+build`.
export const isExactVersion = (version) => typeof version === 'string' && valid(version) === version
