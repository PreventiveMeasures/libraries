// Which patch pnpm 10 applies to a package: not the one its snapshot key
// names, but the one the settings' patchedDependencies pick for its name
// and version (@pnpm/patching.config's getPatchInfo): `name@version`
// exactly, else the one `name@range` whose range takes the version — two
// that do are refused — else `name@*` or `name` alone. Every snapshot is
// held to have the patch hash that pick has, so the patch applied here by
// the key is the one pnpm applies; and, stricter than pnpm, which checks
// this only when it resolves, every patch configured has to be the pick of
// some snapshot.

import { packageKeyOf } from '@preventive/lockfile/pnpm.js'
import { satisfies, valid, validRange } from '@preventive/upstream/semver.js'
import { DeptreeError, quote } from '../error.js'

// dependency-path's parse of a selector: a name and an exact version, a
// name and anything else after its `@`, or neither.
function parseSelector(selector) {
  const at = selector.indexOf('@', 1)
  const rest = at === -1 ? '' : packageKeyOf(selector).slice(at + 1)
  if (rest === '') return {}
  const name = selector.slice(0, at)
  return valid(rest) === rest ? { name, version: rest } : { name, range: rest }
}

// groupPatchedDependencies: by package name, the selectors that can pick
// it; a later one of a kind over an earlier, as pnpm assigns them.
function group(selectors) {
  const groups = new Map()
  const of = (name) => {
    if (!groups.has(name)) groups.set(name, { exact: new Map(), ranges: [], all: undefined })
    return groups.get(name)
  }
  for (const selector of selectors) {
    const { name, version, range } = parseSelector(selector)
    if (version !== undefined) of(name).exact.set(version, selector)
    else if (range === undefined) of(selector).all = selector
    else if (validRange(range) === null) throw new DeptreeError(`${quote(range)} is not a version range, which pnpm refuses`, `patchedDependencies[${quote(selector)}]`)
    else if (range.trim() === '*') of(name).all = selector
    else of(name).ranges.push({ range, selector })
  }
  return groups
}

function pick(groups, name, version, where) {
  const found = groups.get(name)
  if (found === undefined) return undefined
  if (found.exact.has(version)) return found.exact.get(version)
  const taking = found.ranges.filter(({ range }) => satisfies(version, range))
  if (taking.length > 1) throw new DeptreeError(`the patches ${taking.map(({ selector }) => quote(selector)).join(' and ')} both take it, which pnpm refuses`, where)
  return taking[0]?.selector ?? found.all
}

// `hashes` is the configured patches' hashes and paths, by selector.
export function checkPatchUse(lockfile, hashes) {
  const groups = group(Object.keys(hashes))
  const used = new Set()
  for (const [key, pkg] of Object.entries(lockfile.packages)) {
    const selector = pick(groups, pkg.name, pkg.version, quote(key))
    const wanted = selector === undefined ? undefined : hashes[selector].hash
    if (wanted !== pkg.patchHash) {
      throw new DeptreeError(`pnpm applies ${selector === undefined ? 'no patch' : `the patch of ${quote(selector)}`} to it, and the lockfile names ${pkg.patchHash === undefined ? 'none' : `the patch ${pkg.patchHash}`}`, quote(key))
    }
    if (selector !== undefined) used.add(selector)
  }
  for (const selector of Object.keys(hashes)) {
    if (!used.has(selector)) throw new DeptreeError('patches no package in the lockfile', `patchedDependencies[${quote(selector)}]`)
  }
}
