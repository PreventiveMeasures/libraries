// A platform a build is for, as `rustc --print cfg` prints it, or known in
// part, and the [target.<platform>] tables of a manifest matched against it
// by cargo-platform's rules.

import { parseCfg, parsePlatform, platformMatches } from '../crate/cargo-platform.js'
import { at, quote, raise } from '../error.js'

const NAME = /^[A-Z_a-z]\w*$/u

// `{ name, cfg, decides }`, as platformMatches takes it.
export function readPlatform(value, where) {
  if (typeof value !== 'object' || value === null || !Array.isArray(value.cfg) || !(value.name === undefined || typeof value.name === 'string')) {
    throw new TypeError(`expected ${where} as { name, cfg }`)
  }
  if (value.decides !== undefined && !(Array.isArray(value.decides) && value.decides.every((name) => typeof name === 'string'))) {
    throw new TypeError(`expected ${where}.decides as the names of cfgs`)
  }
  const keys = value.cfg.map((line) => parseCfg(line) ?? raise(`${quote(line)} is not a line of \`rustc --print cfg\``, where))
  const decides = value.decides?.map((name) => (NAME.test(name) ? name : raise(`${quote(name)} is not the name of a cfg`, at(where, 'decides'))))
  return { name: value.name, cfg: new Set(keys), decides: decides === undefined ? undefined : new Set(decides) }
}

// Whether a platform read leaves anything undecided.
export const undecided = (platform) => platform.name === undefined || platform.decides !== undefined

export function matchCargoPlatform(platform) {
  const read = readPlatform(platform, 'platform')
  const parsed = new Map()
  return (target) => {
    if (typeof target !== 'string') throw new TypeError('expected a platform as a [target] table names it')
    if (!parsed.has(target)) parsed.set(target, parsePlatform(target))
    const spec = parsed.get(target) ?? raise(`${quote(target)} is neither a target's name nor a cfg(\u2026) cargo reads`)
    return platformMatches(spec, read)
  }
}
