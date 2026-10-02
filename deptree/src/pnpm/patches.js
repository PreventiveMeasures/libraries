// pnpm 10 applies the patch patchedDependencies picks for a package's name
// and version (@pnpm/patching.config's getPatchInfo), not the one its
// snapshot key names: `name@version`, else the one `name@range` taking the
// version, else `name@*` or `name`. Every snapshot must name that pick's
// hash, so applying by key matches pnpm; and, stricter than pnpm (which
// checks this only when resolving), every patch must be some snapshot's.

import { packageKeyOf } from '@preventive/lockfile/pnpm.js'
import { isExactVersion, satisfies, valid, validRange } from '@preventive/upstream/semver.js'
import { DeptreeError, quote } from '../error.js'

// dependency-path's parse of a selector: a name and an exact version, a
// name and anything else after its `@`, or neither.
function parseSelector(selector) {
  const at = selector.indexOf('@', 1)
  const rest = at === -1 ? '' : packageKeyOf(selector).slice(at + 1)
  if (rest === '') return {}
  const name = selector.slice(0, at)
  return isExactVersion(rest) ? { name, version: rest } : { name, range: rest }
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

const PATCH = '(patch_hash='

// A key's trailing parenthesized groups, each on its own, and what is
// before them; undefined where they do not balance.
function splitSuffix(key) {
  const segments = []
  let end = key.length
  while (end > 0 && key[end - 1] === ')') {
    let depth = 0
    let start = end - 1
    for (; start >= 0; start--) {
      if (key[start] === ')') depth++
      else if (key[start] === '(' && --depth === 0) break
    }
    if (start < 0) return undefined
    segments.unshift(key.slice(start, end))
    end = start
  }
  return { locator: key.slice(0, end), segments }
}

// dependency-path's parse, of what is read here: the name, the version
// where it is SemVer, and the patch hash.
function parseKey(key) {
  const at = key.indexOf('@', 1)
  if (at === -1 || at === key.length - 1) return {}
  const rest = key.slice(at + 1)
  const base = packageKeyOf(rest)
  const hash = rest.startsWith(PATCH, base.length) ? rest.slice(base.length + PATCH.length, rest.indexOf(')', base.length)) : undefined
  return { name: key.slice(0, at), version: valid(base) === null ? undefined : base, hash }
}

// pnpm 11 checks patch hashes down through a key's peers too
// (@pnpm/lockfile.fs's checkPatchedDepPaths), pnpm 10 only the snapshot:
// a peer that names a patch hash, or, unless dedupePeers leaves versions
// out, one of a version of a patched package, must name its pick's hash.
export function checkPeerPatches(lockfile, hashes) {
  const groups = group(Object.keys(hashes))
  const carried = lockfile.settings.dedupePeers !== true
  const uncheckable = (key, where) => new DeptreeError(`${quote(key)} is patched in a way pnpm 11 cannot check against patchedDependencies, which a frozen install refuses`, where)
  const seen = new Set()
  const judge = (key, where) => {
    const suffix = splitSuffix(key)
    if (key.includes(PATCH) && (suffix === undefined || suffix.locator.includes(PATCH) || suffix.segments.slice(1).some((segment) => segment.startsWith(PATCH)))) throw uncheckable(key, where)
    const { name, version, hash } = parseKey(key)
    if (name === undefined) throw uncheckable(key, where)
    const known = lockfile.packages[key]?.version ?? version
    const found = groups.get(name)
    if (known === undefined && found !== undefined && (found.exact.size > 0 || found.ranges.length > 0)) throw uncheckable(key, where)
    const selector = pick(groups, name, known ?? '', where)
    if ((selector === undefined ? undefined : hashes[selector].hash) !== hash) {
      throw new DeptreeError(`the patch hash ${quote(key)} names is not the one of the patch pnpm picks for it, which pnpm 11 refuses a frozen install for`, where)
    }
    const peers = []
    for (const segment of suffix?.segments ?? []) {
      if (segment.startsWith(PATCH)) continue
      const peer = segment.slice(1, -1)
      const parsed = parseKey(peer)
      if (segment.includes(PATCH) || (carried && version !== undefined && parsed.version !== undefined && groups.has(parsed.name))) peers.push(peer)
    }
    return peers
  }
  for (const key of Object.keys(lockfile.packages)) {
    let level = [key]
    while (level.length > 0) {
      level = level.filter((peer) => !seen.has(peer)).flatMap((peer) => {
        seen.add(peer)
        return judge(peer, quote(key))
      })
    }
  }
}
