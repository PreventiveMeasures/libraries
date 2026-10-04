'use strict'

// npm's own semver, borrowed from the npm next to node rather than added
// as a dependency: the same implementation `npm audit` uses. Where there is
// no npm, as in a bundled serverless function, the `semver` package itself,
// an optional peer dependency.
//
// CommonJS for a plain require('semver'), which a bundler follows. All else
// is taken past require(), which in an ESM bundle of this is a stub that
// throws: node's modules by process.getBuiltinModule(), npm's semver by a
// require() of node's own making.
const assert = process.getBuiltinModule('node:assert/strict')
const { createRequire } = process.getBuiltinModule('node:module')
const { basename, dirname, resolve } = process.getBuiltinModule('node:path')

// Plain releases that semver.valid answers unchanged, so it need not be
// loaded for them: no leading zeros, and at most 15 digits a part, under
// Number.MAX_SAFE_INTEGER. Anything else, or any call with options, goes
// to semver.
const PLAIN_RELEASE = /^(?:0|[1-9]\d{0,14})\.(?:0|[1-9]\d{0,14})\.(?:0|[1-9]\d{0,14})$/u

// What load() returns if it is semver, or null if it is not or throws.
function attempt(load) {
  try {
    const lib = load()
    if (['compare', 'intersects', 'satisfies', 'valid', 'validRange'].every((name) => typeof lib?.[name] === 'function')) return lib
  } catch {}
  return null
}

function find() {
  const argv0 = process.argv[0]
  // Another host executable's `../lib` is not npm's.
  if (['node', 'node.exe'].includes(basename(argv0 ?? ''))) {
    // POSIX keeps npm in <prefix>/lib beside <prefix>/bin/node; Windows, beside node.exe.
    for (const prefix of ['../lib', '.']) {
      const path = resolve(dirname(argv0), prefix, 'node_modules/npm/node_modules/semver')
      const lib = attempt(() => createRequire(path)(path))
      if (lib) return lib
    }
  }
  return attempt(() => require('semver'))
}

let found

function semver() {
  if (found === undefined) found = find()
  assert.ok(found, 'semver: no npm beside node to borrow it from, and the semver peer dependency is not installed')
  return found
}

const satisfies = (...args) => semver().satisfies(...args)
const validRange = (...args) => semver().validRange(...args)
const intersects = (...args) => semver().intersects(...args)
const compareVersions = (...args) => semver().compare(...args)
const valid = (version, ...rest) => (rest.length === 0 && typeof version === 'string' && PLAIN_RELEASE.test(version) ? version : semver().valid(version, ...rest))
const isExactVersion = (version) => typeof version === 'string' && valid(version) === version
const clean = (...args) => semver().clean(...args)
const major = (...args) => semver().major(...args)

module.exports = { clean, compareVersions, intersects, isExactVersion, major, satisfies, valid, validRange }
