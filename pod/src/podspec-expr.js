// The values of a podspec in the form podspec-read.js reads: literals, the few names and calls it may read, and
// the conditions over them, a variable of the environment among those. Reading one changes nothing, so both
// sides of a `&&`, a `||` and a `?:` are read, and one that is refused refuses the podspec.

import { basename, dirname, isAbsolute, resolve } from 'node:path'

import { PodError } from './error.js'
import { PLATFORMS } from './podspec-json.js'
import { KNOWN, reactNative } from './podspec-rn.js'
import { tokenize } from './podspec-tokens.js'

export const PROXIES = new Set([...PLATFORMS, 'macos'])
// React Native's helpers for podspecs, scripts/react_native_pods.rb's, that are read: the one called, and those
// that are values.
const HELPERS = new Set(['install_modules_dependencies', 'min_ios_version_supported'])

export const peek = (p) => p.tokens[p.at]
export const next = (p) => p.tokens[p.at++]
export const is = (p, type, value) => peek(p).type === type && (value === undefined || peek(p).value === value)
export function fail(p, what, token = peek(p)) {
  throw new PodError(`line ${token.line}: ${what}, which is not in the form of a podspec that is read without Ruby`, p.where)
}
export function expect(p, type, value) {
  if (!is(p, type, value)) fail(p, `\`${peek(p).value ?? peek(p).type}\` where \`${value ?? type}\` is expected`)
  return next(p)
}
export const skipLines = (p) => {
  while (is(p, 'newline') || is(p, ';')) next(p)
}
// What holds, to Ruby: all but nil and false.
export const truthy = (value) => value !== null && value !== false

// React Native's helpers as the version the lockfile has it at has them, for `what` of the podspec, which is
// refused where that is no version they are known of.
export function reactNativeOf(p, token, what) {
  const version = p.context.reactNative
  const helpers = version === undefined ? undefined : reactNative(version)
  if (helpers !== undefined) return helpers
  throw new PodError(`line ${token.line}: ${what}, which is known only of React Native ${KNOWN}: the lockfile has ${version === undefined ? 'no React-Core' : `React-Core at ${version}`}`, p.where)
}

// `ENV['NAME']`: what pod.config.json's `env` gives, null for one that is not set; else what the lockfile's
// React Native leaves there once a Podfile's use_react_native! has run, and not set where it has none.
export function environment(p, name, token) {
  let value = null
  if (p.context.env.has(name)) value = p.context.env.get(name)
  else if (p.context.reactNative !== undefined) {
    const helpers = reactNativeOf(p, token, `\`ENV['${name}']\` is not given by pod.config.json's \`env\`, and is then as React Native leaves it`)
    if (helpers.podfile.has(name)) throw new PodError(`line ${token.line}: \`ENV['${name}']\` is as the Podfile had it, which pod.config.json's \`env\` has to give`, p.where)
    value = helpers.env(p.context)[name] ?? null
  }
  p.env.set(name, value)
  return value
}

// A value as Ruby's to_s has it in a string.
export function text(p, value) {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  if (value === null) return ''
  return typeof value === 'boolean' ? String(value) : fail(p, 'a list or a hash in a string')
}

// A hash of a package.json as a podspec reads it: its keys in their order. One whose keys are numbers, which
// JSON.parse puts first, is refused.
function fromJson(p, value) {
  if (Array.isArray(value)) return value.map((item) => fromJson(p, item))
  if (value === null || typeof value !== 'object') return value
  if (Object.keys(value).some((key) => /^(?:0|[1-9]\d*)$/u.test(key))) fail(p, 'a package.json with a number for a key')
  return new Map(Object.entries(value).map(([key, item]) => [key, fromJson(p, item)]))
}

function readJson(p, path) {
  const file = isAbsolute(path) ? resolve(path) : resolve(p.dir, path)
  if (basename(file) !== 'package.json') fail(p, 'a file read that is no package.json')
  const content = p.read(file)
  if (content === undefined) throw new PodError(`its podspec reads ${file}, which is not there`, p.where)
  return content
}

// The calls a podspec may make: File's, of paths, and JSON.parse.
function call(p, receiver, method, args) {
  const strings = args.every((arg) => typeof arg === 'string')
  if (receiver === 'File' && method === 'join' && strings) return args.join('/').replaceAll(/\/+/gu, '/')
  if (receiver === 'File' && method === 'dirname' && strings && args.length === 1) return dirname(args[0])
  if (receiver === 'File' && method === 'expand_path' && strings && args.length <= 2) return resolve(args[1] ?? p.dir, args[0])
  if (receiver === 'File' && method === 'read' && strings && args.length === 1) return { file: readJson(p, args[0]) }
  if (receiver === 'JSON' && method === 'parse' && args.length === 1 && typeof args[0]?.file === 'string') {
    try {
      return fromJson(p, JSON.parse(args[0].file))
    } catch (error) {
      if (error instanceof PodError) throw error
      throw new PodError('its podspec reads a package.json that is not JSON', p.where, { cause: error })
    }
  }
  return fail(p, `the call \`${receiver}.${method}\``)
}

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

