// The shapes a lockfile's values come in, each checked where it is read.
// A mapping here is what the YAML parser hands back: an object with a null
// prototype, so a key is only ever a key.

import { LockfileError, at, quote } from './error.js'

export const EMPTY = Object.freeze(Object.create(null))

export function kind(value) {
  if (value === undefined) return 'nothing'
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'a sequence'
  if (typeof value === 'object') return 'a mapping'
  if (typeof value === 'string') return `the string ${quote(value)}`
  return `the ${typeof value} ${String(value)}`
}

const refuse = (expected, value, where) => new LockfileError(`expected ${expected}, found ${kind(value)}`, where)

// A mapping with only the `fields` named, when named: any other key is one
// this reader does not know the meaning of, and it is refused rather than
// dropped.
export function record(value, where, fields) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw refuse('a mapping', value, where)
  if (fields === undefined) return value
  for (const key of Object.keys(value)) {
    if (!fields.includes(key)) throw new LockfileError(`unsupported field ${quote(key)}`, where)
  }
  return value
}

// A mapping's entries, each with where it is.
export const entries = (value, where) => Object.entries(record(value, where)).map(([key, item]) => [key, item, at(where, key)])

export function string(value, where) {
  if (typeof value !== 'string') throw refuse('a string', value, where)
  return value
}

export function text(value, where) {
  if (string(value, where) === '') throw new LockfileError('expected a non-empty string', where)
  return value
}

// A list of non-empty strings, as a fresh array.
export function texts(value, where) {
  if (!Array.isArray(value)) throw refuse('a sequence', value, where)
  return value.map((item, index) => text(item, `${where}[${index}]`))
}

// A mapping of strings to strings, as a fresh mapping; `check` holds each
// key to more than being a string.
export function textMap(value, where, check = () => {}) {
  const map = Object.create(null)
  for (const [key, item, here] of entries(value, where)) {
    check(key, here)
    map[key] = string(item, here)
  }
  return map
}

export function boolean(value, where) {
  if (typeof value !== 'boolean') throw refuse('true or false', value, where)
  return value
}

// A flag pnpm writes only when it is set: `true`, or absent.
export function flag(value, where) {
  if (value !== undefined && value !== true) throw refuse('true', value, where)
  return value === true
}

export function count(value, where) {
  if (!Number.isSafeInteger(value) || value < 0) throw refuse('a non-negative integer', value, where)
  return value
}
