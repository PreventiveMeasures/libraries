// composer.lock exactly as Composer writes it: PHP's json_encode, pretty,
// with slashes and Unicode left unescaped, in the indentation of the file
// it rewrites, which Composer 2.6 and later keep and older ones write as
// four spaces, and a line end after the last `}`; with CRLF throughout,
// as git may check one out. JSON.parse takes more, and reads it otherwise:
// a key given twice as the last, where PHP keeps the first's place; `{}`
// and an object of keys 0 to n, which PHP writes back as `[]` and as a
// list; a number past what PHP holds as it is.

import { LockfileError, quote } from '../error.js'

// PHP's json_decode reads no deeper, nor json_encode writes.
const DEPTH = 512

// The line end after the opening brace and the indentation of the line
// after, as Composer's JsonFile::detectIndenting finds them.
const FORMAT = /^\{(\r?\n)([\t ]+)"/u

// Each object's keys in the file's order, which a record does not keep for
// a key that reads as an integer.
const ORDER = new WeakMap()

export const keysOf = (record) => ORDER.get(record) ?? Object.keys(record)

// The objects PHP decodes to an empty array, which Composer writes as `{}`
// only where it says so.
const EMPTY = new WeakSet()

export const isEmptyObject = (value) => EMPTY.has(value)

const lineOf = (text, pos) => {
  let line = 1
  for (let at = text.indexOf('\n'); at !== -1 && at < pos; at = text.indexOf('\n', at + 1)) line++
  return line
}

const fail = (src, detail, pos = src.pos) => new LockfileError(`${detail} at line ${lineOf(src.text, pos)}`)

function found(src) {
  const { text, pos } = src
  if (pos >= text.length) return 'the end of the file'
  if (text[pos] === '\n' || text.startsWith('\r\n', pos)) return `a${text[pos] === '\n' ? 'n LF' : ' CRLF'} line end`
  const end = text.indexOf('\n', pos)
  return quote(text.slice(pos, end === -1 ? text.length : text[end - 1] === '\r' ? end - 1 : end))
}

function expect(src, literal, what) {
  if (!src.text.startsWith(literal, src.pos)) throw fail(src, `expected ${what}, as Composer writes it, found ${found(src)}`)
  src.pos += literal.length
}

// A line end and the indentation of `depth`, or, of `depth` 0, the line
// end after the last `}`.
function newline(src, depth) {
  const what = depth === 0 ? 'a line end' : `a line end and ${depth === 1 ? '' : `${depth} times `}${quote(src.indent)} of indentation`
  expect(src, `${src.eol}${src.indent.repeat(depth)}`, what)
}

// A string as json_encode writes it, which JSON.stringify does too but for
// U+2028 and U+2029, which PHP escapes.
export const phpString = (value) => JSON.stringify(value).replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029')

function readString(src) {
  const { text, pos } = src
  if (text[pos] !== '"') throw fail(src, `expected a string, found ${found(src)}`)
  let end = pos + 1
  while (end < text.length && text[end] !== '"' && text[end] !== '\n') end += text[end] === '\\' ? 2 : 1
  if (text[end] !== '"') throw fail(src, 'a string with no closing quote')
  const raw = text.slice(pos, end + 1)
  let value
  try {
    value = JSON.parse(raw)
  } catch {
    throw fail(src, `${quote(raw)} is not a string as JSON writes it`)
  }
  if (!value.isWellFormed()) throw fail(src, `${quote(raw)} escapes a lone surrogate, which PHP does not read`)
  if (phpString(value) !== raw) throw fail(src, `${quote(raw)} is not written as Composer writes it, ${quote(phpString(value))}`)
  src.pos = end + 1
  return value
}

const INT64 = 2n ** 63n

// A double as json_encode writes it: the shortest digits that read back
// the same, as php_gcvt lays them out at a precision of 17, and no `.0`
// for a whole one.
export function phpFloat(value) {
  if (value === 0) return Object.is(value, -0) ? '-0' : '0'
  const sign = value < 0 ? '-' : ''
  const [mantissa, exponent] = Math.abs(value).toExponential().split('e')
  const digits = mantissa.replace('.', '')
  const point = Number(exponent) + 1
  if (point < -3 || point > 17) return `${sign}${digits[0]}.${digits.slice(1) || '0'}e${point > 0 ? '+' : '-'}${Math.abs(point - 1)}`
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`
  if (digits.length <= point) return `${sign}${digits}${'0'.repeat(point - digits.length)}`
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`
}

const NUMBER = /-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/uy

// PHP reads an integer as one where it fits in 64 bits, and as a double
// past that; either is written back in one way alone. One past what a
// number holds exactly is refused, where it would not read the same here.
function readNumber(src) {
  NUMBER.lastIndex = src.pos
  const match = NUMBER.exec(src.text)
  if (match === null) throw fail(src, `expected a value, found ${found(src)}`)
  const [raw, fraction, exponent] = match
  const integer = fraction === undefined && exponent === undefined && BigInt(raw) < INT64 && BigInt(raw) >= -INT64
  const value = Number(raw)
  if (!Number.isFinite(value)) throw fail(src, `${raw} is past what PHP reads as a number`)
  const written = integer ? BigInt(raw).toString() : phpFloat(value)
  if (written !== raw) throw fail(src, `${raw} is not written as Composer writes it, ${written}`)
  if (integer && !Number.isSafeInteger(value)) throw fail(src, `${raw} is past what a JavaScript number holds exactly`)
  src.pos += raw.length
  return value
}

const LITERALS = [['true', true], ['false', false], ['null', null]]

function readValue(src, depth) {
  const char = src.text[src.pos]
  if (char === '{') return readObject(src, depth)
  if (char === '[') return readArray(src, depth)
  if (char === '"') return readString(src)
  for (const [literal, value] of LITERALS) {
    if (src.text.startsWith(literal, src.pos)) {
      src.pos += literal.length
      return value
    }
  }
  return readNumber(src)
}

function open(src, depth) {
  if (depth === DEPTH) throw fail(src, `nested more than ${DEPTH} deep, which PHP does not read`)
  src.pos++
}

// PHP writes an array of the keys 0 to n, in order, as a list, and an empty
// one as `[]`: a file Composer writes has neither as an object, but for an
// empty one at the top, where Composer 2.8 and later write `{}` of three.
function readObject(src, depth) {
  const start = src.pos
  open(src, depth)
  const record = Object.create(null)
  const keys = []
  if (src.text[src.pos] === '}') {
    if (depth !== 1) throw fail(src, 'an empty object, which Composer writes as "[]"', start)
    src.pos++
    EMPTY.add(record)
    return record
  }
  const lines = new Map()
  for (let more = true; more;) {
    newline(src, depth + 1)
    const line = src.pos
    const key = readString(src)
    if (lines.has(key)) throw fail(src, `${quote(key)} is a key at line ${lineOf(src.text, lines.get(key))} too`, line)
    lines.set(key, line)
    expect(src, ': ', `": " after ${quote(key)}`)
    record[key] = readValue(src, depth + 1)
    keys.push(key)
    more = src.text[src.pos] === ','
    if (more) src.pos++
  }
  newline(src, depth)
  expect(src, '}', '"}"')
  if (keys.every((key, index) => key === String(index))) throw fail(src, `an object of the keys 0 to ${keys.length - 1}, which Composer writes as a list`, start)
  ORDER.set(record, keys)
  return record
}

function readArray(src, depth) {
  open(src, depth)
  const items = []
  if (src.text[src.pos] === ']') {
    src.pos++
    return items
  }
  for (let more = true; more;) {
    newline(src, depth + 1)
    items.push(readValue(src, depth + 1))
    more = src.text[src.pos] === ','
    if (more) src.pos++
  }
  newline(src, depth)
  expect(src, ']', '"]"')
  return items
}

// Composer reads a file whose two sides of a merge conflict differ in
// content-hash alone, and takes neither's.
const CONFLICT = /^<<<<<<< /mu

export function readJson(text) {
  const conflict = CONFLICT.exec(text)
  if (conflict !== null) throw new LockfileError(`a merge conflict at line ${lineOf(text, conflict.index)}, which Composer reads as a lockfile of no content-hash where its sides differ in that alone`)
  const format = FORMAT.exec(text)
  if (format === null) throw new LockfileError('expected "{" alone on the first line and an indented key on the next, as Composer writes the file at line 1')
  const [, eol, indent] = format
  const src = { text, pos: 0, eol, indent }
  const value = readObject(src, 0)
  newline(src, 0)
  if (src.pos !== text.length) throw fail(src, `expected the end of the file after the last "}", found ${found(src)}`)
  return value
}

// composer.json as json_decode reads it, written as anyone may: of each
// key given twice the last, in the first's place, and every object and
// array an array of PHP's, a Map here by its keys as strings, an array's
// "0" to n; an integer a bigint where 64 bits hold it, any other number a
// double.
const SPACE = /[ \t\n\r]*/uy

function skip(src) {
  SPACE.lastIndex = src.pos
  src.pos += SPACE.exec(src.text)[0].length
}

const syntax = (src, detail) => new LockfileError(`not JSON as PHP reads it: ${detail} at line ${lineOf(src.text, src.pos)}`, src.where)

function decodeString(src) {
  const { text, pos } = src
  let end = pos + 1
  while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1
  if (end >= text.length) throw syntax(src, 'a string with no closing quote')
  let value
  try {
    value = JSON.parse(text.slice(pos, end + 1))
  } catch {
    throw syntax(src, `${quote(text.slice(pos, end + 1))} is not a string`)
  }
  if (!value.isWellFormed()) throw syntax(src, 'a lone surrogate, which is not UTF-8')
  src.pos = end + 1
  return value
}

function decodeValue(src, depth) {
  skip(src)
  const char = src.text[src.pos]
  if (char === '{' || char === '[') {
    if (depth === DEPTH) throw syntax(src, `nested more than ${DEPTH} deep`)
    const close = char === '{' ? '}' : ']'
    const array = new Map()
    src.pos++
    skip(src)
    if (src.text[src.pos] === close) {
      src.pos++
      return array
    }
    for (;;) {
      let key = String(array.size)
      if (close === '}') {
        skip(src)
        if (src.text[src.pos] !== '"') throw syntax(src, `expected a key, found ${found(src)}`)
        key = decodeString(src)
        skip(src)
        if (src.text[src.pos] !== ':') throw syntax(src, `expected ":", found ${found(src)}`)
        src.pos++
      }
      array.set(key, decodeValue(src, depth + 1))
      skip(src)
      const next = src.text[src.pos++]
      if (next === close) return array
      if (next !== ',') {
        src.pos--
        throw syntax(src, `expected "," or ${quote(close)}, found ${found(src)}`)
      }
    }
  }
  if (char === '"') return decodeString(src)
  for (const [literal, value] of LITERALS) {
    if (src.text.startsWith(literal, src.pos)) {
      src.pos += literal.length
      return value
    }
  }
  NUMBER.lastIndex = src.pos
  const match = NUMBER.exec(src.text)
  if (match === null) throw syntax(src, `expected a value, found ${found(src)}`)
  src.pos += match[0].length
  const [raw, fraction, exponent] = match
  if (fraction === undefined && exponent === undefined && BigInt(raw) < INT64 && BigInt(raw) >= -INT64) return BigInt(raw)
  return Number(raw)
}

export function decodeJson(text, where) {
  const src = { text, pos: 0, where, eol: '\n' }
  const value = decodeValue(src, 0)
  skip(src)
  if (src.pos !== text.length) throw syntax(src, `expected the end of the file, found ${found(src)}`)
  return value
}

// Each UTF-16 code unit past ASCII as a \u escape, as PHP writes them.
const unicode = (unit) => `\\u${unit.toString(16).padStart(4, '0')}`

function escapeUnicode(text) {
  let out = ''
  for (const char of text) {
    const code = char.codePointAt(0)
    if (code < 0x80) out += char
    else if (code < 0x1_00_00) out += unicode(code)
    else out += unicode(0xD8_00 + ((code - 0x1_00_00) >> 10)) + unicode(0xDC_00 + ((code - 0x1_00_00) & 0x3_FF))
  }
  return out
}

// json_encode with no flags, of what decodeJson reads: `/` escaped, and
// anything past ASCII as \u escapes of UTF-16; an array of the keys 0 to
// n as a list, and any other as an object.
export function encodeJson(value) {
  if (value === null || typeof value === 'boolean') return String(value)
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number') return phpFloat(value)
  if (typeof value === 'string') return escapeUnicode(JSON.stringify(value).replaceAll('/', '\\/'))
  const keys = [...value.keys()]
  if (keys.every((key, index) => key === String(index))) return `[${[...value.values()].map(encodeJson).join(',')}]`
  return `{${keys.map((key) => `${encodeJson(key)}:${encodeJson(value.get(key))}`).join(',')}}`
}
