// The values of a podspec read without Ruby: literals, the few names and calls it may read, and conditions over
// them. Both sides of a `&&`, a `||` and a `?:` are read, so one that is refused refuses the podspec.

import { call, defined, environment, global, helper, isHelper } from './calls.js'
import { PLATFORMS, SYMBOL } from './json.js'
import { METHODS, ordered, plus } from './methods.js'
import { expect, fail, is, next, peek, skipLines, text, truthy, untaken } from './parse.js'
import { tokenize } from './tokens.js'

export const PROXIES = new Set([...PLATFORMS, 'macos'])

export function list(p, close) {
  const items = []
  for (skipLines(p); !is(p, close); skipLines(p)) {
    items.push(expression(p))
    skipLines(p)
    if (!is(p, close)) expect(p, ',')
  }
  next(p)
  return items
}

// `key => value, key: value` to `close`, of a hash or a call; a call's leading values without a key go to `args`.
function pairs(p, close, args) {
  const byName = new Map()
  for (skipLines(p); !is(p, close); skipLines(p)) {
    const shorthand = (is(p, 'name') || is(p, 'string')) && p.tokens[p.at + 1].type === ':'
    const key = shorthand && is(p, 'name') ? next(p).value : expression(p)
    if (args !== undefined && byName.size === 0 && !shorthand && !is(p, '=>')) args.push(key)
    else {
      expect(p, shorthand ? ':' : '=>')
      skipLines(p)
      byName.set(text(p, key), expression(p))
    }
    skipLines(p)
    if (!is(p, close)) expect(p, ',')
  }
  next(p)
  return byName
}

export function interpolate(p, parts) {
  return parts.map((part) => {
    if (typeof part === 'string') return part
    const inner = { ...p, tokens: tokenize(part.code, p.where, part.line), at: 0 }
    const value = expression(inner)
    if (!is(inner, 'newline')) fail(inner, 'an interpolation of more than a value')
    return text(p, value)
  }).join('')
}

// `s.name`, `s.version` and `s.respond_to?(:platform)`.
function ofSpec(p, token) {
  expect(p, '.')
  const attribute = expect(p, 'name').value
  if (attribute === 'respond_to?') {
    expect(p, '(')
    const platform = expect(p, 'symbol').value
    expect(p, ')')
    return PROXIES.has(platform) ? true : fail(p, `\`respond_to?\` of \`${platform}\``, token)
  }
  const value = p.specs.get(token.value).attributes.get(attribute)
  return (attribute === 'name' || attribute === 'version') && typeof value === 'string' ? value : fail(p, `\`${token.value}.${attribute}\` read`, token)
}

// `Pod::VERSION`, the lockfile's CocoaPods; and `Gem::Version.new(text)`.
function constant(p, token) {
  expect(p, '::')
  const name = expect(p, 'name').value
  if (token.value === 'Pod' && name === 'VERSION' && typeof p.context.cocoapods === 'string') return p.context.cocoapods
  if (token.value !== 'Gem' || name !== 'Version') return fail(p, `\`${token.value}::${name}\``, token)
  expect(p, '.')
  expect(p, 'name', 'new')
  expect(p, '(')
  const [version, ...more] = list(p, ')')
  return typeof version === 'string' && more.length === 0 ? { version } : fail(p, 'a version of what is no text', token)
}

function named(p, token) {
  const name = token.value
  if (name === 'true' || name === 'false') return name === 'true'
  if (name === 'nil') return null
  if (name === '__dir__') return p.dir
  if (name === '__FILE__') return p.path
  if (name === 'File' || name === 'JSON' || name === 'Dir') {
    expect(p, '.')
    const method = expect(p, 'name').value
    expect(p, '(')
    return call(p, name, method, list(p, ')'))
  }
  if (name === 'ENV') {
    // `ENV['NAME']`, and `ENV.include?('NAME')`.
    const asks = is(p, '.') && ['include?', 'key?', 'has_key?'].includes(p.tokens[p.at + 1].value)
    if (asks) p.at += 2
    expect(p, asks ? '(' : '[')
    const [key, ...more] = list(p, asks ? ')' : ']')
    const value = typeof key === 'string' && more.length === 0 ? environment(p, key, token) : fail(p, 'a variable of the environment whose name is no text', token)
    return asks ? value !== null : value
  }
  if (name === 'Pod' || name === 'Gem') return constant(p, token)
  // A specification is a value only as what a helper is called with.
  if (p.specs.has(name)) return is(p, '.') ? ofSpec(p, token) : p.specs.get(name)
  if (p.locals.has(name)) return p.locals.get(name)
  if (name === 'defined?' || name === 'respond_to?') return defined(p, token)
  // A helper, or one of a class: `Class.helper(...)`.
  const of = is(p, '.') && isHelper(`${name}.${p.tokens[p.at + 1].value}`) ? { ...token, value: `${name}.${p.tokens[p.at + 1].value}` } : token
  if (!isHelper(of.value)) return fail(p, `\`${name}\``, token)
  if (of !== token) p.at += 2
  const args = []
  const parenthesized = is(p, '(')
  if (parenthesized) next(p)
  return helper(p, of, args, parenthesized ? pairs(p, ')', args) : new Map())
}

