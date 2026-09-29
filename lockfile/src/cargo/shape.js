// The shapes a Cargo.toml or Cargo.lock value comes in, as parseToml reads
// them, each checked where it is read; and the names cargo takes.

import { LockfileError, at, quote } from '../error.js'
import { TomlDateTime } from '../toml/datetime.js'
import { TomlFloat } from '../toml/number.js'
import { isTable } from '../toml/value.js'

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

// A table with only the `fields` named, when named: any other key is one
// this reader does not know the meaning of, and it is refused rather than
// dropped.
export function table(value, where, fields) {
  if (!isTable(value)) throw refuse('a table', value, where)
  for (const key of fields === undefined ? [] : Object.keys(value)) {
    if (!fields.includes(key)) throw new LockfileError(`unsupported key ${quote(key)}`, where)
  }
  return value
}

// A table's entries, each with where it is.
export const entries = (value, where) => Object.entries(table(value, where)).map(([key, item]) => [key, item, at(where, key)])

export function string(value, where) {
  if (typeof value !== 'string') throw refuse('a string', value, where)
  return value
}

export function boolean(value, where) {
  if (typeof value !== 'boolean') throw refuse('true or false', value, where)
  return value
}

export function strings(value, where) {
  if (!Array.isArray(value)) throw refuse('an array', value, where)
  return value.map((item, index) => string(item, `${where}[${index}]`))
}

export const optional = (read) => (value, where) => (value === undefined ? undefined : read(value, where))

// A package's name, and a dependency's, as cargo takes them, less what is
// not ASCII: a letter or `_`, then letters, digits, `_` and `-`.
export function checkName(value, where) {
  if (!/^[A-Z_a-z][\w-]*$/u.test(string(value, where))) throw new LockfileError(`${quote(value)} is not a package name`, where)
  return value
}

// A feature's name, likewise: a letter, a digit or `_`, then those and
// `-`, `+` and `.`.
export function checkFeature(value, where) {
  if (!/^\w[\w+.-]*$/u.test(string(value, where))) throw new LockfileError(`${quote(value)} is not a feature name`, where)
  return value
}
