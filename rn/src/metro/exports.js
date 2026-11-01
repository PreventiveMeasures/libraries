// How Metro reads a package's `exports` and `imports` (metro-resolver's
// PackageExportsResolve, PackageImportsResolve and their utils), which is not
// how Node reads them. Each entry is reduced by the conditions: an object by
// its keys the conditions hold, in order, to the first that reduces to a
// string or null, else to null, as an array is. A map is refused whole where
// any entry holds a value no target can be (a number, a boolean), or reduces
// to one not starting `./`. A subpath takes its own entry, null or not, else
// the pattern whose part before the `*` is longest, then the longest
// pattern. Every miss here -- a map refused, a subpath it does not list, a
// null target -- is null: Metro's cue to fall back to resolving by files.
// An `exports` that is a number or a boolean fails the resolution outright:
// that is FAILED. Mirrors metro-resolver 0.87.2, MIT licensed, Copyright (c)
// Meta Platforms, Inc. and affiliates.

// What fails a resolution outright, here and in the resolver, where a miss
// (null) falls back.
export const FAILED = Symbol('failed')

const exportsMaps = new WeakMap()

// normalizeExportsField: `exports` as a Map of subpaths, null where Metro
// refuses it -- a root array to its first `./` string (its first value where
// any is not a string), a subpath's array to its first item -- and FAILED
// where Metro's WeakMap of them throws, on a key that is no object.
function exportsMap(exportsField) {
  if (typeof exportsField === 'string') return new Map([['.', exportsField]])
  if (typeof exportsField !== 'object') return FAILED
  if (!exportsMaps.has(exportsField)) exportsMaps.set(exportsField, normalizeExports(exportsField))
  return exportsMaps.get(exportsField)
}

function normalizeExports(exportsField) {
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

// What `pattern`'s one `*` stands for in `subpath`, else null.
function patternMatch(pattern, subpath) {
  const [base, trailer] = pattern.split('*')
  if (!subpath.startsWith(base)) return null
  if (trailer.length > 0 && (!subpath.endsWith(trailer) || subpath.length < pattern.length)) return null
  return subpath.slice(base.length, subpath.length - trailer.length)
}

// Whether `map` lists `subpath`, as a key or by a pattern with one `*`.
const lists = (map, subpath) => map.has(subpath) || [...map.keys()].some((key) => key.split('*').length === 2 && patternMatch(key, subpath) !== null)

const NO_MATCH = Symbol('no match')
const REFUSED = Symbol('refused')

// The string or null `value` reduces to under `conditions`: NO_MATCH where no
// condition it lists is held, REFUSED where it holds what no target can be.
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

// What `subpath` maps to in `map` under `conditions`: { to, star }, the
// target as the map spells it and what a pattern's `*` stands for (null for
// an entry of its own), or null.
function target(map, subpath, conditions) {
  if (!lists(map, subpath)) return null
  const reduced = new Map()
  for (const [key, value] of map) {
    const to = reduce(value, conditions)
    if (to === REFUSED) return null
    reduced.set(key, typeof to === 'string' ? to : null)
  }
  if ([...reduced.values()].some((to) => to !== null && !to.startsWith('./'))) return null
  if (reduced.has(subpath)) return reduced.get(subpath) === null ? null : { to: reduced.get(subpath), star: null }
  const patterns = [...reduced.keys()]
    .filter((key) => key.includes('*'))
    .toSorted((a, b) => b.indexOf('*') - a.indexOf('*') || b.length - a.length)
  for (const key of patterns) {
    const star = patternMatch(key, subpath)
    if (star !== null) return reduced.get(key) === null ? null : { to: reduced.get(key), star }
  }
  return null
}

// The target with each `*` replaced, as replaceAll replaces it: a `$&` in
// what it stands for is the `*` again.
const expand = (found) => (found === null ? null : found.star === null ? found.to : found.to.replaceAll('*', found.star))

// A segment Metro refuses in an `exports` target as spelled, past its `./`.
const INVALID_SEGMENTS = new Set(['', '.', '..', 'node_modules'])

// The package-relative path `subpath` (`.` or `./x`) maps to through the
// `exports` field, or null, or FAILED.
export function exportsTarget(exportsField, subpath, conditions) {
  const map = exportsMap(exportsField)
  if (map === FAILED) return FAILED
  const found = map === null ? null : target(map, subpath, conditions)
  if (found?.to.slice(2).split(/[\\/]/u).some((segment) => INVALID_SEGMENTS.has(segment))) return null
  return expand(found)
}

// The package-relative path the `#` specifier maps to through the `imports`
// field, or null. A field with no keys, or one not starting `#`, is refused.
export function importsTarget(importsField, specifier, conditions) {
  if (importsField === null || typeof importsField !== 'object' || Array.isArray(importsField)) return null
  const keys = Object.keys(importsField)
  if (keys.length === 0 || keys.some((key) => !key.startsWith('#'))) return null
  return expand(target(new Map(Object.entries(importsField)), specifier, conditions))
}
