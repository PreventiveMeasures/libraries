// Hand-written against semver.js; a change to either belongs with the other.

// npm's own semver, borrowed from the Node install. Without it, which
// semverAvailable() reports, satisfies answers true for every range,
// compareVersions falls back to a string compare, and valid to
// isExactVersion.
export function semverAvailable(): boolean
// Prereleases included; a range npm cannot parse matches everything.
export function satisfies(version: string, range: string): boolean
export function compareVersions(a: string, b: string): number
export function isExactVersion(version: unknown): version is string
// The version as semver spells it, or null: `v1.2.3` answers `1.2.3`.
export function valid(version: unknown): string | null
