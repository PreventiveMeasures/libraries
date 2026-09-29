// Hand-written against semver.js; a change to either belongs with the other.

// npm's own semver, borrowed from the npm beside node and passed through
// as it is. Without it, every call throws, except valid() on a plain
// MAJOR.MINOR.PATCH with no options.
export function satisfies(version: string, range: string, options?: { includePrerelease?: boolean; loose?: boolean }): boolean
export function compareVersions(a: string, b: string): -1 | 0 | 1
// The version as semver spells it, or null: `v1.2.3` answers `1.2.3`.
export function valid(version: unknown, options?: { loose?: boolean }): string | null
// A string that valid() answers unchanged.
export function isExactVersion(version: unknown): version is string
// The range as semver normalizes it, or null where it is not one.
export function validRange(range: unknown, options?: { loose?: boolean; includePrerelease?: boolean }): string | null
// Whether some version is in both ranges; throws for one that is not a range.
export function intersects(a: string, b: string, options?: { loose?: boolean; includePrerelease?: boolean }): boolean
