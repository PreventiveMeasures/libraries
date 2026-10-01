// yarn 1's package-compatibility.js: a package whose os, cpu or engines
// the host does not take is left out where it is optional, and fails the
// install otherwise; so does the root project, checked as yarn checks it
// before anything is resolved. Engines are checked against the Node yarn
// runs on and yarn itself; any other engine Node reports a version of in
// process.versions — v8, uv, openssl and the rest — would be checked
// against the Node that runs yarn, which is not known here, and is
// refused. One yarn knows of no version for is passed over, as yarn
// passes over it.

import { DeptreeError, quote } from '../error.js'
import { satisfiesWithPrereleases } from './peers.js'

// What Node has reported in process.versions, by release.
const REPORTED = new Set([
  'acorn', 'ada', 'amaro', 'ares', 'brotli', 'cjs_module_lexer', 'cldr', 'http_parser', 'icu', 'llhttp', 'modules', 'napi',
  'nbytes', 'ncrypto', 'nghttp2', 'nghttp3', 'ngtcp2', 'openssl', 'simdjson', 'simdutf', 'sqlite', 'tz', 'undici', 'unicode',
  'uv', 'uvwasi', 'v8', 'zlib', 'zstd',
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

// yarn's testEngine: yarn's own version taken with its prereleases, and
// Node's versions before 1.0.0 taken for its majors.
function testEngine(semver, name, range, versions) {
  const actual = versions[name]
  if (!actual || !semver.valid(actual, true)) return false
  if (semver.satisfies(actual, range, true)) return true
  if (name === 'yarn' && satisfiesWithPrereleases(semver, actual, range, true)) return true
  if (name === 'node' && semver.gt(actual, '1.0.0', true)) {
    const major = semver.major(actual, true)
    return [`0.10.${major}`, `0.11.${major}`, `0.12.${major}`, `0.13.${major}`].some((fake) => semver.satisfies(fake, range, true))
  }
  return false
}

// Why the host does not take `manifest`, or undefined where it does. A
// manifest's engines may be a list of `name range` strings, which yarn
// reads into a mapping first.
export function incompatibility(manifest, host, semver, where) {
  const { os, cpu } = manifest
  let { engines } = manifest
  if (Array.isArray(os) && os.length > 0 && !isValid(os, host.os)) return `its os, ${JSON.stringify(os)}, does not take ${quote(host.os)}`
  if (Array.isArray(cpu) && cpu.length > 0 && !isValid(cpu, host.cpu)) return `its cpu, ${JSON.stringify(cpu)}, does not take ${quote(host.cpu)}`
  if (Array.isArray(engines)) {
    const read = {}
    for (const item of engines) {
      if (typeof item !== 'string') continue
      const [name, ...rest] = item.trim().split(/ +/gu)
      read[name] = rest.join(' ')
    }
    engines = read
  }
  if (engines === null || typeof engines !== 'object') return undefined
  const versions = { node: host.node, yarn: host.yarn }
  for (let [name, range] of Object.entries(engines)) {
    if (name === 'iojs') name = 'node'
    if (typeof range !== 'string' && (Object.hasOwn(versions, name) || REPORTED.has(name))) throw new DeptreeError(`engines.${name} is not a string, which yarn fails on`, where)
    if (Object.hasOwn(versions, name)) {
      if (!testEngine(semver, name, range, versions)) return `its engines.${name}, ${quote(String(range))}, does not take ${versions[name]}`
    } else if (REPORTED.has(name)) {
      throw new DeptreeError(`yarn checks engines.${name} against the Node it runs on, which is not known here`, where)
    }
  }
  return undefined
}
