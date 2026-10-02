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

// An array, each item as `read` makes it.
export const arrayOf = (read) => (value, where) => array(value, where).map((item, index) => read(item, `${where}[${index}]`))

export const strings = arrayOf(string)

// A table as a fresh one, each key held to `checkKey` and each item as
// `read` makes it; empty where it is left out.
export function tableOf(value, where, read, checkKey = (key) => key) {
  const map = Object.create(null)
  if (value !== undefined) for (const [key, item, here] of entries(value, where)) map[checkKey(key, here)] = read(item, here)
  return map
}

// The one of `keys` a table has.
export function oneOf(value, keys, where) {
  const found = keys.filter((key) => value[key] !== undefined)
  if (found.length !== 1) throw new LockfileError(`expected one of ${keys.join(', ')}, found ${found.length === 0 ? 'none' : found.join(' and ')}`, where)
  return found[0]
}

// A list with no `key` twice: the item that repeats one is refused.
export function distinct(list, where, key = (item) => item) {
  const seen = new Set()
  for (const [index, item] of list.entries()) {
    const id = key(item)
    if (seen.has(id)) throw new LockfileError(`${quote(id)} is listed twice`, `${where}[${index}]`)
    seen.add(id)
  }
  return list
}

// A check of a string, as `read` takes it, that `test` holds of: any other
// is refused as not `what`.
export const matching = (test, what, read = string) => (value, where) => {
  if (!test(read(value, where))) throw new LockfileError(`${quote(value)} is not ${what}`, where)
  return value
}

// A string as a tool writes one given to it, with nothing in it that is
// not shown: not empty, and no control character or line separator.
export function text(value, where) {
  if (string(value, where) === '' || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)) throw new LockfileError(`${quote(value)} is empty, or has a control character in it`, where)
  return value
}

// A size in bytes, or any count: an integer a number holds exactly.
export function size(value, where) {
  if (!Number.isSafeInteger(value) || value < 0) throw refuse('a non-negative integer', value, where)
  return value
}
