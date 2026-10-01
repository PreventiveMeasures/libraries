// `src` is { text, pos, line }, `line` counting from zero. Where a line's key
// goes is parse.js's to say; an inline table's keys are set here.

import { hex } from '../excerpt.js'
import { readDateTime } from './datetime.js'
import { EXCERPT, TomlError, assert, excerpt } from './error.js'
import { readFloat, readInteger } from './number.js'

const MAX_DEPTH = 64

// `re` must be sticky.
function take(src, re) {
  re.lastIndex = src.pos
  const m = re.exec(src.text)
  if (m !== null) src.pos = re.lastIndex
  return m
}

function skipSpaces(src) {
  while (src.text[src.pos] === ' ' || src.text[src.pos] === '\t') src.pos++
}

// One character past EXCERPT, so that excerpt knows to mark the cut.
function found(src) {
  if (src.pos >= src.text.length) return 'the end of the text'
  const rest = /^[^\n]*/u.exec(src.text.slice(src.pos, src.pos + EXCERPT + 1))[0].replace(/\r$/u, '')
  return rest === '' ? 'the end of the line' : excerpt(rest)
}

const LONE_CR = 'a carriage return must be followed by a line feed'

function refuseControl(src, char, where) {
  throw new TomlError(char === '\r' ? LONE_CR : `${hex(char)} is not allowed in ${where}`, src.line)
}

const atLineEnd = (src) => src.pos >= src.text.length || src.text[src.pos] === '\n' || src.text.startsWith('\r\n', src.pos)

// TOML forbids C0 controls but tab, and DEL, in comments and strings: that is
// \p{Cc} less tab and C1, as this and RUN spell it.
const COMMENT = /#[^[\p{Cc}--[\t\u0080-\u009F]]]*/vy
function skipComment(src) {
  if (src.text[src.pos] !== '#') return
  take(src, COMMENT)
  if (!atLineEnd(src)) refuseControl(src, src.text[src.pos], 'a comment')
}

function takeNewline(src) {
  if (src.text[src.pos] === '\n') src.pos += 1
  else if (src.text.startsWith('\r\n', src.pos)) src.pos += 2
  else return false
  src.line++
  return true
}

function skipBlank(src) {
  do {
    skipSpaces(src)
    skipComment(src)
  } while (takeNewline(src))
}

