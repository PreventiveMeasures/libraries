// The pieces of a TOML line: whitespace, comments, keys and values. `src` is
// { text, pos, line, fixed }: the text, where the reader is in it, the line
// it is on (from zero), and the containers no later line may add to, which
// are every array and table read here, as a value or within one. An inline
// table's keys are set here too; where a line's key goes is parse.js's.
//
// Read here: basic and literal strings on one line, decimal integers with
// or without underscores, booleans, offset date-times, arrays (across lines,
// with comments and a trailing comma) and inline tables (on one line, as
// TOML 1.0 has them). Refused, each by name: multi-line strings, floats,
// infinities and NaN, hexadecimal, octal and binary integers, local dates
// and times, and TOML 1.1's escapes and multi-line inline tables.

import { readDateTime } from './datetime.js'
import { TomlError, assert, excerpt } from './error.js'

const MAX_DEPTH = 64

// Sticky patterns, read at `src.pos`; `take` moves it past the match.
function take(src, re) {
  re.lastIndex = src.pos
  const m = re.exec(src.text)
  if (m !== null) src.pos = re.lastIndex
  return m
}

const SPACES = /[\t ]*/uy
export const skipSpaces = (src) => take(src, SPACES)

// What is left of the line, for a message: no more of it than a message
// shows, however long the line.
export function found(src) {
  if (src.pos >= src.text.length) return 'the end of the text'
  const rest = /^[^\n]*/u.exec(src.text.slice(src.pos, src.pos + 65))[0].replace(/\r$/u, '')
  return rest === '' ? 'the end of the line' : excerpt(rest)
}

// The characters TOML allows in neither a string nor a comment are the
// controls of C0 but tab, and DEL: all of Unicode's controls but tab and C1,
// which is how the patterns below spell them. A carriage return counts, but
// for the one before a line feed, which ends the line.
const hex = (char) => `U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`

function refuseControl(src, char, where) {
  if (char === '\r') assert(false, src, 'a carriage return must be followed by a line feed')
  assert(false, src, () => `${hex(char)} is not allowed in ${where}`)
}

// Whether the line ends at `src.pos`: a line break or the end of the text.
export const atLineEnd = (src) => src.pos >= src.text.length || src.text[src.pos] === '\n' || src.text.startsWith('\r\n', src.pos)

// A comment runs to the end of its line and is dropped.
const COMMENT = /#[^[\p{Cc}--[\t\u0080-\u009F]]]*/vy
export function skipComment(src) {
  if (take(src, COMMENT) === null) return
  const char = src.text[src.pos]
  if (char !== undefined && char !== '\n' && !src.text.startsWith('\r\n', src.pos)) refuseControl(src, char, 'a comment')
}

// A line break, `\n` or `\r\n`, if one is next.
export function takeNewline(src) {
  if (src.text[src.pos] === '\n') src.pos += 1
  else if (src.text.startsWith('\r\n', src.pos)) src.pos += 2
  else return false
  src.line++
  return true
}

// Whitespace, comments and line breaks, as an array may hold between values.
function skipBlank(src) {
  do {
    skipSpaces(src)
    skipComment(src)
  } while (takeNewline(src))
}

