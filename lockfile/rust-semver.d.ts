// Major, minor and patch are u64s; `pre` and `build` are what follow `-` and
// `+`, '' for none.
export interface RustVersion {
  major: bigint
  minor: bigint
  patch: bigint
  pre: string
  build: string
}

// `*` is a wildcard in the minor or patch with no operator; `^` is no
// operator at all. Minor and patch are undefined where not written, and a
// prerelease is written only after a patch.
export interface RustComparator {
  op: '=' | '>' | '>=' | '<' | '<=' | '~' | '^' | '*'
  major: bigint
  minor: bigint | undefined
  patch: bigint | undefined
  pre: string
}

// Undefined where the crate's parse errs; a TypeError for anything but a
// string.
export function parseVersion(text: string): RustVersion | undefined

// Comparators a comma apart, at most 32; `*`, `x` or `X` alone is none.
export function parseVersionReq(text: string): RustComparator[] | undefined

// Whether the version satisfies every comparator, a prerelease only where
// one names its major, minor and patch with a prerelease of its own. A
// TypeError for a version or comparator the parsers would not make.
export function matches(comparators: readonly RustComparator[], version: RustVersion): boolean
