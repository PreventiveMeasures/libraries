import assert from 'node:assert/strict'

const byNumbers = new Intl.Collator('en', { numeric: true }).compare
export const order = (a, b) => (a > b) - (a < b)

// Name → its versions, once each and in order, by name. Every name and
// version is checked before any is used.
export function askedVersions(method, packages, assertName, assertVersion, compare = byNumbers) {
  assert.ok(typeof packages?.[Symbol.iterator] === 'function' && typeof packages !== 'string', `${method}: packages must be an iterable of { name, version }`)
  const versions = new Map()
  for (const pkg of packages) {
    assertName(method, 'name', pkg?.name)
    assertVersion(method, 'version', pkg.version)
    versions.set(pkg.name, (versions.get(pkg.name) ?? new Set()).add(pkg.version))
  }
  return new Map([...versions.keys()].toSorted().map((name) => [name, [...versions.get(name)].toSorted(compare)]))
}