const ESCAPES = { __proto__: null, b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' }
const BASIC_RUN = /[^"\\[\p{Cc}--[\t\u0080-\u009F]]]*/vy
const UNICODE = /u([\dA-Fa-f]{4})|U([\dA-Fa-f]{8})/uy

function readEscape(src) {
  const char = src.text[src.pos]
  if (char in ESCAPES) {
    src.pos++
    return ESCAPES[char]
  }
  const m = take(src, UNICODE)
  assert(m !== null, src, () => `unsupported escape ${excerpt(`\\${char ?? ''}`)}`)
  const code = Number.parseInt(m[1] ?? m[2], 16)
  assert(code <= 0x10FFFF && (code < 0xD800 || code > 0xDFFF), src, () => `\\${m[0]} is not a Unicode scalar value`)
  return String.fromCodePoint(code)
}

// `"…"`, on one line, with TOML 1.0's escapes.
function readBasic(src) {
  assert(!src.text.startsWith('"""', src.pos), src, 'multi-line strings are not supported')
  src.pos++
  let value = ''
  for (;;) {
    value += take(src, BASIC_RUN)[0]
    assert(!atLineEnd(src), src, 'unterminated string')
    const char = src.text[src.pos]
    src.pos++
    if (char === '"') return value
    if (char === '\\') value += readEscape(src)
    else refuseControl(src, char, 'a string')
  }
}

// `'…'`, on one line, taken as written.
const LITERAL_RUN = /[^'[\p{Cc}--[\t\u0080-\u009F]]]*/vy
function readLiteral(src) {
  assert(!src.text.startsWith("'''", src.pos), src, 'multi-line strings are not supported')
  src.pos++
  const value = take(src, LITERAL_RUN)[0]
  assert(!atLineEnd(src), src, 'unterminated string')
  const char = src.text[src.pos]
  src.pos++
  return char === "'" ? value : refuseControl(src, char, 'a string')
}

// A key: bare, of ASCII letters, digits, `_` and `-`, or quoted; dotted, a
// list of them with dots between, spaces allowed about each dot.
const BARE = /[\w-]+/uy
function readSimpleKey(src) {
  const char = src.text[src.pos]
  if (char === '"') return readBasic(src)
  if (char === "'") return readLiteral(src)
  const m = take(src, BARE)
  assert(m !== null, src, () => `expected a key, found ${found(src)}`)
  return m[0]
}

export function readKey(src) {
  const keys = [readSimpleKey(src)]
  for (;;) {
    const at = src.pos
    skipSpaces(src)
    if (src.text[src.pos] !== '.') {
      src.pos = at
      return keys
    }
    src.pos++
    skipSpaces(src)
    keys.push(readSimpleKey(src))
    assert(keys.length <= MAX_DEPTH, src, 'a key with too many parts')
  }
}

// What a value that is not a string, an array or an inline table may be
// spelled with; one is read whole and then told apart.
const TOKEN = /[\w+.:-]+/uy
const INTEGER = /^[+-]?(?:0|[1-9](?:_?\d)*)$/u
const FLOAT = /^[+-]?(?:inf|nan|(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*)?(?:[Ee][+-]?\d(?:_?\d)*)?)$/u

function readToken(src) {
  const m = take(src, TOKEN)
  assert(m !== null, src, () => `expected a value, found ${found(src)}`)
  const token = m[0]
  if (token === 'true') return true
  if (token === 'false') return false
  if (INTEGER.test(token)) {
    const number = Number(token.replaceAll('_', ''))
    assert(Math.abs(number) <= Number.MAX_SAFE_INTEGER, src, () => `integer out of range ${excerpt(token)}`)
    return number === 0 ? 0 : number
  }
  const datetime = readDateTime(token, src)
  if (datetime !== undefined) return datetime
  assert(!FLOAT.test(token), src, () => `floats are not supported: ${excerpt(token)}`)
  assert(!/^[+-]?0[box]/u.test(token), src, () => `hexadecimal, octal and binary integers are not supported: ${excerpt(token)}`)
  throw new TomlError(`expected a value, found ${excerpt(token)}`, src.line)
}

// A key is set once in its table.
export function setKey(src, table, key, value) {
  assert(!(key in table), src, () => `duplicate key ${excerpt(key)}`)
  table[key] = value
}

// `key = value`, the key dotted or not, for the caller to set.
export function readKeyValue(src, depth) {
  const keys = readKey(src)
  skipSpaces(src)
  assert(src.text[src.pos] === '=', src, () => `expected "=" after the key, found ${found(src)}`)
  src.pos++
  skipSpaces(src)
  return { keys, value: readValue(src, depth) }
}

function readArray(src, depth) {
  src.pos++
  const list = []
  src.fixed.add(list)
  for (;;) {
    skipBlank(src)
    if (src.text[src.pos] === ']') break
    list.push(readValue(src, depth + 1))
    skipBlank(src)
    if (src.text[src.pos] === ']') break
    assert(src.text[src.pos] === ',', src, () => `expected "," or "]", found ${found(src)}`)
    src.pos++
  }
  src.pos++
  return list
}

// A dotted key within an inline table may only go through tables the same
// inline table's dotted keys made, which are `open`.
const inlineKind = (value) => (Array.isArray(value) ? 'an array' : Object.getPrototypeOf(value) === null ? 'an inline table' : 'a value')

function putInline(src, table, open, keys, value) {
  let at = table
  for (const key of keys.slice(0, -1)) {
    if (!(key in at)) {
      at[key] = Object.create(null)
      open.add(at[key])
      src.fixed.add(at[key])
    }
    const next = at[key]
    assert(open.has(next), src, () => `${excerpt(key)} is ${inlineKind(next)}, which a dotted key cannot add to`)
    at = next
  }
  setKey(src, at, keys.at(-1), value)
}

function readInline(src, depth) {
  src.pos++
  const table = Object.create(null)
  src.fixed.add(table)
  const open = new Set()
  skipSpaces(src)
  if (src.text[src.pos] === '}') {
    src.pos++
    return table
  }
  for (;;) {
    skipSpaces(src)
    const { keys, value } = readKeyValue(src, depth + 1)
    putInline(src, table, open, keys, value)
    skipSpaces(src)
    const char = src.text[src.pos]
    assert(char === ',' || char === '}', src, () => `expected "," or "}" on the inline table's line, found ${found(src)}`)
    src.pos++
    if (char === '}') return table
  }
}

function readValue(src, depth) {
  assert(depth <= MAX_DEPTH, src, 'nested too deep')
  switch (src.text[src.pos]) {
    case '"':
      return readBasic(src)
    case "'":
      return readLiteral(src)
    case '[':
      return readArray(src, depth)
    case '{':
      return readInline(src, depth)
    default:
      return readToken(src)
  }
}
