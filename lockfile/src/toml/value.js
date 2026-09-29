// The lines of a TOML document, read from `src`: { text, pos, line }, the
// text, where the reader is in it, and the line it is on (from zero). A
// line holds a header, or a key and its value, or neither; readLine reads
// what it holds and endLine the spaces, comment and line break after. Where
// a line's key goes is parse.js's to say; an inline table's keys are set
// here.
//
// Read here: basic and literal strings, on one line or across lines,
// integers and floats (number.js), booleans, offset date-times, arrays
// (across lines, with comments and a trailing comma) and inline tables (on
// one line, as TOML 1.0 has them). Refused, each by name: local dates and
// times, and TOML 1.1's escapes, times without seconds, and inline tables
// across lines or with a trailing comma.

import { readDateTime } from './datetime.js'
import { EXCERPT, TomlError, assert, excerpt } from './error.js'
import { readFloat, readInteger } from './number.js'

const MAX_DEPTH = 64

// Sticky patterns, read at `src.pos`; `take` moves it past the match.
function take(src, re) {
  re.lastIndex = src.pos
  const m = re.exec(src.text)
  if (m !== null) src.pos = re.lastIndex
  return m
}

function skipSpaces(src) {
  while (src.text[src.pos] === ' ' || src.text[src.pos] === '\t') src.pos++
}

// What is left of the line, for a message: no more of it than a message
// shows, and one character to tell it is cut, however long the line.
function found(src) {
  if (src.pos >= src.text.length) return 'the end of the text'
  const rest = /^[^\n]*/u.exec(src.text.slice(src.pos, src.pos + EXCERPT + 1))[0].replace(/\r$/u, '')
  return rest === '' ? 'the end of the line' : excerpt(rest)
}

// The characters TOML allows in neither a string nor a comment are the
// controls of C0 but tab, and DEL: all of Unicode's controls but tab and C1,
// which is how the patterns below spell them. A carriage return counts, but
// for the one before a line feed, which ends the line.
const hex = (char) => `U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`
const LONE_CR = 'a carriage return must be followed by a line feed'

function refuseControl(src, char, where) {
  throw new TomlError(char === '\r' ? LONE_CR : `${hex(char)} is not allowed in ${where}`, src.line)
}

// Whether the line ends at `src.pos`: a line break or the end of the text.
const atLineEnd = (src) => src.pos >= src.text.length || src.text[src.pos] === '\n' || src.text.startsWith('\r\n', src.pos)

// A comment runs to the end of its line and is dropped.
const COMMENT = /#[^[\p{Cc}--[\t\u0080-\u009F]]]*/vy
function skipComment(src) {
  if (src.text[src.pos] !== '#') return
  take(src, COMMENT)
  if (!atLineEnd(src)) refuseControl(src, src.text[src.pos], 'a comment')
}

// A line break, `\n` or `\r\n`, if one is next.
function takeNewline(src) {
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
// What a string's run stops at, by its quote: the quote, a control, and in
// a basic string a backslash.
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

// `"…"`, with TOML 1.0's escapes, or `'…'`, taken as written, on one line.
// A literal string's run takes in backslashes, so only a basic one stops at
// one.
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

// After a backslash in a multi-line basic string: the end of its line,
// whitespace before it allowed, which takes along every space, tab and
// line break up to the string's next character; or else an escape.
function readMultilineEscape(src) {
  const at = src.pos
  skipSpaces(src)
  if (!takeNewline(src)) {
    src.pos = at
    return readEscape(src)
  }
  do {
    skipSpaces(src)
  } while (takeNewline(src))
  return ''
}

// `"""…"""` and `'''…'''`, across lines. A line break just after the opening
// quotes is dropped, and CRLF within is read as LF, as tomllib has it. The
// first run of three quotes or more ends the string, and one or two past
// three are the string's own. A basic one has the escapes a basic string
// has, and a backslash that ends its line; in a literal one, nothing is
// escaped.
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

// Whether the quote at `src.pos` opens a multi-line string.
const tripled = (src, quote) => src.text[src.pos + 1] === quote && src.text[src.pos + 2] === quote

// A key: bare, of ASCII letters, digits, `_` and `-`, or quoted; dotted, a
// list of them with dots between, spaces allowed about each dot, and the
// spaces after it taken too.
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

// What a value that is not a string, an array or an inline table may be
// spelled with; one is read whole and then told apart.
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

// A key is set once in its table. A table has no prototype and no value
// is undefined, so a key is there where its value is.
export function setKey(src, table, key, value) {
  assert(table[key] === undefined, src, () => `duplicate key ${excerpt(key)}`)
  table[key] = value
}

// `key = value`, the key dotted or not, for the caller to set.
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

// A table read here or made in parse.js: an object of no prototype.
export const isTable = (value) => typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === null

// A dotted key within an inline table may only go through tables the same
// inline table's dotted keys made, which are `open`.
const inlineKind = (value) => (Array.isArray(value) ? 'an array' : isTable(value) ? 'an inline table' : 'a value')

function putInline(src, table, open, keys, value) {
  let at = table
  for (const key of keys.slice(0, -1)) {
    if (!(key in at)) {
      at[key] = Object.create(null)
      open.add(at[key])
    }
    const next = at[key]
    assert(open.has(next), src, () => `${excerpt(key)} is ${inlineKind(next)}, which a dotted key cannot add to`)
    at = next
  }
  setKey(src, at, keys.at(-1), value)
}

// TOML 1.1 lets an inline table run across lines, with comments, and end
// in a comma; the 1.0 read here keeps it to one line and no comma after
// its last pair. Spaces are passed over on the way.
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
    putInline(src, table, open, keys, value)
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
  switch (char) {
    case '"':
    case "'":
      return tripled(src, char) ? readMultiline(src, char) : readString(src, char)
    case '[':
      return readArray(src, depth)
    case '{':
      return readInline(src, depth)
    default:
      return readToken(src)
  }
}

// `[a.b]` or `[[a.b]]`: the header's keys, and whether it adds a table to
// an array of tables.
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

// What a line holds: a header, as { header: true, keys, array }, or a key
// and its value, as { header: false, keys, value }; or undefined, where it
// is blank or a comment, or begins with a carriage return that endLine
// refuses. Each says itself which it is, so that no `header` another module
// sets on Object.prototype can.
export function readLine(src) {
  skipSpaces(src)
  const char = src.text[src.pos]
  if (char === '[') return readHeader(src)
  if (char === '#' || char === '\r' || atLineEnd(src)) return undefined
  return readKeyValue(src, 0)
}

// The rest of a line: spaces, a comment, and its line break or the end of
// the text.
export function endLine(src) {
  skipSpaces(src)
  skipComment(src)
  if (takeNewline(src) || src.pos === src.text.length) return
  assert(src.text[src.pos] !== '\r', src, LONE_CR)
  throw new TomlError(`expected the end of the line, found ${found(src)}`, src.line)
}
