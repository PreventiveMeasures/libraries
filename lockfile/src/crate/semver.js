// The Rust semver crate, 1.0: Version::parse, VersionReq::parse and
// VersionReq::matches. Numbers are u64, read as bigints.

const MAX = 2n ** 64n - 1n

const NUMBER = '0|[1-9]\\d*'
// A prerelease identifier with a letter, or a number with no leading zero.
const IDENTIFIER = `\\d*[A-Za-z-][\\dA-Za-z-]*|${NUMBER}`
const PRE = `(?:${IDENTIFIER})(?:\\.(?:${IDENTIFIER}))*`
const BUILD = '[\\dA-Za-z-]+(?:\\.[\\dA-Za-z-]+)*'
const WILD = '[*Xx]'

const VERSION = new RegExp(`^(${NUMBER})\\.(${NUMBER})\\.(${NUMBER})(?:-(${PRE}))?(?:\\+(${BUILD}))?$`, 'u')
const PRERELEASE = new RegExp(`^(?:${PRE})?$`, 'u')
const METADATA = new RegExp(`^(?:${BUILD})?$`, 'u')
const LONE_WILD = new RegExp(`^ *${WILD} *$`, 'u')
// One comparator, each run of spaces read one way alone, as backtracking
// would otherwise be quadratic; a prerelease comes only after a patch.
const COMPARATOR = new RegExp(`^ *(?:(>=|<=|=|>|<|~|\\^) *)?(${NUMBER})(?:\\.(?:(${WILD})(?:\\.${WILD})?|(${NUMBER})(?:\\.(?:(${WILD})|(${NUMBER})(?:-(${PRE}))?(?:\\+${BUILD})?))?))? *$`, 'u')

// A u64, or null past it, read without a bigint of every digit.
function u64(digits) {
  if (digits === undefined) return undefined
  if (digits.length > 20) return null
  const value = BigInt(digits)
  return value > MAX ? null : value
}

const isU64 = (value) => typeof value === 'bigint' && value >= 0n && value <= MAX

function text(value) {
  if (typeof value !== 'string') throw new TypeError('expected a string')
  return value
}

// { major, minor, patch, pre, build }, or undefined where the crate errs.
export function parseVersion(source) {
  const match = VERSION.exec(text(source))
  if (match === null) return undefined
  const [major, minor, patch] = match.slice(1, 4).map(u64)
  if ([major, minor, patch].includes(null)) return undefined
  return { major, minor, patch, pre: match[4] ?? '', build: match[5] ?? '' }
}

function comparator(source) {
  const match = COMPARATOR.exec(source)
  if (match === null) return undefined
  const [, op, majorText, minorStar, minorText, patchStar, patchText, pre = ''] = match
  const [major, minor, patch] = [majorText, minorText, patchText].map(u64)
  if ([major, minor, patch].includes(null)) return undefined
  return { op: op ?? (minorStar || patchStar ? '*' : '^'), major, minor, patch, pre }
}

const MOST = 32

// Comparators a comma apart, at most 32; a lone wildcard is none at all.
// Undefined where the crate errs.
export function parseVersionReq(source) {
  if (LONE_WILD.test(text(source))) return []
  const written = source.split(',', MOST + 1)
  if (written.length > MOST) return undefined
  const comparators = written.map(comparator)
  return comparators.includes(undefined) ? undefined : comparators
}

const sign = (a, b) => (a === b ? 0 : a < b ? -1 : 1)

// Prerelease precedence; none at all is a release, above any prerelease.
function comparePre(a, b) {
  if (a === b) return 0
  if (a === '') return 1
  if (b === '') return -1
  const [left, right] = [a.split('.'), b.split('.')]
  for (const [index, x] of left.entries()) {
    const y = right[index]
    if (y === undefined) return 1
    // A number below a word; numbers by their length first, as no zero leads.
    const [dx, dy] = [/^\d+$/u.test(x), /^\d+$/u.test(y)]
    if (dx !== dy) return dx ? -1 : 1
    const order = (dx && sign(x.length, y.length)) || sign(x, y)
    if (order !== 0) return order
  }
  return left.length === right.length ? 0 : -1
}

