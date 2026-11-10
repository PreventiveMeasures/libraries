// A package's "exports" and "imports" as metro-resolver 0.87.2 reads them (PackageExportsResolve,
// PackageImportsResolve; MIT, Copyright (c) Meta Platforms, Inc. and affiliates). Null is a miss,
// where Metro falls back to resolving files; FAILED fails the resolution.

export const FAILED = Symbol('failed')
const NO_MATCH = Symbol('no match')
const REFUSED = Symbol('refused')
const INVALID_SEGMENTS = new Set(['', '.', '..', 'node_modules'])

// normalizeExportsField.
function exportsMap(exportsField) {
  let root = exportsField
  if (Array.isArray(root)) root = root.every((value) => typeof value === 'string') ? root.find((value) => value.startsWith('./')) : root[0]
  if (typeof root === 'string') return new Map([['.', root]])
  // A number or boolean fails, as Metro's WeakMap cache throws on it.
  if (typeof exportsField !== 'object') return FAILED
  if (root == null || Array.isArray(root)) return null
  const entries = Object.entries(root)
  if (entries.some(([, value]) => Array.isArray(value) && (value.length === 0 || Array.isArray(value[0])))) return null
  const flat = new Map(entries.map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]))
  if (flat.keys().every((key) => key.startsWith('.') || key.startsWith('#'))) return flat
  return flat.keys().some((key) => key.startsWith('.')) ? null : new Map([['.', Object.fromEntries(flat)]])
}

// What the pattern's `*` stands for in `subpath`, else null.
function patternMatch(pattern, subpath) {
  const [base, trailer] = pattern.split('*')
  if (!subpath.startsWith(base)) return null
  if (trailer.length > 0 && (!subpath.endsWith(trailer) || subpath.length < pattern.length)) return null
  return subpath.slice(base.length, subpath.length - trailer.length)
}

// A conditional target narrowed by `conditions`: a string, null, NO_MATCH, or REFUSED if invalid.
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

// The target of `subpath`, as spelled (`to`) and with its `*` replaced (`path`), or null. An
// exact key wins even when null; else the pattern with the longest base, then the longest pattern.
function target(map, subpath, conditions) {
  if (!map.has(subpath) && !map.keys().some((key) => key.split('*').length === 2 && patternMatch(key, subpath) !== null)) return null
  const reduced = new Map(map.entries().map(([key, value]) => [key, reduce(value, conditions)]))
  if (reduced.values().some((to) => to === REFUSED || (typeof to === 'string' && !to.startsWith('./')))) return null
  const patterns = [...reduced.keys()].filter((key) => key.includes('*')).toSorted((a, b) => b.indexOf('*') - a.indexOf('*') || b.length - a.length)
  const key = reduced.has(subpath) ? subpath : patterns.find((pattern) => patternMatch(pattern, subpath) !== null)
  const to = reduced.get(key)
  if (typeof to !== 'string') return null
  // A replacement string, as Metro uses it: a `$&` in the match is the `*`.
  return { to, path: key === subpath ? to : to.replaceAll('*', patternMatch(key, subpath)) }
}

// The package-relative target of `subpath` (`.` or `./x`), null, or FAILED.
export function exportsTarget(exportsField, subpath, conditions) {
  const map = exportsMap(exportsField)
  if (!(map instanceof Map)) return map
  const found = target(map, subpath, conditions)
  // Segments are checked as the target spells them, before `*` is replaced.
  if (found === null || found.to.slice(2).split(/[\\/]/u).some((segment) => INVALID_SEGMENTS.has(segment))) return null
  return found.path
}

// The package-relative target of a `#` specifier, or null.
export function importsTarget(importsField, specifier, conditions) {
  if (importsField === null || typeof importsField !== 'object' || Array.isArray(importsField)) return null
  const keys = Object.keys(importsField)
  if (keys.length === 0 || keys.some((key) => !key.startsWith('#'))) return null
  return target(new Map(Object.entries(importsField)), specifier, conditions)?.path ?? null
}
