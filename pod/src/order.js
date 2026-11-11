// The orders every stage sorts by: Ruby's of strings, and Pod::Version's of versions.

// Ruby's order of strings, by their UTF-8 bytes.
export const byBytes = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))

// Pod::Version's order, by the numbers a version is made of.
export function compareVersions(a, b) {
  const x = String(a).split('.').map(Number)
  const y = String(b).split('.').map(Number)
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0)
  return 0
}
export const maxVersion = (versions) => versions.reduce((most, version) => (compareVersions(version, most) > 0 ? version : most))
