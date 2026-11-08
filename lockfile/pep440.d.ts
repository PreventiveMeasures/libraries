// A version's parts, each number its digits without leading zeros: `pre`
// is `a`, `b` or `rc` with its number (`rc1`), `local` its parts, lowercased.
export interface Pep440Version {
  epoch: string
  release: string[]
  pre: string | undefined
  post: string | undefined
  dev: string | undefined
  local: string[] | undefined
}

// The parts of a version in any spelling packaging reads (`1.0`, `v1.0`,
// `1.0-alpha.2`, `1.0+Ubuntu-1`), or undefined for any other, any that is
// not ASCII among them, and any with whitespace around it.
export function parseVersion(text: string): Pep440Version | undefined

// The normal form, as str(packaging.version.Version) and uv write it.
export function normalVersion(version: Pep440Version): string

// One key for versions packaging takes as equal: `1.0` and `1.0.0` alike.
export function versionKey(version: Pep440Version): string

// packaging's order of two versions parseVersion reads, negative, zero or
// positive: `1.0.dev0` < `1.0a1` < `1.0rc1` < `1.0` = `1.0.0` <
// `1.0+local` < `1.0.post1`.
export function compareVersions(a: string, b: string): number
