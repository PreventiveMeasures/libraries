// The shapes a value parseToml hands back comes in, each checked where it
// is read, for the readers of Cargo.lock, uv.lock, poetry.lock and
// pylock.toml. A table has a null prototype, so a key is only ever a key.

import { LockfileError, quote } from '../error.js'
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

// A table with only the `fields` named, when named; `refused` names a key
// with the reason it is not read.
export const { refuse, record: table, entries, string, boolean, count: size } = primitives(kind, isTable, 'a table', 'key')

export function array(value, where) {
  if (!Array.isArray(value)) throw refuse('an array', value, where)
  return value
}


// A string as a tool writes one given to it, with nothing in it that is
// not shown: not empty, and no control character or line separator.
export function text(value, where) {
  if (string(value, where) === '' || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)) throw new LockfileError(`${quote(value)} is empty, or has a control character in it`, where)
  return value
}

// A check of a string `is` holds, refusing any other as not `what`.
export const checker = (is, what) => (value, where) => {
  if (!is(string(value, where))) throw new LockfileError(`${quote(value)} is not ${what}`, where)
  return value
}

// Each item of an array, as `read(item, where)` makes it.
export const arrayOf = (read) => (value, where) => array(value, where).map((item, index) => read(item, `${where}[${index}]`))

// Strings, each held to `check` where given, as `check(item, where)` does.
export const stringsOf = (check = string) => arrayOf((item, here) => check(string(item, here), here))
export const strings = (value, where, check) => stringsOf(check)(value, where)

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