const ESCAPES = { __proto__: null, b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' }
const RUN = {
  __proto__: null,
  '"': /[^"\\[\p{Cc}--[\t\u0080-\u009F]]]*/vy,
  "'": /[^'[\p{Cc}--[\t\u0080-\u009F]]]*/vy,
}
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

// A literal string's run takes backslashes in, so only a basic one stops.
function readString(src, quote) {
  src.pos++
  let value = ''
  for (;;) {
    value += take(src, RUN[quote])[0]
    assert(!atLineEnd(src), src, 'unterminated string')
    const char = src.text[src.pos]
    src.pos++
    if (char === quote) return value
    if (char === '\\') value += readEscape(src)
    else refuseControl(src, char, 'a string')
  }
}

// A backslash that ends a line trims the whitespace after it, line breaks
// and all; any other is an escape.
const CONTINUATION = /[\t ]*\r?\n(?:[\t ]|\r?\n)*/uy
function readMultilineEscape(src) {
  const m = take(src, CONTINUATION)
  if (m === null) return readEscape(src)
  src.line += m[0].split('\n').length - 1
  return ''
}

// A line break just after the opening quotes is dropped, and CRLF is read as
// LF, as tomllib does; up to two quotes before the closing three are content.
const CLOSE = { __proto__: null, '"': /"{3,5}/uy, "'": /'{3,5}/uy }
function readMultiline(src, quote) {
  src.pos += 3
  takeNewline(src)
  let value = ''
  for (;;) {
    value += take(src, RUN[quote])[0]
    if (takeNewline(src)) {
      value += '\n'
      continue
    }
    assert(src.pos < src.text.length, src, 'unterminated string')
    const close = take(src, CLOSE[quote])
    if (close !== null) return value + close[0].slice(3)
    const char = src.text[src.pos]
    src.pos++
    if (char === quote) value += char
    else if (char === '\\') value += readMultilineEscape(src)
    else refuseControl(src, char, 'a string')
  }
}

const tripled = (src, quote) => src.text[src.pos + 1] === quote && src.text[src.pos + 2] === quote

const BARE = /[\w-]+/uy
function readSimpleKey(src) {
  const char = src.text[src.pos]
  if (char === '"' || char === "'") {
    assert(!tripled(src, char), src, 'a multi-line string cannot be a key')
    return readString(src, char)
  }
  const m = take(src, BARE)
  assert(m !== null, src, () => `expected a key, found ${found(src)}`)
  return m[0]
}

// Takes the spaces after the key too.
function readKey(src) {
  const keys = [readSimpleKey(src)]
  for (;;) {
    skipSpaces(src)
    if (src.text[src.pos] !== '.') return keys
    src.pos++
    skipSpaces(src)
    keys.push(readSimpleKey(src))
    assert(keys.length <= MAX_DEPTH, src, 'a key with too many parts')
  }
}

const TOKEN = /[\w+.:-]+/uy

function readToken(src) {
  const m = take(src, TOKEN)
  assert(m !== null, src, () => `expected a value, found ${found(src)}`)
  const token = m[0]
  if (token === 'true') return true
  if (token === 'false') return false
  const value = readInteger(token, src) ?? readFloat(token, src) ?? readDateTime(token, src)
  assert(value !== undefined, src, () => `expected a value, found ${excerpt(token)}`)
  return value
}

// Tables have no prototype and no value is undefined: this is `key in table`.
function setKey(src, table, key, value) {
  assert(table[key] === undefined, src, () => `duplicate key ${excerpt(key)}`)
  table[key] = value
}

function readKeyValue(src, depth) {
  const keys = readKey(src)
  assert(src.text[src.pos] === '=', src, () => `expected "=" after the key, found ${found(src)}`)
  src.pos++
  skipSpaces(src)
  return { header: false, keys, value: readValue(src, depth) }
}

function readArray(src, depth) {
  src.pos++
  const list = []
  for (skipBlank(src); src.text[src.pos] !== ']'; skipBlank(src)) {
    list.push(readValue(src, depth + 1))
    skipBlank(src)
    if (src.text[src.pos] === ']') break
    assert(src.text[src.pos] === ',', src, () => `expected "," or "]", found ${found(src)}`)
    src.pos++
  }
  src.pos++
  return list
}

export const isTable = (value) => typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === null

// A dotted key goes only through tables dotted keys made, which are `made`;
// `refused` says why another is not one.
export function putDotted(src, table, made, keys, value, refused) {
  let at = table
  for (const key of keys.slice(0, -1)) {
    if (!(key in at)) made.add(at[key] = Object.create(null))
    const next = at[key]
    assert(made.has(next), src, () => refused(key, next))
    at = next
  }
  setKey(src, at, keys.at(-1), value)
}

// An inline table's dotted keys go only through tables they made, `open`.
const inlineKind = (value) => (Array.isArray(value) ? 'an array' : isTable(value) ? 'an inline table' : 'a value')
const inlineRefused = (key, next) => `${excerpt(key)} is ${inlineKind(next)}, which a dotted key cannot add to`

// An inline table across lines, with comments or a trailing comma, is 1.1.
function sameLine(src) {
  skipSpaces(src)
  assert(!atLineEnd(src) && src.text[src.pos] !== '#', src, 'an inline table across lines is not supported')
}

function readInline(src, depth) {
  src.pos++
  const table = Object.create(null)
  const open = new Set()
  sameLine(src)
  if (src.text[src.pos] === '}') {
    src.pos++
    return table
  }
  for (;;) {
    sameLine(src)
    assert(src.text[src.pos] !== '}', src, 'a trailing comma in an inline table is not supported')
    const { keys, value } = readKeyValue(src, depth + 1)
    putDotted(src, table, open, keys, value, inlineRefused)
    sameLine(src)
    const char = src.text[src.pos]
    assert(char === ',' || char === '}', src, () => `expected "," or "}" on the inline table's line, found ${found(src)}`)
    src.pos++
    if (char === '}') return table
  }
}

function readValue(src, depth) {
  assert(depth <= MAX_DEPTH, src, 'nested too deep')
  const char = src.text[src.pos]
  if (char === '"' || char === "'") return tripled(src, char) ? readMultiline(src, char) : readString(src, char)
  if (char === '[') return readArray(src, depth)
  if (char === '{') return readInline(src, depth)
  return readToken(src)
}

function readHeader(src) {
  const array = src.text.startsWith('[[', src.pos)
  src.pos += array ? 2 : 1
  skipSpaces(src)
  const keys = readKey(src)
  const close = array ? ']]' : ']'
  assert(src.text.startsWith(close, src.pos), src, () => `expected "${close}", found ${found(src)}`)
  src.pos += close.length
  return { header: true, keys, array }
}

// `header` is always an own property, so that one set on Object.prototype
// cannot turn a header into a key; undefined for a line with neither.
export function readLine(src) {
  skipSpaces(src)
  const char = src.text[src.pos]
  if (char === '[') return readHeader(src)
  if (char === '#' || char === '\r' || atLineEnd(src)) return undefined
  return readKeyValue(src, 0)
}

export function endLine(src) {
  skipSpaces(src)
  skipComment(src)
  if (takeNewline(src) || src.pos === src.text.length) return
  assert(src.text[src.pos] !== '\r', src, LONE_CR)
  throw new TomlError(`expected the end of the line, found ${found(src)}`, src.line)
}
