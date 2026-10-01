import { parseVersion } from '../crate/semver.js'
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

// As cargo takes names, less what is not ASCII.
export function checkCrateName(value, where) {
  if (!/^[A-Z_a-z][\w-]*$/u.test(string(value, where))) throw new LockfileError(`${quote(value)} is not a package name`, where)
  return value
}

export function checkCrateVersion(value, where) {
  if (parseVersion(string(value, where)) === undefined) throw new LockfileError(`${quote(value)} is not a version`, where)
  return value
}

export function checkFeature(value, where) {
  if (!/^\w[\w+.-]*$/u.test(string(value, where))) throw new LockfileError(`${quote(value)} is not a feature name`, where)
  return value
}
