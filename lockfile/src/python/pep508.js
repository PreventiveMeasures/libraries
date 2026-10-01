// PEP 508: a project's name, its normal form, and environment markers, as
// packaging reads them. A marker is checked for its grammar alone: each
// comparison of a variable and a quoted string, `and`, `or` and brackets.

import { LockfileError, quote } from '../error.js'
import { checkSpecifiers } from './pep440.js'

// What a distribution's name may be, and the form PEP 503 makes of it, in
// which an extra's and a group's name are written too.
const NAME = /^(?:[a-z0-9]|[a-z0-9][a-z0-9._-]*[a-z0-9])$/iu
const NORMAL = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

export const isName = (name) => NAME.test(name)
export const normalName = (name) => name.toLowerCase().replace(/[-_.]+/gu, '-')

export function checkName(value, where) {
  if (!isName(value)) throw new LockfileError(`${quote(value)} is not a package name`, where)
  return value
}

export function checkNormalName(value, where) {
  if (!NORMAL.test(value)) {
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

const SPACE = /[ \t]*/uy
const TOKEN = /([()])|('[^']*'|"[^"]*")|(===|==|!=|<=|>=|~=|<|>)|([A-Za-z_][\w.]*)/uy
const MAX_DEPTH = 64

function tokenize(text) {
  const tokens = []
  SPACE.lastIndex = 0
  while (SPACE.test(text) && SPACE.lastIndex < text.length) {
    TOKEN.lastIndex = SPACE.lastIndex
    const m = TOKEN.exec(text)
    if (m === null) return undefined
    SPACE.lastIndex = TOKEN.lastIndex
    const [, bracket, string, operator, word] = m
    if (bracket !== undefined) tokens.push({ type: bracket })
    else if (string !== undefined) tokens.push({ type: 'string' })
    else if (operator !== undefined) tokens.push({ type: 'op' })
    else if (word === 'and' || word === 'or' || word === 'in' || word === 'not') tokens.push({ type: word })
    else if (VARIABLES.has(word)) tokens.push({ type: 'variable' })
    else return undefined
  }
  return tokens
}

// marker_or, from tokens[pos], to the position past it, or -1.
function readOr(tokens, pos, depth) {
  let at = readAnd(tokens, pos, depth)
  while (at !== -1 && tokens[at]?.type === 'or') at = readAnd(tokens, at + 1, depth)
  return at
}

function readAnd(tokens, pos, depth) {
  let at = readExpression(tokens, pos, depth)
  while (at !== -1 && tokens[at]?.type === 'and') at = readExpression(tokens, at + 1, depth)
  return at
}

function readExpression(tokens, pos, depth) {
  if (tokens[pos]?.type === '(') {
    if (depth >= MAX_DEPTH) return -1
    const at = readOr(tokens, pos + 1, depth + 1)
    return at !== -1 && tokens[at]?.type === ')' ? at + 1 : -1
  }
  const [left, op, right] = [tokens[pos]?.type, tokens[pos + 1]?.type, tokens[pos + 2]?.type]
  const operands = (left === 'variable' && right === 'string') || (left === 'string' && right === 'variable')
  if (op === 'op' || op === 'in') return operands ? pos + 3 : -1
  if (op === 'not' && right === 'in' && (left === 'variable' || left === 'string')) {
    const last = tokens[pos + 3]?.type
    return (left === 'variable' && last === 'string') || (left === 'string' && last === 'variable') ? pos + 4 : -1
  }
  return -1
}

export function checkMarker(value, where) {
  const tokens = /[[\p{Cc}\p{Zl}\p{Zp}]--\t]/v.test(value) ? undefined : tokenize(value)
  if (tokens === undefined || tokens.length === 0 || readOr(tokens, 0, 0) !== tokens.length) {
    throw new LockfileError(`${quote(value)} is not an environment marker`, where)
  }
  return value
}

// A requirement in PEP 508's text, as packaging reads it: a name, extras
// in brackets, then a version specifier, in brackets or not, or `@` and a
// URL, and `;` and a marker; after a URL, a space before the `;`.
const REQUIREMENT = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)[ \t]*(?:\[([^\]]*)\])?[ \t]*(.*)$/su

function readTail(tail) {
  if (tail.startsWith('@')) {
    const [, url, rest] = /^@[ \t]*([^ \t]*)(.*)$/su.exec(tail)
    if (!URL.canParse(url)) return undefined
    const marker = /^(?:[ \t]+;[ \t]*(.*))?$/su.exec(rest)
    return marker === null ? undefined : { specifiers: undefined, marker: marker[1] }
  }
  const sep = tail.indexOf(';')
  let specifiers = (sep === -1 ? tail : tail.slice(0, sep)).replace(/[ \t]+$/u, '')
  if (specifiers.startsWith('(')) specifiers = specifiers.endsWith(')') ? specifiers.slice(1, -1) : '('
  return { specifiers: specifiers === '' ? undefined : specifiers, marker: sep === -1 ? undefined : tail.slice(sep + 1).replace(/^[ \t]+/u, '') }
}

export function checkRequirementText(value, where) {
  const fail = () => {
    throw new LockfileError(`${quote(value)} is not a requirement`, where)
  }
  const [, , extras, tail] = REQUIREMENT.exec(value) ?? fail()
  if (extras !== undefined && extras.trim() !== '' && !extras.split(',').every((extra) => isName(extra.replace(/^[ \t]+|[ \t]+$/gu, '')))) fail()
  const { specifiers, marker } = readTail(tail) ?? fail()
  if (specifiers !== undefined && !passes(checkSpecifiers, specifiers)) fail()
  if (marker !== undefined && !passes(checkMarker, marker)) fail()
  return value
}

// Whether `check` takes `value`, a refusal of it the answer no.
function passes(check, value) {
  try {
    check(value)
    return true
  } catch (error) {
    if (error instanceof LockfileError) return false
    throw error
  }
}
