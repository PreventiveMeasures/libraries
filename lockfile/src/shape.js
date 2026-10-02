// The shapes a lockfile's values come in, each checked where it is read.
// A mapping here is what the YAML parser hands back: an object with a null
// prototype, so a key is only ever a key.

import { LockfileError, at, quote } from './error.js'

const EMPTY = Object.freeze(Object.create(null))

export function kind(value) {
  if (value === undefined) return 'nothing'
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'a sequence'
  if (typeof value === 'object') return 'a mapping'
  if (typeof value === 'string') return `the string ${quote(value)}`
  return `the ${typeof value} ${String(value)}`
}

// The readers of a value of a primitive kind and of a mapping, refusing what
// else they are given as `describe` describes it: the YAML and JSON readers'
// here, TOML's in toml/shape.js, whose mapping is a table of keys.
export function primitives(describe, isMapping, noun, key) {
  const refuse = (expected, value, where) => new LockfileError(`expected ${expected}, found ${describe(value)}`, where)
  const check = (test, expected) => (value, where) => {
    if (!test(value)) throw refuse(expected, value, where)
    return value
  }
  // A mapping with only the `fields` named, when named: any other key is
  // one this reader does not know the meaning of, and it is refused rather
  // than dropped. `refused` names a key with the reason it is not read.
  const record = (value, where, fields, refused = {}) => {
    if (!isMapping(value)) throw refuse(noun, value, where)
    for (const name of fields === undefined ? [] : Object.keys(value)) {
      if (Object.hasOwn(refused, name)) throw new LockfileError(refused[name], at(where ?? '', name))
      if (!fields.includes(name)) throw new LockfileError(`unsupported ${key} ${quote(name)}`, where)
    }
    return value
  }
  return {
    refuse,
    record,
    // A mapping's entries, each with where it is.
    entries: (value, where) => Object.entries(record(value, where)).map(([name, item]) => [name, item, at(where, name)]),
    string: check((value) => typeof value === 'string', 'a string'),
    boolean: check((value) => typeof value === 'boolean', 'true or false'),
    // A size in bytes, or any count: an integer a number holds exactly.
    count: check((value) => Number.isSafeInteger(value) && value >= 0, 'a non-negative integer'),
  }
}

const isMapping = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
export const { refuse, record, entries, string, boolean, count } = primitives(kind, isMapping, 'a mapping', 'field')

// A mapping that may be left out, as an empty one then. A null is not left
// out, and whatever reads it as a mapping refuses it.
export const orEmpty = (value) => (value === undefined ? EMPTY : value)

// A reader of a value that may be left out: undefined, or what `read`
// makes of it.
export const optional = (read) => (value, where) => (value === undefined ? undefined : read(value, where))

// A field of `holder` that may be left out, so read.
export const field = (holder, key, where, read) => optional(read)(holder[key], at(where, key))

export function text(value, where) {
  if (string(value, where) === '') throw new LockfileError('expected a non-empty string', where)
  return value
}

// A list of non-empty strings, as a fresh array; `check` holds each to more
// than that.
export function texts(value, where, check = (item) => item) {
  if (!Array.isArray(value)) throw refuse('a sequence', value, where)
  return value.map((item, index) => check(text(item, `${where}[${index}]`), `${where}[${index}]`))
}

// A mapping, as a fresh one of what `read(item, where, key)` makes of each.
export function mapping(value, where, read) {
  const map = Object.create(null)
  for (const [key, item, here] of entries(value, where)) map[key] = read(item, here, key)
  return map
}

// A mapping of strings to strings, as a fresh mapping; `check` holds each
// key to more than being a string.
export const textMap = (value, where, check = () => {}) => mapping(value, where, (item, here, key) => {
  check(key, here)
  return string(item, here)
})

// A flag written only where it is set: `true`, or absent.
export function flag(value, where) {
  if (value !== undefined && value !== true) throw refuse('true', value, where)
  return value === true
}

// A check of a string `read` reads that `is` holds, refusing any other as
// not `what`.
export const checkerOf = (read) => (is, what) => (value, where) => {
  if (!is(read(value, where))) throw new LockfileError(`${quote(value)} is not ${what}`, where)
  return value
}

// The options object a reader takes, of the `names` alone.
export function checkOptions(options, names) {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) throw new TypeError('expected an options object')
  const unknown = Object.keys(options).find((key) => !names.includes(key))
  if (unknown !== undefined) throw new TypeError(`unknown option ${quote(unknown)}, of ${names.join(', ')}`)
  return options
}

// `checkVersions`, on by default, and the semver package it needs, which
// has the `functions` named; whether to check versions.
export function checkSemver({ checkVersions = true, semver }, functions) {
  if (typeof checkVersions !== 'boolean') throw new TypeError('checkVersions: expected a boolean')
  if (semver !== undefined && !functions.every((name) => typeof semver?.[name] === 'function')) {
    throw new TypeError(`semver: expected the semver package, with ${functions.join(', ')}`)
  }
  if (checkVersions && semver === undefined) throw new TypeError('checkVersions needs semver: pass it as semver, or set checkVersions to false')
  return checkVersions
}
