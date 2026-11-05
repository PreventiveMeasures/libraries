// Package.resolved as SwiftPM writes it, for the tests to make their own
// and to write again what was read: keys sorted, two spaces a level, `": "`
// of version 1, written by TSCBasic's JSON, and `" : "` of 2 and 3, by
// JSONEncoder. A field given undefined is left out.
export function encode(value, colon, indent = '') {
  const inner = `${indent}  `
  if (Array.isArray(value)) return `[\n${value.map((item) => `${inner}${encode(item, colon, inner)}`).join(',\n')}\n${indent}]`
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  const entries = Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => (a < b ? -1 : 1))
  return `{\n${entries.map(([key, item]) => `${inner}${JSON.stringify(key)}${colon}${encode(item, colon, inner)}`).join(',\n')}\n${indent}}`
}

// What SwiftPM writes of what parsePackageResolved read: the pins sorted by
// identity without case, of version 1 each field of the state, null where
// none, and of 2 and 3 a registry's location "". Without the line end
// SwiftPM adds after the last "}".
export function write({ version, originHash, pins }) {
  const sorted = Object.values(pins).sort((a, b) => (a.identity.toLowerCase() < b.identity.toLowerCase() ? -1 : 1))
  if (version === 1) {
    const legacy = sorted.map((pin) => ({ package: pin.name, repositoryURL: pin.location, state: { branch: pin.branch ?? null, revision: pin.revision, version: pin.version ?? null } }))
    return encode({ object: { pins: legacy }, version }, ': ')
  }
  const list = sorted.map((pin) => ({
    identity: pin.identity,
    kind: pin.kind,
    location: pin.location ?? '',
    originalLocation: pin.originalLocation,
    state: { branch: pin.branch, revision: pin.revision, version: pin.version },
  }))
  return encode({ originHash, pins: list, version }, ' : ')
}
