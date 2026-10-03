// What Composer takes from PHP itself, ported for the strings it is given:
// trim, strtolower, empty, version_compare, and how sort and ksort order
// strings and keys. PHP's strings are bytes, and these work on ASCII
// alone, as PHP 8 does: no other character is a space, a digit or a
// letter to them, which holds of a string of UTF-16 code units alike.

import { compareCodePoints } from '../order.js'

// trim(): of " \t\n\r\0\v", and not "\f".
export const trim = (text) => text.replace(/^[ \t\n\r\0\v]+|[ \t\n\r\0\v]+$/gu, '')

// strtolower(), which lowers ASCII alone.
export const lower = (text) => text.replace(/[A-Z]+/gu, (letters) => letters.toLowerCase())

// empty() of a string, or of a group a regex left unmatched: "0" too.
export const empty = (value) => value === undefined || value === '' || value === '0'

const isDigit = (char) => char !== undefined && char >= '0' && char <= '9'
const isAlnum = (char) => isDigit(char) || /^[A-Za-z]$/u.test(char ?? '')

// version_compare's canonical form: `-`, `_` and `+` as `.`, a `.` between
// a run of digits and one of anything else, and any other character that is
// not a letter or a digit as a `.`, none twice. The first is left as it is,
// and a `.` at the end dropped, as PHP 8.4 and later drop it: before, it
// was an empty part, which no version Composer compares ends in.
function canonical(version) {
  let out = version[0]
  for (let i = 1; i < version.length; i++) {
    const char = version[i]
    const last = version[i - 1]
    const dot = out.at(-1) === '.' ? '' : '.'
    if (char === '-' || char === '_' || char === '+') out += dot
    else if ((!isDigit(last) && last !== '.' && isDigit(char)) || (isDigit(last) && !isDigit(char) && char !== '.')) out += `${dot}${char}`
    else if (isAlnum(char)) out += char
    else out += dot
  }
  return out.endsWith('.') ? out.slice(0, -1) : out
}

// The forms version_compare knows a word by, by what it starts with.
const FORMS = [['dev', 0], ['alpha', 1], ['a', 1], ['beta', 2], ['b', 2], ['RC', 3], ['rc', 3], ['#', 4], ['pl', 5], ['p', 5]]

const formOf = (word) => FORMS.find(([name]) => word.startsWith(name))?.[1] ?? -1

const sign = (difference) => (difference > 0 ? 1 : difference < 0 ? -1 : 0)

// PHP_INT_MAX, and whether a PHP integer holds a value.
export const LONG_MAX = 2n ** 63n - 1n
export const fitsLong = (value) => value <= LONG_MAX && value >= -LONG_MAX - 1n

// strtol, of a part that starts with a digit: as far as the digits go, and
// no further than PHP_INT_MAX.
const strtol = (part) => {
  const value = BigInt(/^\d+/u.exec(part)[0])
  return value > LONG_MAX ? LONG_MAX : value
}

function comparePart(left, right) {
  if (isDigit(left[0]) && isDigit(right[0])) return sign(Number(strtol(left) - strtol(right)))
  if (!isDigit(left[0]) && !isDigit(right[0])) return sign(formOf(left) - formOf(right))
  return isDigit(left[0]) ? sign(formOf('#N#') - formOf(right)) : sign(formOf(left) - formOf('#N#'))
}

const encoder = new TextEncoder()

// A string as PHP has it, of bytes: each of its UTF-8 as a code unit, none
// of which past ASCII is a digit, a letter or a separator.
const bytesOf = (text) => /^[\0-\u007F]*$/u.test(text) ? text : String.fromCodePoint(...encoder.encode(text))

