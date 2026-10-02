// yarn 1's package-compatibility.js: a package whose os, cpu or engines the
// host does not take is left out where it is optional, and fails the
// install otherwise; so does the root project. Engines are checked against
// host.node and host.yarn; any other engine Node reports in
// process.versions (v8, uv, openssl and the rest) is refused, as yarn
// checks it against the Node that runs it, which is not known here. One
// yarn knows no version of is passed over, as yarn passes over it.

import { compareVersions, major, satisfies, valid } from '@preventive/upstream/semver.js'
import { DeptreeError, quote } from '../error.js'
import { satisfiesWithPrereleases } from './peers.js'

// What Node reports in process.versions, but `node`, in any release or
// build of it from 12 on (src/node_metadata.h).
const REPORTED = new Set([
  'acorn', 'ada', 'amaro', 'ares', 'base64', 'brotli', 'cjs_module_lexer', 'cldr', 'http_parser', 'icu', 'libffi', 'lief',
  'llhttp', 'merve', 'modules', 'napi', 'nbytes', 'ncrypto', 'nghttp2', 'nghttp3', 'ngtcp2', 'openssl', 'simdjson', 'simdutf',
  'sqlite', 'tz', 'undici', 'unicode', 'uv', 'uvwasi', 'v8', 'zlib', 'zstd',
])

// yarn's isValid: an os or cpu list of names, `!` before one to exclude.
function isValid(items, actual) {
  let isNotWhitelist = true
  let isBlacklist = false
  for (const item of items) {
    if (item[0] === '!') {
      isBlacklist = true
      if (actual === item.slice(1)) return false
    } else {
      isNotWhitelist = false
      if (item === actual) return true
    }
  }
  return isBlacklist && isNotWhitelist
}

const LOOSE = { loose: true }

// yarn's testEngine: yarn's own version taken with its prereleases, and
// Node's versions before 1.0.0 taken for its majors.
function testEngine(name, range, versions) {
  const actual = versions[name]
  if (!actual || !valid(actual, LOOSE)) return false
  if (satisfies(actual, range, LOOSE)) return true
  if (name === 'yarn' && satisfiesWithPrereleases(actual, range, true)) return true
  if (name === 'node' && compareVersions(actual, '1.0.0', LOOSE) > 0) {
    const of = major(actual, LOOSE)
    return [`0.10.${of}`, `0.11.${of}`, `0.12.${of}`, `0.13.${of}`].some((fake) => satisfies(fake, range, LOOSE))
  }
  return false
}

// Why the host does not take `manifest`, or undefined; engines may be a
// list of `name range` strings, which yarn reads into a mapping.
export function incompatibility(manifest, host, where, { ignoreEngines, ignorePlatform }) {
  const { os, cpu } = manifest
  let { engines } = manifest
  if (!ignorePlatform && Array.isArray(os) && os.length > 0 && !isValid(os, host.os)) return `its os, ${JSON.stringify(os)}, does not take ${quote(host.os)}`
  if (!ignorePlatform && Array.isArray(cpu) && cpu.length > 0 && !isValid(cpu, host.cpu)) return `its cpu, ${JSON.stringify(cpu)}, does not take ${quote(host.cpu)}`
  if (ignoreEngines) return undefined
  if (Array.isArray(engines)) engines = Object.fromEntries(engines.filter((item) => typeof item === 'string').map((item) => item.trim().split(/ +/gu)).map(([name, ...rest]) => [name, rest.join(' ')]))
  if (engines === null || typeof engines !== 'object') return undefined
  const versions = { node: host.node, yarn: host.yarn }
  for (let [name, range] of Object.entries(engines)) {
    if (name === 'iojs') name = 'node'
    const known = Object.hasOwn(versions, name)
    if (!known && !REPORTED.has(name)) continue
    if (typeof range !== 'string') throw new DeptreeError(`engines.${name} is not a string, which yarn fails on`, where)
    if (!known) throw new DeptreeError(`yarn checks engines.${name} against the Node it runs on, which is not known here`, where)
    if (!testEngine(name, range, versions)) return `its engines.${name}, ${quote(range)}, does not take ${versions[name]}`
  }
  return undefined
}
