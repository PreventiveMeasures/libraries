// A version's parts; `pre` is `a`, `b` or `rc` with its number (`rc1`).
export interface Pep440Version {
  epoch: string
  release: string[]
  pre: string | undefined
  post: string | undefined
  dev: string | undefined
  local: string[] | undefined
}

// Undefined for what packaging doesn't read, non-ASCII or padded text among it.
export function parseVersion(text: string): Pep440Version | undefined

// The normal form, as packaging and uv write it.
export function normalVersion(version: Pep440Version): string

// One key for versions packaging takes as equal: `1.0` and `1.0.0` alike.
export function versionKey(version: Pep440Version): string

// packaging's order of two versions parseVersion reads.
export function compareVersions(a: string, b: string): number
