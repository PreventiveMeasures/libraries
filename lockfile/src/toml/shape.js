// The shapes a value parseToml hands back comes in, each checked where it
// is read, for the readers of Cargo.lock, uv.lock, poetry.lock and
// pylock.toml. A table has a null prototype, so a key is only ever a key.

import { LockfileError, at, quote } from '../error.js'
import { primitives } from '../shape.js'
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

export const { refuse, string, boolean, count: size } = primitives(kind)

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

export function array(value, where) {
  if (!Array.isArray(value)) throw refuse('an array', value, where)
  return value
}

// Strings, each held to `check` where given, as `check(item, where)` does.
export function strings(value, where, check = string) {
  return array(value, where).map((item, index) => check(string(item, `${where}[${index}]`), `${where}[${index}]`))
}

// A string as a tool writes one given to it, with nothing in it that is
// not shown: not empty, and no control character or line separator.
export function text(value, where) {
  if (string(value, where) === '' || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)) throw new LockfileError(`${quote(value)} is empty, or has a control character in it`, where)
  return value
}

// Each item of an array, as `read(item, where)` makes it.
export const arrayOf = (read) => (value, where) => array(value, where).map((item, index) => read(item, `${where}[${index}]`))

// Strings, each held to `check`.
export const stringsOf = (check) => (value, where) => strings(value, where, check)

// A table that may be left out, as an empty one then, of keys `checkKey`
// holds, each item as `read(item, where)` makes it.
export function tableOf(value, where, checkKey, read) {
  const map = Object.create(null)
  if (value !== undefined) for (const [key, item, here] of entries(value, where)) map[checkKey(key, here)] = read(item, here)
  return map
}

// The one of `keys` a table has, where it has exactly one.
export function oneOf(value, keys, where) {
  const found = keys.filter((key) => value[key] !== undefined)
  if (found.length !== 1) throw new LockfileError(`expected one of ${keys.join(', ')}, found ${found.length === 0 ? 'none' : found.join(' and ')}`, where)
  return found[0]
}

// Each of a lockfile's `package` array once, by what `idOf` makes of it,
// `shown` as it says; the index of each by that.
export function checkListedOnce(packages, idOf, shown) {
  const seen = new Map()
  for (const [index, pkg] of packages.entries()) {
    const id = idOf(pkg)
    if (seen.has(id)) throw new LockfileError(`${quote(shown(pkg))} is listed twice, first as package[${seen.get(id)}]`, `package[${index}]`)
    seen.set(id, index)
  }
  return seen
}
