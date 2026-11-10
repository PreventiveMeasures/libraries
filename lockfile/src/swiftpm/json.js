// Package.resolved as SwiftPM writes it: JSON.parse's reading of the file,
// held line by line to what the writer of its version writes of that.

import { LockfileError, at, attempt, quote, raise } from '../error.js'
import { advance, fail, lines } from '../lines.js'

// A control, which no field has; a lone surrogate; a byte order mark.
const FORBIDDEN = /[\p{Cc}\p{Cs}\uFEFF]/u
// The deepest a Package.resolved nests, a version 1 pin's state.
const DEPTH = 5

// Records of no prototype, strings as SwiftPM writes them, as JSON.stringify
// writes back an escaped control or lone surrogate. Where a value is is made
// only where needed: there are millions.
function toRecords(value, parent, key, depth) {
  const where = () => (key === undefined ? undefined : typeof key === 'number' ? `${parent ?? ''}[${key}]` : at(parent ?? '', key))
  if (typeof value === 'string' && (!value.isWellFormed() || /\p{Cc}/u.test(value))) throw new LockfileError(`${quote(value)} escapes a control or a lone surrogate, which SwiftPM writes in no field`, where())
  if (typeof value !== 'object' || value === null) return value
  if (depth === DEPTH) throw new LockfileError(`nested more than ${DEPTH} deep, as no Package.resolved is`, where())
  const here = where()
  const array = Array.isArray(value)
  const record = array ? [] : Object.create(null)
  for (const name of Object.keys(value)) record[name] = toRecords(value[name], here, array ? Number(name) : name, depth + 1)
  return record
}

// The lines SwiftPM writes of `value`, each given to `line`: two spaces a
// level, keys sorted, an empty container's brackets a blank line apart.
function write(value, colon, head, indent, tail, line) {
  if (typeof value !== 'object' || value === null) {
    line(`${head}${JSON.stringify(value)}${tail}`)
    return
  }
  const inner = `${indent}  `
  const array = Array.isArray(value)
  const keys = array ? undefined : Object.keys(value).sort()
  const count = array ? value.length : keys.length
  line(`${head}${array ? '[' : '{'}`)
  if (count === 0) line('')
  for (let index = 0; index < count; index++) {
    const comma = index < count - 1 ? ',' : ''
    if (array) write(value[index], colon, inner, inner, comma, line)
    else write(value[keys[index]], colon, `${inner}${JSON.stringify(keys[index])}${colon}`, inner, comma, line)
  }
  line(`${indent}${array ? ']' : '}'}${tail}`)
}

export function readJson(text) {
  const src = lines(text, FORBIDDEN)
  do advance(src)
  while (src.line !== undefined)
  const value = attempt(() => JSON.parse(text), (error) => raise(`not JSON: ${error.message}`))
  return { value: toRecords(value, undefined, undefined, 0), crlf: src.crlf === true }
}

// TSCBasic's JSON writes version 1, `"key": value`; JSONEncoder 2 and 3,
// `"key" : value`. Line ends may follow the last `}`.
export function checkLayout(text, { value, crlf }, version) {
  const eol = crlf ? '\r\n' : '\n'
  let pos = 0
  let number = 0
  const refuse = (expected) => {
    const end = text.indexOf(eol, pos)
    const found = pos > text.length ? 'the end of the file' : quote(text.slice(pos, end === -1 ? undefined : end))
    throw fail(`expected ${expected}, as SwiftPM writes version ${version} with ${version === 1 ? 'TSCBasic\'s JSON' : 'JSONEncoder'}, found ${found}`, number)
  }
  write(value, version === 1 ? ': ' : ' : ', '', '', '', (expected) => {
    const end = pos + expected.length
    if (pos > text.length || !text.startsWith(expected, pos) || (end < text.length && !text.startsWith(eol, end))) refuse(quote(expected))
    pos = end + eol.length
    number++
  })
  if (text.slice(pos).split(eol).some((rest) => rest !== '')) refuse('the end of the file')
}
