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
// npm's semver itself, as it is, for what the calls above leave out; it
// throws where there is no npm beside node to borrow it from. Typed for
// what is read of it here; it has more.
export function npmSemver(): NpmSemver

export interface NpmSemver {
  valid(version: string, loose?: boolean): string | null
  clean(version: string, loose?: boolean): string | null
  validRange(range: string, loose?: boolean): string | null
  satisfies(version: string, range: string, loose?: boolean): boolean
  gt(a: string, b: string, loose?: boolean): boolean
  major(version: string, loose?: boolean): number
  Range: new (range: string, loose?: boolean) => { set: Comparator[][], loose: boolean }
  SemVer: new (version: string, loose?: boolean) => object
  Comparator: new (comparator: string, loose?: boolean) => Comparator
}

interface Comparator {
  operator: string
  value: string
  loose: boolean
  semver: { prerelease: (string | number)[], version: string, inc(release: string, identifier?: string | number): unknown }
  test(version: object): boolean
}
