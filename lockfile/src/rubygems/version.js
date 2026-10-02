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

// Each run of `.` and `0` as [start, end): where canonical_segments' regexes
// can match, found in one pass, as a regex engine retries them from every
// place, which on a long version takes a while.
const zeroRuns = (text) => Array.from(text.matchAll(/[.0]+/gu), (m) => [m.index, m.index + m[0].length])

// The first place in a run that a regex of canonical_segments starts at:
// the first whose character before `follows` takes.
function startIn(text, [from, to], follows) {
  for (let at = from; at < to; at++) if (follows(text[at - 1])) return at
  return undefined
}

// Gem::Version#canonical_segments: the `.` and zeros at the end from the
// first after a letter or a `.`, then, of a prerelease, the first run of
// zeros, at the start or after a `.`, that a letter follows.
function canonical(version) {
  let from = version.length
  while (version[from - 1] === '.' || version[from - 1] === '0') from--
  const end = from < version.length ? startIn(version, [from, version.length], (char) => char !== undefined && /[A-Za-z.]/u.test(char)) : undefined
  const text = version.slice(0, end)
  if (!isPrerelease(version)) return partition(text)
  for (const run of zeroRuns(text)) {
    const start = /[A-Za-z]/u.test(text[run[1]] ?? '') ? startIn(text, run, (char) => char === undefined || char === '.') : undefined
    if (start !== undefined) return partition(`${text.slice(0, start)}${text.slice(run[1])}`)
  }
  return partition(text)
}

// Ruby's String#<=>, by code unit, which for ASCII is by byte.
const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

// Gem::Version#<=> of canonical segments: a missing one is 0, and letters
// come before a number.
function compareSegments(left, right) {
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const [lhs, rhs] = [left[i] ?? 0n, right[i] ?? 0n]
    if (lhs === rhs) continue
    if (typeof lhs !== typeof rhs) return typeof lhs === 'string' ? -1 : 1
    return order(lhs, rhs)
  }
  return 0
}

export const compareVersions = (a, b) => (a === b ? 0 : compareSegments(canonical(a), canonical(b)))

// The segments of a version up to its first letters, from its own, not
// canonical, segments.
function numeric(version) {
  const segments = partition(version)
  const letters = segments.findIndex((segment) => typeof segment === 'string')
  return letters === -1 ? segments : segments.slice(0, letters)
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

// [operator, version], or undefined for what Bundler does not write; or,
// of another version's form, CocoaPods.
export function parseRequirement(text, isValid = isVersion) {
  const match = REQUIREMENT.exec(text)
  return match === null || !isValid(match[2]) ? undefined : [match[1], match[2]]
}

// Gem::Requirement#satisfied_by?, of one requirement: `~>` is at least the
// version, and below the next release of its last segment but one.
export function satisfies(version, [operator, against]) {
  if (operator === '~>') return compareVersions(version, against) >= 0 && compareVersions(release(version), bump(against)) < 0
  return OPERATORS[operator](compareVersions(version, against))
}

// Versions as what every requirement on them is held to: each one's
// canonical segments in order, and the greatest release, so a requirement
// costs a comparison or two however many versions there are.
export function versionSet(versions) {
  const all = versions.map(canonical)
  const releases = versions.map((version, index) => (isPrerelease(version) ? canonical(release(version)) : all[index]))
  return { sorted: all.sort(compareSegments), release: releases.sort(compareSegments).at(-1), keys: undefined }
}

// Whether every version of a set satisfies a requirement: of a range, `=`,
// `<`, `>` and the rest, where the least and the greatest do.
export function satisfiedByAll(set, [operator, against]) {
  const target = canonical(against)
  if (operator === '!=') return !(set.keys ??= new Set(set.sorted.map((segments) => segments.join('.')))).has(target.join('.'))
  const least = compareSegments(set.sorted[0], target)
  if (operator === '~>') return least >= 0 && compareSegments(set.release, canonical(bump(against))) < 0
  return OPERATORS[operator](least) && OPERATORS[operator](compareSegments(set.sorted.at(-1), target))
}
