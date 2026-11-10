// Gem::Version and Gem::Requirement as RubyGems 3.5 has them, ported from
// @preventive/lockfile. Numbers are bigints: Ruby's are unbounded.

// Gem::Version::VERSION_PATTERN: a gem's own version has no `-`, but a
// range may.
const VERSION = String.raw`\d+(?:\.[\dA-Za-z]+)*(?:-[\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*)?`
const SPACE = String.raw`[\t\n\v\f\r ]` // Ruby's \s, ASCII alone.
// Gem::Requirement::PATTERN, operators longest first as Ruby's backtracking
// tries them.
const REQUIREMENT = new RegExp(`^${SPACE}*(?:(>=|<=|!=|~>|=|>|<)${SPACE}*)?(${VERSION})${SPACE}*$`, 'u')
const ANCHORED = new RegExp(`^${VERSION}$`, 'u')

// 256 at most, before any regex runs.
export const isVersion = (text) => typeof text === 'string' && text.length <= 256 && ANCHORED.test(text)

// Gem::Version reads `-` as `.pre.`.
const read = (version) => version.replaceAll('-', '.pre.')

const isPrerelease = (version) => /[A-Za-z]/u.test(version)

// Gem::Version#partition_segments: numbers and runs of letters.
const partition = (version) => (version.match(/\d+|[A-Za-z]+/gu) ?? []).map((part) => (/^\d/u.test(part) ? BigInt(part) : part))

// Runs of `.` and `0` as [start, end), in one pass.
const zeroRuns = (text) => Array.from(text.matchAll(/[.0]+/gu), (m) => [m.index, m.index + m[0].length])

function startIn(text, [from, to], follows) {
  for (let at = from; at < to; at++) if (follows(text[at - 1])) return at
  return undefined
}

// Gem::Version#canonical_segments: trailing zeros dropped, then of a
// prerelease the first run of zeros a letter follows.
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

// Gem::Version#<=>: a missing segment is 0, and letters come before a number.
function compareSegments(left, right) {
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const [lhs, rhs] = [left[i] ?? 0n, right[i] ?? 0n]
    if (lhs === rhs) continue
    if (typeof lhs !== typeof rhs) return typeof lhs === 'string' ? -1 : 1
    return order(lhs, rhs)
  }
  return 0
}

export function compareVersions(a, b) {
  const [left, right] = [read(a), read(b)]
  return left === right ? 0 : compareSegments(canonical(left), canonical(right))
}

// The segments before the first letters, as written, not canonical.
function numeric(version) {
  const segments = partition(version)
  const letters = segments.findIndex((segment) => typeof segment === 'string')
  return letters === -1 ? segments : segments.slice(0, letters)
}

// Gem::Version#release
const release = (version) => (isPrerelease(version) ? numeric(version).join('.') : version)

// Gem::Version#bump: the last segment dropped, the one before raised.
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

// Undefined where a part isn't a requirement, or the range is over 1,024
// characters.
function requirementsOf(text) {
  if (text.length > 1024) return undefined
  const parts = text.split(',').map((part) => REQUIREMENT.exec(part))
  if (parts.some((match) => match === null || match[2].length > 256)) return undefined
  return parts.map(([, operator = '=', against]) => [operator, against])
}

// A test of a range, each version read once. A prerelease meets one as any
// version does: only Gem::Dependency sets them apart.
export function readRange(text) {
  const parts = requirementsOf(text)
  if (parts === undefined) return undefined
  const requirements = parts.map(([operator, against]) => ({ operator, at: canonical(read(against)), below: operator === '~>' ? canonical(bump(read(against))) : undefined }))
  return (version) => {
    const [own, released] = [canonical(read(version)), canonical(release(read(version)))]
    return requirements.every(({ operator, at, below }) => (operator === '~>'
      ? compareSegments(own, at) >= 0 && compareSegments(released, below) < 0
      : OPERATORS[operator](compareSegments(own, at))))
  }
}

// Lower bounds alone end below the one patched version above them; any
// other range is as given.
export function boundRange(range, patched) {
  if (!isVersion(patched)) return range
  if (range.trim() === '') return `< ${patched}`
  const open = requirementsOf(range)?.every(([operator, against]) => operator === '!=' || ((operator === '>=' || operator === '>') && compareVersions(against, patched) < 0))
  return open ? `${range.trim()}, < ${patched}` : range
}
