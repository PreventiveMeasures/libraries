// Gem::Version and Gem::Requirement as RubyGems 3.5 to 4.0 compare them;
// numbers are bigints, as Ruby's to_i reads any size.

// As Bundler writes one in a lockfile, digits first and no `-`, which
// Gem::Version would read as `.pre.`.
export const isVersion = (text) => typeof text === 'string' && /^\d+(?:\.[\dA-Za-z]+)*$/u.test(text)

const isPrerelease = (version) => /[A-Za-z]/u.test(version)

const partition = (version) => (version.match(/\d+|[A-Za-z]+/gu) ?? []).map((part) => (/^\d/u.test(part) ? BigInt(part) : part))

// Each run of `.` and `0` as [start, end), in one pass, as a regex engine
// would retry canonical_segments' regexes from every place in it.
const zeroRuns = (text) => Array.from(text.matchAll(/[.0]+/gu), (m) => [m.index, m.index + m[0].length])
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
  const end = startIn(version, [from, version.length], (char) => char !== undefined && /[A-Za-z.]/u.test(char))
  const text = version.slice(0, end)
  if (!isPrerelease(version)) return partition(text)
  for (const run of zeroRuns(text)) {
    const start = /[A-Za-z]/u.test(text[run[1]] ?? '') ? startIn(text, run, (char) => char === undefined || char === '.') : undefined
    if (start !== undefined) return partition(`${text.slice(0, start)}${text.slice(run[1])}`)
  }
  return partition(text)
}

const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

export function compareVersions(a, b) {
  const [left, right] = [canonical(a), canonical(b)]
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const [lhs, rhs] = [left[i] ?? 0n, right[i] ?? 0n]
    if (lhs === rhs) continue
    if (typeof lhs !== typeof rhs) return typeof lhs === 'string' ? -1 : 1
    return order(lhs, rhs)
  }
  return 0
}

const numeric = (version) => {
  const segments = partition(version)
  const letters = segments.findIndex((segment) => typeof segment === 'string')
  return letters === -1 ? segments : segments.slice(0, letters)
}

// Gem::Version#release and #bump.
const release = (version) => (isPrerelease(version) ? numeric(version).join('.') : version)
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
  '~>': undefined,
}

export const isOperator = (op) => typeof op === 'string' && op in OPERATORS

// Gem::Requirement#satisfied_by? of [op, version] pairs, every one met.
export function satisfiedBy(version, requirements) {
  return requirements.every(([op, against]) => {
    if (op === '~>') return compareVersions(version, against) >= 0 && compareVersions(release(version), bump(against)) < 0
    return OPERATORS[op](compareVersions(version, against))
  })
}

// Gem::Requirement#==: the pairs sorted by Array#to_s, each the same op
// and an equal version; where any is `~>`, those of `~>` the same version
// as written, as #eql? holds them.
const sortKey = ([op, version]) => `[${JSON.stringify(op)}, #<Gem::Version ${JSON.stringify(version)}>]`
const sorted = (requirements) => requirements.toSorted((p, q) => order(sortKey(p), sortKey(q)))
export function sameRequirements(a, b) {
  const [x, y] = [sorted(a), sorted(b)]
  return x.length === y.length && x.every(([op, version], i) => op === y[i][0] && compareVersions(version, y[i][1]) === 0 && (op !== '~>' || version === y[i][1]))
}

// What Gem::Requirement.new makes of none: `>= 0`.
export const DEFAULT = Object.freeze([Object.freeze(['>=', '0'])])