// `{ key => value, key: value }`.
function hash(p) {
  const pairs = new Map()
  for (skipLines(p); !is(p, '}'); skipLines(p)) {
    const shorthand = (is(p, 'name') || is(p, 'string')) && p.tokens[p.at + 1].type === ':'
    const key = shorthand && is(p, 'name') ? next(p).value : expression(p)
    expect(p, shorthand ? ':' : '=>')
    skipLines(p)
    pairs.set(text(p, key), expression(p))
    skipLines(p)
    if (!is(p, '}')) expect(p, ',')
  }
  next(p)
  return pairs
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

// `defined?(name)` and `respond_to?(:name, true)`, of one of React Native's helpers: whether the Podfile had
// it, which is whether the lockfile has React Native.
function defined(p, token) {
  const responds = token.value === 'respond_to?'
  const parenthesized = is(p, '(')
  if (parenthesized) next(p)
  const name = expect(p, responds ? 'symbol' : 'name').value
  if (responds) {
    // A helper is a private method, which respond_to? has only where it is told to.
    expect(p, ',')
    expect(p, 'name', 'true')
  } else if (is(p, '(')) {
    next(p)
    expect(p, ')')
  }
  if (parenthesized) expect(p, ')')
  if (!HELPERS.has(name)) fail(p, `\`${token.value}\` of \`${name}\``, token)
  if (p.context.reactNative === undefined) return responds ? false : null
  reactNativeOf(p, token, `\`${name}\` is React Native's`)
  return responds ? true : 'method'
}

// What a specification is read of: its name and its version, and whether it has a platform.
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

function named(p, token) {
  const name = token.value
  if (name === 'true' || name === 'false') return name === 'true'
  if (name === 'nil') return null
  if (name === '__dir__') return p.dir
  if (name === '__FILE__') return p.path
  if (name === 'File' || name === 'JSON') {
    expect(p, '.')
    const method = expect(p, 'name').value
    expect(p, '(')
    return call(p, name, method, list(p, ')'))
  }
  if (name === 'ENV') {
    expect(p, '[')
    const key = expression(p)
    expect(p, ']')
    return typeof key === 'string' ? environment(p, key, token) : fail(p, 'a variable of the environment whose name is no text', token)
  }
  if (p.specs.has(name)) return ofSpec(p, token)
  if (p.locals.has(name)) return p.locals.get(name)
  if (name === 'defined?' || name === 'respond_to?') return defined(p, token)
  if (!HELPERS.has(name) || name === 'install_modules_dependencies') return fail(p, `\`${name}\``, token)
  const helpers = reactNativeOf(p, token, `\`${name}\` is React Native's`)
  if (is(p, '(')) {
    next(p)
    expect(p, ')')
  }
  return helpers.values[name]
}

function primary(p) {
  const token = next(p)
  switch (token.type) {
    case 'string': return interpolate(p, token.parts)
    case 'symbol': case 'number': case 'words': return token.value
    case '[': return list(p, ']')
    case '{': return hash(p)
    case '(': {
      const value = expression(p)
      expect(p, ')')
      return value
    }
    case 'name': return named(p, token)
    default: return fail(p, `\`${token.value ?? token.type}\``, token)
  }
}

// The methods of a value that are read: each gives the value it makes of one, and of what it is called with.
const METHODS = {
  to_s: (p, value, args) => (args.length === 0 ? text(p, value) : fail(p, '`to_s` of a base')),
  freeze: (p, value) => value,
  join: (p, value, args) => (Array.isArray(value) && args.length <= 1 && typeof (args[0] ?? '') === 'string' ? value.map((one) => text(p, one)).join(args[0] ?? '') : fail(p, 'a `join` of what is no list, or by what is no text')),
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
    } else if (is(p, '.') && Object.hasOwn(METHODS, p.tokens[p.at + 1].value)) {
      p.at += 2
      const method = METHODS[p.tokens[p.at - 1].value]
      const parenthesized = is(p, '(')
      if (parenthesized) next(p)
      value = method(p, value, parenthesized ? list(p, ')') : [])
    } else return value
  }
}

function unary(p) {
  if (!is(p, '!')) return postfix(p)
  next(p)
  return !truthy(unary(p))
}

function sum(p) {
  let value = unary(p)
  while (is(p, '+')) {
    const at = next(p)
    const other = unary(p)
    if (typeof value === 'string' && typeof other === 'string') value += other
    else if (Array.isArray(value) && Array.isArray(other)) value = [...value, ...other]
    else fail(p, 'a `+` of what is not two strings or two lists', at)
  }
  return value
}

// `==` and `!=`, of what is told apart as Ruby tells it: not a symbol, which is read as its text.
function equal(p) {
  const first = peek(p)
  const value = sum(p)
  if (!is(p, '==') && !is(p, '!=')) return value
  const operator = next(p)
  const second = peek(p)
  const other = sum(p)
  const compared = [value, other].every((one) => one === null || typeof one !== 'object') && first.type !== 'symbol' && second.type !== 'symbol'
  return compared ? (value === other) === (operator.type === '==') : fail(p, `a \`${operator.type}\` of what is no text, number, true, false or nil`, operator)
}

// `&&` and `||`, each giving one of its sides, as Ruby's do.
function logical(p, operator, operand) {
  let value = operand(p)
  while (is(p, operator)) {
    next(p)
    skipLines(p)
    const other = operand(p)
    if (truthy(value) === (operator === '&&')) value = other
  }
  return value
}
const both = (p) => logical(p, '&&', equal)

// A value: what a `?:` gives, of what its condition is.
export function expression(p) {
  const value = logical(p, '||', both)
  if (!is(p, '?')) return value
  next(p)
  skipLines(p)
  const held = expression(p)
  expect(p, ':')
  skipLines(p)
  const other = expression(p)
  return truthy(value) ? held : other
}
