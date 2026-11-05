// Package.resolved exactly as SwiftPM writes it: version 1 with TSCBasic's
// JSON, `"key": value`, and 2 and 3 with Foundation's JSONEncoder, `"key" :
// value`, each pretty-printed, two spaces a level, the keys of each object
// sorted, and a string as JSON.stringify writes it. The file is ended at the
// last `}`, where SwiftPM adds a line end from 5.6, but on Windows, and an
// editor may add more. A file read here is the one SwiftPM writes again of
// what JSON.parse reads of it; JSON.parse alone takes more, and reads a key
// given twice as the last, as SwiftPM's JSONDecoder does on one platform and
// not on another.

import { LockfileError, at, attempt, quote, raise } from '../error.js'
import { advance, fail, lines } from '../lines.js'

// Never in a Package.resolved: a control, which both writers escape and no
// field may have; a lone surrogate, which no Swift string holds; and a byte
// order mark, which neither writes.
const FORBIDDEN = /[\p{Cc}\p{Cs}\uFEFF]/u

// The levels of containers a Package.resolved nests, a pin's state of
// version 1 the deepest: a bound on the walk below, past which nothing is
// one SwiftPM writes.
const DEPTH = 5

// Where `key` of what is at `where` is: `[2]` of an index, and of a key as
// at() writes one.
const place = (where, key) => (typeof key === 'number' ? `${where ?? ''}[${key}]` : at(where ?? '', key))

// A container at `depth` with its objects as mappings with a null
// prototype, so a key is only ever a key.
function toRecords(value, where, depth) {
  if (Array.isArray(value)) return value.map((item, index) => toRecord(item, where, index, depth))
  const record = Object.create(null)
  for (const name of Object.keys(value)) record[name] = toRecord(value[name], where, name, depth)
  return record
}

// The value at `key` of the container at `where`, `depth` deep: a string
// one SwiftPM writes, as JSON.stringify writes an escaped control and lone
// surrogate back as they are. Where it is is made only of a container, or
// of a string refused, as a file of many pins has millions of values.
function toRecord(value, parent, key, depth) {
  if (typeof value === 'string') {
    if (!value.isWellFormed()) throw new LockfileError('a lone surrogate, escaped, which no Swift string has', place(parent, key))
    if (/\p{Cc}/u.test(value)) throw new LockfileError(`${quote(value)} has a control, escaped, which no field SwiftPM writes has`, place(parent, key))
    return value
  }
  if (typeof value !== 'object' || value === null) return value
  const where = place(parent, key)
  if (depth + 1 === DEPTH) throw new LockfileError(`nested more than ${DEPTH} deep, as no Package.resolved is`, where)
  return toRecords(value, where, depth + 1)
}

// The lines of a text, from the first, each held to the one SwiftPM writes
// there, without a copy of either: `line` takes the next, `end` the rest,
// which may be line ends alone.
class Lines {
  constructor(text, crlf, version) {
    Object.assign(this, { text, version, eol: crlf ? '\r\n' : '\n', pos: 0, number: 0 })
  }

  line(expected) {
    const { text, pos, eol } = this
    const end = pos + expected.length
    if (pos > text.length || !text.startsWith(expected, pos) || (end < text.length && !text.startsWith(eol, end))) this.refuse(quote(expected))
    this.pos = end + eol.length
    this.number++
  }

  end() {
    if (this.text.slice(this.pos).split(this.eol).some((rest) => rest !== '')) this.refuse('the end of the file')
  }

  refuse(expected) {
    const { text, pos, eol, version } = this
    const end = text.indexOf(eol, pos)
    const found = pos > text.length ? 'the end of the file' : quote(text.slice(pos, end === -1 ? undefined : end))
    throw fail(`expected ${expected}, as SwiftPM writes version ${version} with ${version === 1 ? 'TSCBasic\'s JSON' : 'JSONEncoder'}, found ${found}`, this.number)
  }
}

// The lines SwiftPM writes of a value `indent` spaces in, with `colon` after
// a key, each held to the text's: the first after `head`, the last before
// `tail`. An empty container is its brackets a blank line apart, as
// TSCBasic writes one, and SwiftPM writes none.
function write(value, colon, head, indent, tail, held) {
  if (typeof value !== 'object' || value === null) {
    held.line(`${head}${JSON.stringify(value)}${tail}`)
    return
  }
  const inner = `${indent}  `
  const array = Array.isArray(value)
  const keys = array ? undefined : Object.keys(value).sort()
  const count = array ? value.length : keys.length
  held.line(`${head}${array ? '[' : '{'}`)
  if (count === 0) held.line('')
  for (let index = 0; index < count; index++) {
    const comma = index < count - 1 ? ',' : ''
    if (array) write(value[index], colon, inner, inner, comma, held)
    else write(value[keys[index]], colon, `${inner}${JSON.stringify(keys[index])}${colon}`, inner, comma, held)
  }
  held.line(`${indent}${array ? ']' : '}'}${tail}`)
}

// Every line held to what no line SwiftPM writes has, line ends of one kind,
// as lines.js reads them; and the value JSON.parse reads.
export function readJson(text) {
  const src = lines(text, FORBIDDEN)
  do advance(src)
  while (src.line !== undefined)
  const value = attempt(() => JSON.parse(text), (error) => raise(`not JSON: ${error.message}`))
  return { value: typeof value === 'object' && value !== null ? toRecords(value, undefined, 0) : value, crlf: src.crlf === true }
}

// The text held to what the writer of `version` writes of `value`, line by
// line, to the last `}` and any line ends after.
export function checkLayout(text, { value, crlf }, version) {
  const held = new Lines(text, crlf, version)
  write(value, version === 1 ? ': ' : ' : ', '', '', '', held)
  held.end()
}
