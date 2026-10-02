// RubyGems' Gem::Version and Gem::Requirement, as RubyGems 3.5 reads and
// compares them: a version as Bundler writes one, which versions are equal
// and which come first, and whether a version meets a requirement. Numbers
// are bigints, as Ruby's to_i reads a number of any size.

// Gem::Version::VERSION_PATTERN, less the `-` part: RubyGems writes `-` as
// `.pre.`, and Bundler reads a `-` in a lockfile's version as the start of
// a platform.
const VERSION = /^\d+(?:\.[\dA-Za-z]+)*$/u

export const isVersion = (text) => VERSION.test(text)

const isPrerelease = (version) => /[A-Za-z]/u.test(version)

// Gem::Version#partition_segments: numbers and runs of letters.
const partition = (version) => (version.match(/\d+|[A-Za-z]+/gu) ?? []).map((part) => (/^\d/u.test(part) ? BigInt(part) : part))

// Gem::Version#canonical_segments: trailing zeros dropped, and of a
// prerelease, the zeros before its letters.
function canonical(version) {
  let text = version.replace(/(?<=[A-Za-z.])[.0]+$/u, '')
  if (isPrerelease(version)) text = text.replace(/(?<=\.|^)[0.]+(?=[A-Za-z])/u, '')
  return partition(text)
}

// Ruby's String#<=>, by code unit, which for ASCII is by byte.
const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

// Gem::Version#<=>: a missing segment is 0, and letters come before a number.
export function compareVersions(a, b) {
  if (a === b) return 0
  const [left, right] = [canonical(a), canonical(b)]
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const [lhs, rhs] = [left[i] ?? 0n, right[i] ?? 0n]
    if (lhs === rhs) continue
    if (typeof lhs !== typeof rhs) return typeof lhs === 'string' ? -1 : 1
    return order(lhs, rhs)
  }
  return 0
}

// The segments of a version up to its first letters, from its own, not
// canonical, segments.
function numeric(version) {
  const segments = partition(version)
  while (segments.some((segment) => typeof segment === 'string')) segments.pop()
  return segments
}

// Gem::Version#release: a prerelease without its letters and what follows.
const release = (version) => (isPrerelease(version) ? numeric(version).join('.') : version)

// Gem::Version#bump: the release, its last segment dropped, and the one
// before it raised by one.
function bump(version) {
  const segments = numeric(version)
  if (segments.length > 1) segments.pop()
  segments[segments.length - 1] += 1n
  return segments.join('.')
}

const OPERATORS = {
  __proto__: null,
  '=': (cmp) => cmp === 0,
  '!=': (cmp) => cmp !== 0,
  '>': (cmp) => cmp > 0,
  '<': (cmp) => cmp < 0,
  '>=': (cmp) => cmp >= 0,
  '<=': (cmp) => cmp <= 0,
}

// One requirement, `op version`, as Bundler writes it: an operator always,
// and one space.
const REQUIREMENT = /^(=|!=|>|<|>=|<=|~>) (\S+)$/u

// [operator, version], or undefined for what Bundler does not write.
export function parseRequirement(text) {
  const match = REQUIREMENT.exec(text)
  return match === null || !isVersion(match[2]) ? undefined : [match[1], match[2]]
}

// Gem::Requirement#satisfied_by?, of one requirement: `~>` is at least the
// version, and below the next release of its last segment but one.
export function satisfies(version, [operator, against]) {
  if (operator === '~>') return compareVersions(version, against) >= 0 && compareVersions(release(version), bump(against)) < 0
  return OPERATORS[operator](compareVersions(version, against))
}
