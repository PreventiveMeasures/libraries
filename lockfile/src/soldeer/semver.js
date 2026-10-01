// The Rust semver crate, 1.0, as Soldeer matches a registry version to the
// version its config asks for. Numbers are u64, read as bigints.

const MAX = 2n ** 64n - 1n

// Digits, with no leading zero; undefined for none, null past u64.
function numeric(text) {
  const digits = /^\d*/u.exec(text)[0]
  if (digits === '' || (digits.length > 1 && digits.startsWith('0'))) return undefined
  const value = BigInt(digits)
  return value > MAX ? null : [value, text.slice(digits.length)]
}

// Dot-separated [0-9A-Za-z-] segments: none at all, or none of them empty;
// a prerelease's numeric one with no leading zero.
function identifier(text, pre) {
  const found = /^[\dA-Za-z-]*(?:\.[\dA-Za-z-]*)*/u.exec(text)[0]
  if (found === '') return ['', text]
  const segments = found.split('.')
  if (segments.includes('')) return undefined
  if (pre && segments.some((segment) => /^0\d+$/u.test(segment))) return undefined
  return [found, text.slice(found.length)]
}

const wildcard = (text) => /^[*xX]/u.test(text)
const trim = (text) => text.replace(/^ +/u, '')

// Major.minor.patch, a prerelease and build metadata after; or undefined.
export function parseVersion(text) {
  const parts = []
  let rest = text
  for (const [index, after] of [[0, '.'], [1, '.'], [2, '']]) {
    const read = numeric(rest)
    if (!read) return undefined
    parts[index] = read[0]
    rest = read[1]
    if (after !== '') {
      if (!rest.startsWith(after)) return undefined
      rest = rest.slice(1)
    }
  }
  let pre = ''
  for (const [mark, isPre] of [['-', true], ['+', false]]) {
    if (!rest.startsWith(mark)) continue
    const read = identifier(rest.slice(1), isPre)
    if (!read || read[0] === '') return undefined
    if (isPre) pre = read[0]
    rest = read[1]
  }
  return rest === '' ? { major: parts[0], minor: parts[1], patch: parts[2], pre } : undefined
}

const OPS = ['>=', '<=', '=', '>', '<', '~', '^']

function comparator(text) {
  const op = OPS.find((item) => text.startsWith(item))
  let rest = trim(text.slice(op?.length ?? 0))
  const cmp = { op: op ?? '^', major: undefined, minor: undefined, patch: undefined, pre: '' }
  const read = numeric(rest)
  if (!read) return undefined
  ;[cmp.major, rest] = read
  let starred = false
  for (const part of ['minor', 'patch']) {
    if (!rest.startsWith('.')) break
    rest = rest.slice(1)
    if (wildcard(rest)) {
      starred = true
      if (op === undefined) cmp.op = '*'
      rest = rest.slice(1)
      continue
    }
    if (starred) return undefined
    const next = numeric(rest)
    if (!next) return undefined
    ;[cmp[part], rest] = next
  }
  for (const [mark, isPre] of [['-', true], ['+', false]]) {
    if (cmp.patch === undefined || !rest.startsWith(mark)) continue
    const next = identifier(rest.slice(1), isPre)
    if (!next || next[0] === '') return undefined
    if (isPre) cmp.pre = next[0]
    rest = next[1]
  }
  return [cmp, trim(rest)]
}

// Comparators a comma apart, at most 32; a lone wildcard is none at all.
export function parseRequirement(text) {
  let rest = trim(text)
  if (wildcard(rest)) return trim(rest.slice(1)) === '' ? [] : undefined
  const comparators = []
  for (;;) {
    const read = comparator(rest)
    if (!read) return undefined
    comparators.push(read[0])
    rest = read[1]
    if (rest === '') return comparators
    if (!rest.startsWith(',') || comparators.length === 32) return undefined
    rest = trim(rest.slice(1))
  }
}

const sign = (a, b) => (a === b ? 0 : a < b ? -1 : 1)

// Prerelease precedence; none at all is a release, above any prerelease.
function comparePre(a, b) {
  if (a === b) return 0
  if (a === '') return 1
  if (b === '') return -1
  const left = a.split('.')
  const right = b.split('.')
  for (const [index, x] of left.entries()) {
    const y = right[index]
    if (y === undefined) return 1
    const [dx, dy] = [/^\d+$/u.test(x), /^\d+$/u.test(y)]
    const order = dx && dy ? sign(x.length, y.length) || sign(x, y) : dx ? -1 : dy ? 1 : sign(x, y)
    if (order !== 0) return order
  }
  return left.length === right.length ? 0 : -1
}

const exact = (cmp, ver) => ver.major === cmp.major && (cmp.minor === undefined || ver.minor === cmp.minor) && (cmp.patch === undefined || ver.patch === cmp.patch) && ver.pre === cmp.pre

// `<` as -1, `>` as 1: past what the comparator names, by its precedence.
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

const MATCH = {
  '=': exact,
  '*': exact,
  '>': (cmp, ver) => beyond(cmp, ver, 1),
  '>=': (cmp, ver) => exact(cmp, ver) || beyond(cmp, ver, 1),
  '<': (cmp, ver) => beyond(cmp, ver, -1),
  '<=': (cmp, ver) => exact(cmp, ver) || beyond(cmp, ver, -1),
  '~': tilde,
  '^': caret,
}

// A prerelease matches only where a comparator names its very version.
export function matches(comparators, ver) {
  if (!comparators.every((cmp) => MATCH[cmp.op](cmp, ver))) return false
  return ver.pre === '' || comparators.some((cmp) => cmp.major === ver.major && cmp.minor === ver.minor && cmp.patch === ver.patch && cmp.pre !== '')
}

// Soldeer's parse_version_req: a comparator with no operator is exact, where
// the comparators can be told apart by their commas.
export function soldeerRequirement(text) {
  const comparators = parseRequirement(text)
  if (comparators === undefined || comparators.length === 0) return comparators
  const written = text.split(',')
  if (written.length !== comparators.length) return comparators
  return comparators.map((cmp, index) => (cmp.op === '^' && !trim(written[index]).startsWith('^') ? { ...cmp, op: '=' } : cmp))
}
