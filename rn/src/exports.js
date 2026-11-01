// A package's "exports" and "imports" as metro-resolver 0.87.2 reads them
// (PackageExportsResolve, PackageImportsResolve; MIT, Copyright (c) Meta
// Platforms, Inc. and affiliates). Null is a miss, where Metro falls back to
// resolving by files; FAILED fails the resolution.

export const FAILED = Symbol('failed')
const NO_MATCH = Symbol('no match')
const REFUSED = Symbol('refused')

const exportsMaps = new WeakMap()

// normalizeExportsField. Metro caches it in a WeakMap, which throws on a
// number or a boolean.
function exportsMap(exportsField) {
  if (typeof exportsField === 'string') return new Map([['.', exportsField]])
  if (typeof exportsField !== 'object') return FAILED
  if (!exportsMaps.has(exportsField)) exportsMaps.set(exportsField, normalize(exportsField))
  return exportsMaps.get(exportsField)
}

function normalize(exportsField) {
  let root = exportsField
  if (Array.isArray(root)) root = root.every((value) => typeof value === 'string') ? root.find((value) => value.startsWith('./')) : root[0]
  if (root == null || Array.isArray(root)) return null
  if (typeof root === 'string') return new Map([['.', root]])
  const flat = new Map()
  for (const [key, value] of Object.entries(root)) {
    if (Array.isArray(value) && (value.length === 0 || Array.isArray(value[0]))) return null
    flat.set(key, Array.isArray(value) ? value[0] : value)
  }
  const keys = [...flat.keys()]
  if (keys.every((key) => key.startsWith('.') || key.startsWith('#'))) return flat
  return keys.some((key) => key.startsWith('.')) ? null : new Map([['.', Object.fromEntries(flat)]])
}

// What the pattern's `*` stands for in `subpath`, else null.
function patternMatch(pattern, subpath) {
  const [base, trailer] = pattern.split('*')
  if (!subpath.startsWith(base)) return null
  if (trailer.length > 0 && (!subpath.endsWith(trailer) || subpath.length < pattern.length)) return null
  return subpath.slice(base.length, subpath.length - trailer.length)
}

function reduce(value, conditions) {
  if (value === null || typeof value === 'string') return value
  if (typeof value !== 'object') return REFUSED
  if (Array.isArray(value)) return null
  for (const name in value) {
    if (!conditions.has(name)) continue
    const reduced = reduce(value[name], conditions)
    if (reduced !== NO_MATCH) return reduced
  }
  return NO_MATCH
}

// -> { to, star } or null. An exact key wins even when null; else the
// pattern with the longest base, then the longest.
function target(map, subpath, conditions) {
  if (!map.has(subpath) && ![...map.keys()].some((key) => key.split('*').length === 2 && patternMatch(key, subpath) !== null)) return null
  const reduced = new Map()
  for (const [key, value] of map) {
    const to = reduce(value, conditions)
    if (to === REFUSED) return null
    reduced.set(key, typeof to === 'string' ? to : null)
  }
  if ([...reduced.values()].some((to) => to !== null && !to.startsWith('./'))) return null
  if (reduced.has(subpath)) return reduced.get(subpath) === null ? null : { to: reduced.get(subpath), star: null }
  const patterns = [...reduced.keys()].filter((key) => key.includes('*')).toSorted((a, b) => b.indexOf('*') - a.indexOf('*') || b.length - a.length)
  for (const key of patterns) {
    const star = patternMatch(key, subpath)
    if (star !== null) return reduced.get(key) === null ? null : { to: reduced.get(key), star }
  }
  return null
}

const expand = (found) => (found === null ? null : found.star === null ? found.to : found.to.replaceAll('*', found.star))

const INVALID_SEGMENTS = new Set(['', '.', '..', 'node_modules'])

// The package-relative target of `subpath` (`.` or `./x`), null, or FAILED.
export function exportsTarget(exportsField, subpath, conditions) {
  const map = exportsMap(exportsField)
  if (map === FAILED) return FAILED
  const found = map === null ? null : target(map, subpath, conditions)
  // Segments are checked as the target spells them, before `*` is replaced.
  if (found?.to.slice(2).split(/[\\/]/u).some((segment) => INVALID_SEGMENTS.has(segment))) return null
  return expand(found)
}

// The package-relative target of a `#` specifier, or null.
export function importsTarget(importsField, specifier, conditions) {
  if (importsField === null || typeof importsField !== 'object' || Array.isArray(importsField)) return null
  const keys = Object.keys(importsField)
  if (keys.length === 0 || keys.some((key) => !key.startsWith('#'))) return null
  return expand(target(new Map(Object.entries(importsField)), specifier, conditions))
}
