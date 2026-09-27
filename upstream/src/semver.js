import { createRequire } from 'node:module'
import { basename, dirname, resolve } from 'node:path'

// npm's own semver, borrowed from the npm next to node rather than added
// as a dependency: the same implementation `npm audit` uses. Without it,
// this fails soft: `satisfies` answers true, over-reporting rather than
// hiding an advisory, and `semverAvailable()` lets a caller say so.

const CANDIDATE_PATHS = [
  // POSIX: <prefix>/bin/node, <prefix>/lib/node_modules/npm.
  '../lib/node_modules/npm/node_modules/semver',
  // Windows: npm sits beside node.exe.
  './node_modules/npm/node_modules/semver',
]

// `undefined`: not tried yet; `null`: unavailable.
let loaded

function load() {
  if (loaded !== undefined) return loaded
  loaded = null
  const argv0 = process.argv[0]
  // Another host executable's `../lib` is not npm's.
  if (!['node', 'node.exe'].includes(basename(argv0 ?? ''))) return loaded
  const require = createRequire(import.meta.url)
  for (const candidate of CANDIDATE_PATHS) {
    try {
      const semver = require(resolve(dirname(argv0), candidate))
      if (typeof semver?.satisfies === 'function' && typeof semver?.compare === 'function') {
        loaded = semver
        break
      }
    } catch {
      // Try the next layout.
    }
  }
  return loaded
}

export function semverAvailable() {
  return load() !== null
}

// A prerelease of a vulnerable version is vulnerable, hence
// `includePrerelease`. A range that doesn't parse matches everything.
export function satisfies(version, range) {
  const semver = load()
  if (!semver) return true
  try {
    // satisfies() answers false for a bad range.
    if (semver.validRange(range, { includePrerelease: true }) === null) return true
    return semver.satisfies(version, range, { includePrerelease: true })
  } catch {
    return true
  }
}

// The string fallback is wrong about 1.10.0 vs 1.9.0, but deterministic.
export function compareVersions(a, b) {
  const semver = load()
  if (semver) {
    try {
      return semver.compare(a, b)
    } catch {
      // Not a version semver can order.
    }
  }
  return a < b ? -1 : (a > b ? 1 : 0)
}

// The registry's advisories endpoint rejects a whole batch over one
// inexact version.
const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/u

export function isExactVersion(version) {
  return typeof version === 'string' && EXACT_VERSION_RE.test(version)
}

// semver.valid normalizes (`v1.2.3` → `1.2.3`). The fallback is looser
// about spelling, not about characters.
export function valid(version) {
  const semver = load()
  if (semver) return semver.valid(version)
  return isExactVersion(version) ? version : null
}