const exact = (cmp, ver) => ver.major === cmp.major && (cmp.minor === undefined || ver.minor === cmp.minor) && (cmp.patch === undefined || ver.patch === cmp.patch) && ver.pre === cmp.pre

// Past what the comparator names, the way `way` says: 1 above, -1 below.
function beyond(cmp, ver, way) {
  for (const part of ['major', 'minor', 'patch']) {
    if (cmp[part] === undefined) return false
    if (ver[part] !== cmp[part]) return sign(ver[part], cmp[part]) === way
  }
  return comparePre(ver.pre, cmp.pre) === way
}

function tilde(cmp, ver) {
  if (ver.major !== cmp.major || (cmp.minor !== undefined && ver.minor !== cmp.minor)) return false
  if (cmp.patch !== undefined && ver.patch !== cmp.patch) return ver.patch > cmp.patch
  return comparePre(ver.pre, cmp.pre) >= 0
}

function caret(cmp, ver) {
  if (ver.major !== cmp.major) return false
  if (cmp.minor === undefined) return true
  if (cmp.patch === undefined) return cmp.major > 0n ? ver.minor >= cmp.minor : ver.minor === cmp.minor
  if (cmp.major > 0n || cmp.minor > 0n) {
    if (ver.minor !== cmp.minor) return cmp.major > 0n && ver.minor > cmp.minor
    if (ver.patch !== cmp.patch) return ver.patch > cmp.patch
  } else if (ver.minor !== cmp.minor || ver.patch !== cmp.patch) {
    return false
  }
  return comparePre(ver.pre, cmp.pre) >= 0
}

const MATCH = new Map([
  ['=', exact],
  ['*', exact],
  ['>', (cmp, ver) => beyond(cmp, ver, 1)],
  ['>=', (cmp, ver) => exact(cmp, ver) || beyond(cmp, ver, 1)],
  ['<', (cmp, ver) => beyond(cmp, ver, -1)],
  ['<=', (cmp, ver) => exact(cmp, ver) || beyond(cmp, ver, -1)],
  ['~', tilde],
  ['^', caret],
])

// Copies of what the parsers make, each field read once, so that what is
// matched is what was checked; undefined for anything else.
function versionOf(value) {
  const { major, minor, patch, pre, build } = value ?? {}
  const valid = isU64(major) && isU64(minor) && isU64(patch) && typeof pre === 'string' && PRERELEASE.test(pre) && typeof build === 'string' && METADATA.test(build)
  return valid ? { major, minor, patch, pre, build } : undefined
}

// A patch only after a minor and with no wildcard, a prerelease only after it.
function comparatorOf(value) {
  const { op, major, minor, patch, pre } = value ?? {}
  const valid = MATCH.has(op) && isU64(major) && (minor === undefined || isU64(minor)) && (patch === undefined || (minor !== undefined && op !== '*' && isU64(patch))) && typeof pre === 'string' && PRERELEASE.test(pre) && (pre === '' || patch !== undefined)
  return valid ? { op, major, minor, patch, pre } : undefined
}

// Every slot, a hole too, by its index.
function comparatorsOf(value) {
  if (!Array.isArray(value)) return undefined
  const { length } = value
  if (length > MOST) return undefined
  const list = Array.from({ length }, (_, index) => comparatorOf(value[index]))
  return list.includes(undefined) ? undefined : list
}

// A prerelease matches only where a comparator names its very version.
export function matches(comparators, version) {
  const list = comparatorsOf(comparators)
  if (list === undefined) throw new TypeError('expected comparators, as parseVersionReq makes')
  const ver = versionOf(version)
  if (ver === undefined) throw new TypeError('expected a version, as parseVersion makes')
  if (!list.every((cmp) => MATCH.get(cmp.op)(cmp, ver))) return false
  return ver.pre === '' || list.some((cmp) => cmp.major === ver.major && cmp.minor === ver.minor && cmp.patch === ver.patch && cmp.pre !== '')
}
