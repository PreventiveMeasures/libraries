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

// Objects as mappings with a null prototype, so a key is only ever a key;
// and each string one SwiftPM writes, as JSON.stringify writes an escaped
// control and lone surrogate back as they are.
function toRecords(value, where, depth) {
  if (typeof value === 'string') {
    if (!value.isWellFormed()) throw new LockfileError('a lone surrogate, escaped, which no Swift string has', where)
    if (/\p{Cc}/u.test(value)) throw new LockfileError(`${quote(value)} has a control, escaped, which no field SwiftPM writes has`, where)
  }
  if (typeof value !== 'object' || value === null) return value
  if (depth === DEPTH) throw new LockfileError(`nested more than ${DEPTH} deep, as no Package.resolved is`, where)
  if (Array.isArray(value)) return value.map((item, index) => toRecords(item, `${where ?? ''}[${index}]`, depth + 1))
  const record = Object.create(null)
  for (const [key, item] of Object.entries(value)) record[key] = toRecords(item, at(where ?? '', key), depth + 1)
  return record
}

// The lines SwiftPM writes of a value `indent` spaces in, with `colon` after
// a key, into `out`: the first after `head`, the last before `tail`. An empty
// container is its brackets a blank line apart, as TSCBasic writes one, and
// SwiftPM writes none. Each line once, as a file of many pins has millions.
function write(value, colon, head, indent, tail, out) {
  if (typeof value !== 'object' || value === null) {
    out.push(`${head}${JSON.stringify(value)}${tail}`)
    return
  }
  const inner = `${indent}  `
  const array = Array.isArray(value)
  const items = array ? value.map((item) => [inner, item]) : Object.keys(value).sort().map((key) => [`${inner}${JSON.stringify(key)}${colon}`, value[key]])
  out.push(`${head}${array ? '[' : '{'}`)
  if (items.length === 0) out.push('')
  for (const [index, [prefix, item]] of items.entries()) write(item, colon, prefix, inner, index < items.length - 1 ? ',' : '', out)
  out.push(`${indent}${array ? ']' : '}'}${tail}`)
}

// Every line held to what no line SwiftPM writes has, line ends of one kind,
// as lines.js reads them; and the value JSON.parse reads.
export function readJson(text) {
  const src = lines(text, FORBIDDEN)
  do advance(src)
  while (src.line !== undefined)
  return { value: toRecords(attempt(() => JSON.parse(text), (error) => raise(`not JSON: ${error.message}`)), undefined, 0), crlf: src.crlf === true }
}

// The text held to what the writer of `version` writes of `value`, line by
// line, to the last `}` and any line ends after.
export function checkLayout(text, { value, crlf }, version) {
  const written = []
  write(value, version === 1 ? ': ' : ' : ', '', '', '', written)
  const found = text.split(crlf ? '\r\n' : '\n')
  let line = 0
  while (line < written.length && found[line] === written[line]) line++
  if (line === written.length && found.slice(line).every((rest) => rest === '')) return
  const writer = version === 1 ? 'TSCBasic\'s JSON' : 'JSONEncoder'
  const expected = line < written.length ? quote(written[line]) : 'the end of the file'
  throw fail(`expected ${expected}, as SwiftPM writes version ${version} with ${writer}, found ${line < found.length ? quote(found[line]) : 'the end of the file'}`, line)
}
