// The shapes a value parseToml hands back comes in, each checked where it
// is read, for the readers of Cargo.lock, uv.lock, poetry.lock and
// pylock.toml. A table has a null prototype, so a key is only ever a key.

import { LockfileError, at, quote } from '../error.js'
import { TomlDateTime } from './datetime.js'
import { TomlFloat } from './number.js'
import { isTable } from './value.js'

export function kind(value) {
  if (value === undefined) return 'nothing'
  if (Array.isArray(value)) return 'an array'
  if (value instanceof TomlFloat) return `the float ${value.text}`
  if (value instanceof TomlDateTime) return `the date-time ${value.text}`
  if (typeof value === 'object') return 'a table'
  if (typeof value === 'string') return `the string ${quote(value)}`
  return `the ${typeof value === 'boolean' ? 'boolean' : 'integer'} ${String(value)}`
}

export const refuse = (expected, value, where) => new LockfileError(`expected ${expected}, found ${kind(value)}`, where)

// A table with only the `fields` named, when named; `refused` names a key
// with the reason it is not read.
export function table(value, where, fields, refused = {}) {
  if (!isTable(value)) throw refuse('a table', value, where)
  for (const key of fields === undefined ? [] : Object.keys(value)) {
    if (Object.hasOwn(refused, key)) throw new LockfileError(refused[key], at(where ?? '', key))
    if (!fields.includes(key)) throw new LockfileError(`unsupported key ${quote(key)}`, where)
  }
  return value
}

export const entries = (value, where) => Object.entries(table(value, where)).map(([key, item]) => [key, item, at(where, key)])

export function string(value, where) {
  if (typeof value !== 'string') throw refuse('a string', value, where)
  return value
}

export function boolean(value, where) {
  if (typeof value !== 'boolean') throw refuse('true or false', value, where)
  return value
}

export function array(value, where) {
  if (!Array.isArray(value)) throw refuse('an array', value, where)
  return value
}

export function strings(value, where) {
  return array(value, where).map((item, index) => string(item, `${where}[${index}]`))
}

// A size in bytes, or any count: an integer a number holds exactly.
export function size(value, where) {
  if (!Number.isSafeInteger(value) || value < 0) throw refuse('a non-negative integer', value, where)
  return value
}