// php_version_compare, of two strings of bytes: -1, 0 or 1.
function compareBytesAsVersions(version1, version2) {
  if (version1 === '' || version2 === '') return version1 === version2 ? 0 : version1 === '' ? -1 : 1
  const left = version1[0] === '#' ? version1 : canonical(version1)
  const right = version2[0] === '#' ? version2 : canonical(version2)
  let [p1, p2, n1, n2, compare] = [0, 0, 0, 0, 0]
  while (p1 < left.length && p2 < right.length && n1 !== -1 && n2 !== -1) {
    n1 = left.indexOf('.', p1)
    n2 = right.indexOf('.', p2)
    compare = comparePart(left.slice(p1, n1 === -1 ? undefined : n1), right.slice(p2, n2 === -1 ? undefined : n2))
    if (compare !== 0) break
    if (n1 !== -1) p1 = n1 + 1
    if (n2 !== -1) p2 = n2 + 1
  }
  if (compare !== 0) return compare
  if (n1 !== -1) return isDigit(left[p1]) ? 1 : compareBytesAsVersions(left.slice(p1), '#N#')
  if (n2 !== -1) return isDigit(right[p2]) ? -1 : compareBytesAsVersions('#N#', right.slice(p2))
  return 0
}

export const compareVersions = (version1, version2) => compareBytesAsVersions(bytesOf(version1), bytesOf(version2))

const OPERATORS = {
  '==': (c) => c === 0,
  '!=': (c) => c !== 0,
  '<': (c) => c < 0,
  '<=': (c) => c <= 0,
  '>': (c) => c > 0,
  '>=': (c) => c >= 0,
}

// version_compare with an operator, of the ones Composer's constraints use.
export const versionCompare = (version1, version2, operator) => OPERATORS[operator](compareVersions(version1, version2))

// Strings in byte order, which is UTF-8's, which is code points'; a prefix
// first: -1, 0 or 1.
export const compareBytes = (left, right) => sign(compareCodePoints(left, right))

// What is_numeric_string takes: spaces about, a sign, digits with a point
// or an exponent, and of those, which are integers a long holds and which
// run past one, and to which side.
const NUMERIC = /^[ \t\n\r\v\f]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[ \t\n\r\v\f]*$/u

function numeric(text) {
  if (!NUMERIC.test(text)) return undefined
  const trimmed = text.trim()
  if (!/[.eE]/u.test(trimmed)) {
    const value = BigInt(trimmed)
    if (fitsLong(value)) return { long: value }
    return { double: Number(trimmed), overflow: value > 0n ? 1 : -1 }
  }
  return { double: Number(trimmed), overflow: 0 }
}

// zendi_smart_strcmp, which sort and ksort order two strings by: as numbers
// where both read as one, in byte order where either does not.
export function compareStrings(left, right) {
  const a = numeric(left)
  const b = numeric(right)
  if (a === undefined || b === undefined) return compareBytes(left, right)
  if (a.overflow !== undefined && a.overflow !== 0 && a.overflow === b.overflow && a.double - b.double === 0) return compareBytes(left, right)
  if (a.double !== undefined || b.double !== undefined) {
    if (a.double === undefined) {
      if (b.overflow !== 0) return -b.overflow
      return sign(Number(a.long) - b.double)
    }
    if (b.double === undefined) {
      if (a.overflow !== 0) return a.overflow
      return sign(a.double - Number(b.long))
    }
    if (a.double === b.double && !Number.isFinite(a.double)) return compareBytes(left, right)
    return sign(a.double - b.double)
  }
  return sign(Number(a.long - b.long))
}

// A key of a PHP array: an integer where the string is one as PHP writes
// it, of 64 bits, and the string itself where not.
const INTEGER = /^(?:0|-?[1-9]\d*)$/u
function keyOf(text) {
  if (!INTEGER.test(text)) return text
  const value = BigInt(text)
  return fitsLong(value) ? value : text
}

// How ksort orders two keys, SORT_REGULAR: integers as numbers, strings as
// compareStrings does, and an integer with a string as numbers where the
// string reads as one, else as its digits.
export function compareKeys(left, right) {
  const a = keyOf(left)
  const b = keyOf(right)
  if (typeof a === 'bigint' && typeof b === 'bigint') return a > b ? 1 : -1
  if (typeof a === 'string' && typeof b === 'string') return compareStrings(a, b)
  const [long, text, flip] = typeof a === 'bigint' ? [a, b, 1] : [b, a, -1]
  const number = numeric(text)
  if (number?.long !== undefined) return flip * sign(Number(long - number.long))
  if (number?.double !== undefined) return flip * sign(Number(long) - number.double)
  return flip * compareBytes(String(long), text)
}