function primary(p) {
  const token = next(p)
  switch (token.type) {
    case 'string': return interpolate(p, token.parts)
    case 'symbol': return SYMBOL + token.value
    case 'number': case 'words': return token.value
    case '[': return list(p, ']')
    case '{': return pairs(p, '}')
    case '(': {
      const value = expression(p)
      expect(p, ')')
      return value
    }
    case 'name': return named(p, token)
    case 'global': return global(p, token)
    default: return fail(p, `\`${token.value ?? token.type}\``, token)
  }
}

function postfix(p) {
  let value = primary(p)
  for (;;) {
    if (is(p, '[') && peek(p).line === p.tokens[p.at - 1].line) {
      next(p)
      const key = expression(p)
      expect(p, ']')
      if (value instanceof Map) value = value.get(text(p, key)) ?? null
      else if (Array.isArray(value) && typeof key === 'number') value = value.at(key) ?? null
      else fail(p, 'an index of what is no hash or list')
    } else if ((is(p, '.') || is(p, '&.')) && Object.hasOwn(METHODS, p.tokens[p.at + 1].value)) {
      // `&.` calls nothing on nil, but its arguments are read all the same.
      const safe = next(p).type === '&.'
      const method = next(p)
      const parenthesized = is(p, '(')
      if (parenthesized) next(p)
      const args = parenthesized ? list(p, ')') : []
      if (!safe || value !== null) value = METHODS[method.value](p, value, args) ?? fail(p, `\`${method.value}\` of what it is not of, or with what it does not take`, method)
    } else return value
  }
}

function unary(p) {
  if (!is(p, '!')) return postfix(p)
  next(p)
  return !truthy(unary(p))
}

export function sum(p) {
  let value = unary(p)
  while (is(p, '+') || is(p, '-')) {
    const at = next(p)
    value = plus(p, value, unary(p), at)
  }
  return value
}

function compared(p) {
  const value = sum(p)
  if (!['<', '<=', '>', '>='].includes(peek(p).type)) return value
  const operator = next(p)
  return ordered(p, value, sum(p), operator)
}

// `==` and `!=`, of texts, symbols, numbers, true, false and nil alone, which are told apart as Ruby does.
function equal(p) {
  const value = compared(p)
  if (!is(p, '==') && !is(p, '!=')) return value
  const operator = next(p)
  const other = compared(p)
  const told = [value, other].every((side) => side === null || typeof side !== 'object')
  return told ? (value === other) === (operator.type === '==') : fail(p, `a \`${operator.type}\` of what is no text, symbol, number, true, false or nil`, operator)
}

// `&&` and `||`, each giving one of its sides, as Ruby's do.
function logical(p, operator, operand) {
  let value = operand(p)
  while (is(p, operator)) {
    const token = next(p)
    skipLines(p)
    const before = p.state.changes
    const other = operand(p)
    if (truthy(value) === (operator === '&&')) value = other
    else untaken(p, p.state.changes !== before, token)
  }
  return value
}
const both = (p) => logical(p, '&&', equal)

export function expression(p) {
  const value = logical(p, '||', both)
  if (!is(p, '?')) return value
  const token = next(p)
  skipLines(p)
  const before = p.state.changes
  const held = expression(p)
  const between = p.state.changes
  expect(p, ':')
  skipLines(p)
  const other = expression(p)
  untaken(p, truthy(value) ? p.state.changes !== between : between !== before, token)
  return truthy(value) ? held : other
}
