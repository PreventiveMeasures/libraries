// PEP 508: a project's name, its normal form, environment markers and
// requirements, as packaging reads them. A marker is checked for its
// grammar alone: each comparison of a variable and a quoted string, `and`,
// `or` and brackets. A check takes a value of a TOML lockfile, and refuses
// anything but a string as its readers do.

import { LockfileError, quote } from '../error.js'
import { string } from '../toml/shape.js'
import { isSpecifiers, trimBlanks } from './pep440.js'

// What a distribution's name may be, and the form PEP 503 makes of it, in
// which an extra's and a group's name are written too.
const NAME = /^(?:[a-z0-9]|[a-z0-9][a-z0-9._-]*[a-z0-9])$/iu
const NORMAL = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

export const isName = (name) => NAME.test(name)
export const normalName = (name) => name.toLowerCase().replace(/[-_.]+/gu, '-')

export function checkName(value, where) {
  if (!isName(string(value, where))) throw new LockfileError(`${quote(value)} is not a package name`, where)
  return value
}

export function checkNormalName(value, where) {
  if (!NORMAL.test(string(value, where))) {
    throw new LockfileError(isName(value) ? `${quote(value)} is not a name in normal form, ${quote(normalName(value))}` : `${quote(value)} is not a name`, where)
  }
  return value
}

// PEP 508's variables, with `extras` and `dependency_groups`, which
// pylock.toml's markers test.
const VARIABLES = new Set([
  'python_version', 'python_full_version', 'os_name', 'sys_platform', 'platform_release', 'platform_system', 'platform_version',
  'platform_machine', 'platform_python_implementation', 'implementation_name', 'implementation_version', 'extra', 'extras', 'dependency_groups',
])
const KEYWORDS = new Set(['and', 'or', 'in', 'not'])

const SPACE = /[ \t]*/uy
const TOKEN = /([()])|('[^']*'|"[^"]*")|(===|==|!=|<=|>=|~=|<|>)|([A-Za-z_][\w.]*)/uy
const MAX_DEPTH = 64

// Each token by its kind: a bracket, `string`, `op`, a keyword or `variable`.
function tokenize(text) {
  const tokens = []
  SPACE.lastIndex = 0
  while (SPACE.test(text) && SPACE.lastIndex < text.length) {
    TOKEN.lastIndex = SPACE.lastIndex
    const m = TOKEN.exec(text)
    if (m === null) return undefined
    SPACE.lastIndex = TOKEN.lastIndex
    const [, bracket, quoted, operator, word] = m
    if (bracket !== undefined) tokens.push(bracket)
    else if (quoted !== undefined) tokens.push('string')
    else if (operator !== undefined) tokens.push('op')
    else if (KEYWORDS.has(word)) tokens.push(word)
    else if (VARIABLES.has(word)) tokens.push('variable')
    else return undefined
  }
  return tokens
}

// marker_or, from tokens[pos], to the position past it, or -1.
function readOr(tokens, pos, depth) {
  let at = readAnd(tokens, pos, depth)
  while (at !== -1 && tokens[at] === 'or') at = readAnd(tokens, at + 1, depth)
  return at
}

function readAnd(tokens, pos, depth) {
  let at = readExpression(tokens, pos, depth)
  while (at !== -1 && tokens[at] === 'and') at = readExpression(tokens, at + 1, depth)
  return at
}

// A variable and a string, in either order.
const operands = (left, right) => (left === 'variable' && right === 'string') || (left === 'string' && right === 'variable')

function readExpression(tokens, pos, depth) {
  if (tokens[pos] === '(') {
    if (depth >= MAX_DEPTH) return -1
    const at = readOr(tokens, pos + 1, depth + 1)
    return at !== -1 && tokens[at] === ')' ? at + 1 : -1
  }
  const op = tokens[pos + 1]
  const width = op === 'op' || op === 'in' ? 1 : op === 'not' && tokens[pos + 2] === 'in' ? 2 : 0
  return width > 0 && operands(tokens[pos], tokens[pos + 1 + width]) ? pos + 1 + width + 1 : -1
}

export function isMarker(text) {
  const tokens = /[[\p{Cc}\p{Zl}\p{Zp}]--\t]/v.test(text) ? undefined : tokenize(text)
  return tokens !== undefined && tokens.length > 0 && readOr(tokens, 0, 0) === tokens.length
}

export function checkMarker(value, where) {
  if (!isMarker(string(value, where))) throw new LockfileError(`${quote(value)} is not an environment marker`, where)
  return value
}

// A requirement in PEP 508's text, as packaging reads it: a name, extras
// in brackets, then a version specifier, in brackets or not, or `@` and a
// URL, and `;` and a marker; after a URL, a space before the `;`.
const REQUIREMENT = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)[ \t]*(?:\[([^\]]*)\])?[ \t]*(.*)$/su

// The specifiers and the marker after a requirement's name and extras, each
// undefined where there is none; undefined where it does not read.
function readTail(tail) {
  if (tail.startsWith('@')) {
    const [, url, rest] = /^@[ \t]*([^ \t]*)(.*)$/su.exec(tail)
    if (!URL.canParse(url)) return undefined
    const marker = /^(?:[ \t]+;[ \t]*(.*))?$/su.exec(rest)
    return marker === null ? undefined : { specifiers: undefined, marker: marker[1] }
  }
  const sep = tail.indexOf(';')
  let specifiers = trimBlanks(sep === -1 ? tail : tail.slice(0, sep))
  if (specifiers.startsWith('(')) {
    if (!specifiers.endsWith(')')) return undefined
    specifiers = specifiers.slice(1, -1)
  }
  return { specifiers: specifiers === '' ? undefined : specifiers, marker: sep === -1 ? undefined : trimBlanks(tail.slice(sep + 1)) }
}

function isRequirement(text) {
  const m = REQUIREMENT.exec(text)
  if (m === null) return false
  const [, , extras, tail] = m
  if (extras !== undefined && trimBlanks(extras) !== '' && !extras.split(',').every((extra) => isName(trimBlanks(extra)))) return false
  const parts = readTail(tail)
  return parts !== undefined && (parts.specifiers === undefined || isSpecifiers(parts.specifiers)) && (parts.marker === undefined || isMarker(parts.marker))
}

export function checkRequirementText(value, where) {
  if (!isRequirement(string(value, where))) throw new LockfileError(`${quote(value)} is not a requirement`, where)
  return value
}
