import { createRequire } from 'node:module'
import { basename, dirname, resolve } from 'node:path'

// Range matching, for deciding which versions an advisory's
// `vulnerable_versions` range actually covers, and validation, for
// deciding which versions are fit to go into a registry request at all.
//
// npm ships its own `semver`, and npm ships with Node, at a path fixed
// relative to the running binary. @exodus/stasis's audit borrows it
// rather than adding a dependency for that one job, and this does the
// same — this package's dependency list stays empty, and the matching is
// the same implementation `npm audit` itself resolves these ranges with.
//
// Where stasis asserts, this FAILS SOFT. A Node install with no npm
// beside it — a standalone build, a distro that splits the package, a
// container that dropped it — is not a reason to abort a caller's run,
// so `satisfies` then answers true for every range. That reports every
// version of a package as affected by every advisory checked against
// it: it over-reports and never hides one, which is the only direction a
// vulnerability report may be wrong in when it is guessing.
// `semverAvailable()` is what lets the caller say so out loud rather
// than passing the guess off as a measurement.
const CANDIDATE_PATHS = [
  // POSIX layout: <prefix>/bin/node and <prefix>/lib/node_modules/npm.
  '../lib/node_modules/npm/node_modules/semver',
  // Windows layout: npm sits beside node.exe rather than under lib/.
  './node_modules/npm/node_modules/semver',
]

// `undefined` = not tried yet, `null` = tried and unavailable. Cached
// either way so a thousand advisories don't re-walk the filesystem a
// thousand times to re-learn the same answer.
let loaded

function load() {
  if (loaded !== undefined) return loaded
  loaded = null
  const argv0 = process.argv[0]
  // Guard the path arithmetic on the binary actually being node: an
  // embedder running this from some other host executable would resolve
  // `../lib/node_modules` to a directory that has nothing to do with npm.
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
      // Next layout. Nothing here is worth reporting per-candidate — the
      // caller asks `semverAvailable()` once and reports the outcome.
    }
  }
  return loaded
}

export function semverAvailable() {
  return load() !== null
}

// Is `version` inside `range`? `includePrerelease` is a deliberate
// departure from npm's own audit defaults: without it a version like
// `4.17.20-rc.1` does not satisfy `<4.17.21`, because plain semver range
// semantics keep prereleases out of any comparator tuple that didn't
// name one. A package pinned to a prerelease of a vulnerable version is
// running the vulnerable code, and a report exists to say so — the
// same "never hide one" direction the fallback above takes.
//
// A range npm can't parse (a malformed advisory, a shape a newer
// registry starts emitting) reads as matching, for that reason too.
export function satisfies(version, range) {
  const semver = load()
  if (!semver) return true
  try {
    // `satisfies` swallows a bad range and answers false, which is the
    // one answer this must never give for a reason that isn't about the
    // version. Ask whether the range parses first, so an advisory in a
    // shape npm can't read is reported against everything rather than
    // against nothing.
    if (semver.validRange(range, { includePrerelease: true }) === null) return true
    return semver.satisfies(version, range, { includePrerelease: true })
  } catch {
    return true
  }
}

// Version ordering for display, and for the order versions are
// submitted to the registry in. Falls back to a plain string compare,
// which is wrong about `1.10.0` vs `1.9.0` and right about everything
// being deterministic, which is all this is for.
export function compareVersions(a, b) {
  const semver = load()
  if (semver) {
    try {
      return semver.compare(a, b)
    } catch {
      // Not a version either implementation can order; fall through.
    }
  }
  return a < b ? -1 : (a > b ? 1 : 0)
}

// An exact semver version, which is what the registry requires of every
// version in an advisories request — it 400s the whole batch over one
// bad entry. Lockfiles carry resolved versions so this passes for
// essentially everything; what it catches is the odd `file:`/`link:`
// workspace pin or a `version` field the producer left as a range.
const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/u

export function isExactVersion(version) {
  return typeof version === 'string' && EXACT_VERSION_RE.test(version)
}

// npm's `semver.valid`: the version as semver spells it, or null for
// anything that is not one. It normalizes as it goes — `v1.2.3`,
// ` 1.2.3 ` and `1.2.3+build` all answer `1.2.3` — so a caller that
// wants the exact spelling compares the answer with what it passed.
//
// Without npm's semver this falls back to isExactVersion, which is
// looser about the spelling (leading zeros, build metadata) but no
// looser about the characters: digits, dots, `[\w+-]`, nothing that can
// change a URL's path or a file's directory.
export function valid(version) {
  const semver = load()
  if (semver) return semver.valid(version)
  return isExactVersion(version) ? version : null
}
