// What is made of the values of a podspec in the form podspec-read.js reads: `+` and `-`, the comparisons, and
// the few methods of a value that are read.

import { changed, fail, text } from './podspec-parse.js'
import { compareVersions } from './targets.js'

const isList = Array.isArray
const isText = (value) => typeof value === 'string'
const isHash = (value) => value instanceof Map
const bytes = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))

// `+`, of two strings or two lists; and `-`, of two lists, the first without what the second has.
export function plus(p, value, other, token) {
  if (token.type === '-') return [value, other].every((side) => isList(side) && side.every(isText)) ? value.filter((item) => !other.includes(item)) : fail(p, 'a `-` of what is not two lists of text', token)
  if (isText(value) && isText(other)) return value + other
  return isList(value) && isList(other) ? [...value, ...other] : fail(p, 'a `+` of what is not two strings or two lists', token)
}

// `<`, `<=`, `>` and `>=`, of two whole numbers, or of two versions, `Gem::Version.new(...)`.
export function ordered(p, value, other, token) {
  const versions = [value, other].every((side) => isText(side?.version))
  if (!versions && ![value, other].every(Number.isSafeInteger)) fail(p, `a \`${token.type}\` of what is not two numbers or two versions`, token)
  const order = versions ? compareVersions(value.version, other.version) : value - other
  return { '<': order < 0, '<=': order <= 0, '>': order > 0, '>=': order >= 0 }[token.type]
}

// A list joined as Ruby joins it: a list in it joined in its place.
const joined = (p, value, by) => value.map((one) => (isList(one) ? joined(p, one, by) : text(p, one))).join(by)
// `concat`, `append` and `merge!`, which change what they are of.
function concat(p, value, items) {
  changed(p)
  value.push(...items)
  return value
}
function merge(p, value, others, into = value) {
  if (into === value) changed(p)
  for (const other of others) for (const [key, item] of other) into.set(key, item)
  return into
}
// String#to_i: the whole number a text begins with, or 0.
const whole = (value) => Number(/^[ \t\n\v\f\r]*([-+]?\d+)/u.exec(value)?.[1] ?? 0)

// The methods of a value that are read: each gives the value it makes of one, and of what it is called with,
// or undefined where these are not what it takes. Some change the value they are of.
export const METHODS = {
  to_s: (p, value, args) => (args.length === 0 ? text(p, value) : undefined),
  to_i: (p, value, args) => (args.length === 0 && (value === null || isText(value) || Number.isSafeInteger(value)) ? (isText(value) ? whole(value) : value ?? 0) : undefined),
  freeze: (p, value) => value,
  'nil?': (p, value, args) => (args.length === 0 ? value === null : undefined),
  'empty?': (p, value, args) => (args.length === 0 && (isText(value) || isList(value) || isHash(value)) ? (value.length ?? value.size) === 0 : undefined),
  'include?': (p, value, args) => (args.length === 1 && (isList(value) || (isText(value) && isText(args[0]))) ? value.includes(args[0]) : undefined),
  strip: (p, value, args) => (isText(value) && args.length === 0 ? value.replace(/^[\t\n\v\f\r ]+/u, '').replace(/[\t\n\v\f\r \0]+$/u, '') : undefined),
  sort: (p, value, args) => (isList(value) && value.every(isText) && args.length === 0 ? [...value].sort(bytes) : undefined),
  compact: (p, value, args) => (isList(value) && args.length === 0 ? value.filter((item) => item !== null) : undefined),
  join: (p, value, args) => (isList(value) && args.length <= 1 && isText(args[0] ?? '') ? joined(p, value, args[0] ?? '') : undefined),
  concat: (p, value, args) => (isList(value) && args.every(isList) ? concat(p, value, args.flat()) : undefined),
  append: (p, value, args) => (isList(value) ? concat(p, value, args) : undefined),
  push: (p, value, args) => (isList(value) ? concat(p, value, args) : undefined),
  merge: (p, value, args) => (isHash(value) && args.every(isHash) ? merge(p, value, args, new Map(value)) : undefined),
  'merge!': (p, value, args) => (isHash(value) && args.every(isHash) ? merge(p, value, args) : undefined),
}
