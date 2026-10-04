import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { basename, dirname, resolve } from 'node:path'

// npm's own semver, borrowed from the npm next to node rather than added
// as a dependency: the same implementation `npm audit` uses. Where there is
// no npm, as in a bundled serverless function, the `semver` package itself,
// an optional peer dependency.

// Plain releases that semver.valid answers unchanged, so it need not be
// loaded for them: no leading zeros, and at most 15 digits a part, under
// Number.MAX_SAFE_INTEGER. Anything else, or any call with options, goes
// to semver.
const PLAIN_RELEASE = /^(?:0|[1-9]\d{0,14})\.(?:0|[1-9]\d{0,14})\.(?:0|[1-9]\d{0,14})$/u

const require = createRequire(import.meta.url)
const isSemver = (lib) => ['compare', 'intersects', 'satisfies', 'valid', 'validRange'].every((name) => typeof lib?.[name] === 'function')

let found

function borrow() {
  const argv0 = process.argv[0]
  // Another host executable's `../lib` is not npm's.
  if (!['node', 'node.exe'].includes(basename(argv0 ?? ''))) return null
  // POSIX keeps npm in <prefix>/lib beside <prefix>/bin/node; Windows, beside node.exe.
  for (const prefix of ['../lib', '.']) {
    try {
      const lib = require(resolve(dirname(argv0), prefix, 'node_modules/npm/node_modules/semver'))
      if (isSemver(lib)) return lib
    } catch {}
  }
  return null
}

function peer() {
  try {
    const lib = require('semver')
    if (isSemver(lib)) return lib
  } catch {}
  return null
}

function semver() {
  if (found === undefined) found = borrow() ?? peer()
  assert.ok(found, 'semver: no npm beside node to borrow it from, and the semver peer dependency is not installed')
  return found
}

export const satisfies = (...args) => semver().satisfies(...args)
export const validRange = (...args) => semver().validRange(...args)
export const intersects = (...args) => semver().intersects(...args)
export const compareVersions = (...args) => semver().compare(...args)
export const valid = (version, ...rest) => (rest.length === 0 && typeof version === 'string' && PLAIN_RELEASE.test(version) ? version : semver().valid(version, ...rest))
export const isExactVersion = (version) => typeof version === 'string' && valid(version) === version
export const clean = (...args) => semver().clean(...args)
export const major = (...args) => semver().major(...args)
