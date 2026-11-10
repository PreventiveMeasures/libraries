// A podspec read without Ruby, where it is in a strict form that says what it is rather than computes it:
//
//   require 'json'
//   package = JSON.parse(File.read(File.join(__dir__, 'package.json')))
//   Pod::Spec.new do |s|
//     s.name = 'Name'                      # literals: strings, with #{...} of a name; symbols; numbers;
//     s.version = package['version']       #   true, false, nil; lists; hashes; %w(...); heredocs
//     s.source = { :git => package['repository']['url'], :tag => "v#{s.version}" }
//     s.ios.deployment_target = '13.0'     # an attribute of one platform
//     s.dependency 'Other', '~> 1.0'
//     s.subspec 'Sub' do |ss| ... end      # and test_spec, app_spec
//   end
//
// Nothing is run: no condition, no loop, no method but these, no file read but a package.json. Anything else
// is refused, and what is read is held to the lockfile's checksum by the caller, as the JSON CocoaPods wrote.

import { basename, dirname, isAbsolute, resolve } from 'node:path'

import { PodError } from './error.js'
import { PLATFORMS, addDependency, newSpec, setAttribute, specJson } from './podspec-json.js'
import { tokenize } from './podspec-tokens.js'

const PROXIES = new Set([...PLATFORMS, 'macos'])
const SPECS = { subspec: 'library', test_spec: 'test', app_spec: 'app' }
const DEFAULT_NAMES = { test: 'Tests', app: 'App' }

const peek = (p) => p.tokens[p.at]
const next = (p) => p.tokens[p.at++]
const is = (p, type, value) => peek(p).type === type && (value === undefined || peek(p).value === value)
function fail(p, what, token = peek(p)) {
  throw new PodError(`line ${token.line}: ${what}, which is not in the form of a podspec that is read without Ruby`, p.where)
}
function expect(p, type, value) {
  if (!is(p, type, value)) fail(p, `\`${peek(p).value ?? peek(p).type}\` where \`${value ?? type}\` is expected`)
  return next(p)
}
const skipLines = (p) => {
  while (is(p, 'newline') || is(p, ';')) next(p)
}

// A value as Ruby's to_s has it in a string.
function text(p, value) {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  if (value === null) return ''
  return fail(p, 'a list or a hash in a string')
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

function list(p, close) {
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

function interpolate(p, parts) {
  return parts.map((part) => {
    if (typeof part === 'string') return part
    const inner = { ...p, tokens: tokenize(part.code, p.where, part.line), at: 0 }
    const value = expression(inner)
    if (!is(inner, 'newline')) fail(inner, 'an interpolation of more than a value')
    return text(p, value)
  }).join('')
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
  if (p.specs.has(name)) {
    expect(p, '.')
    const attribute = expect(p, 'name').value
    const value = p.specs.get(name).attributes.get(attribute)
    return (attribute === 'name' || attribute === 'version') && typeof value === 'string' ? value : fail(p, `\`${name}.${attribute}\` read`, token)
  }
  return p.locals.has(name) ? p.locals.get(name) : fail(p, `\`${name}\``, token)
}

function expression(p) {
  let value = postfix(p)
  while (is(p, '+')) {
    const at = next(p)
    const other = postfix(p)
    if (typeof value === 'string' && typeof other === 'string') value += other
    else if (Array.isArray(value) && Array.isArray(other)) value = [...value, ...other]
    else fail(p, 'a `+` of what is not two strings or two lists', at)
  }
  return value
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
    } else if (is(p, '.') && p.tokens[p.at + 1].value === 'to_s') {
      p.at += 2
      value = text(p, value)
    } else if (is(p, '.') && p.tokens[p.at + 1].value === 'freeze') p.at += 2
    else return value
  }
}

// What follows `=`, or a call's name: one value, or several, which are a list.
function values(p) {
  const items = [expression(p)]
  while (is(p, ',')) {
    next(p)
    skipLines(p)
    items.push(expression(p))
  }
  return items
}
const endStatement = (p) => (is(p, 'newline') || is(p, ';') ? next(p) : fail(p, `\`${peek(p).value ?? peek(p).type}\` after a statement`))

// `do |name| ... end`, of a specification.
function block(p, spec) {
  expect(p, 'name', 'do')
  expect(p, '|')
  const name = expect(p, 'name').value
  expect(p, '|')
  p.specs.set(name, spec)
  for (skipLines(p); !is(p, 'name', 'end'); skipLines(p)) statement(p)
  next(p)
  p.specs.delete(name)
}

function statement(p) {
  const token = expect(p, 'name')
  const refuse = (what) => fail(p, what, token)
  if (!p.specs.has(token.value)) {
    if (!is(p, '=')) refuse(`\`${token.value}\``)
    next(p)
    p.locals.set(token.value, expression(p))
    return void endStatement(p)
  }
  const spec = p.specs.get(token.value)
  expect(p, '.')
  let member = expect(p, 'name').value
  let platform
  if (PROXIES.has(member)) {
    platform = member === 'macos' ? 'osx' : member
    expect(p, '.')
    member = expect(p, 'name').value
  }
  if (member === 'dependency') {
    const parenthesized = is(p, '(')
    if (parenthesized) next(p)
    addDependency(spec, parenthesized ? list(p, ')') : values(p), platform, refuse)
  } else if (Object.hasOwn(SPECS, member) && platform === undefined) {
    const kind = SPECS[member]
    const name = is(p, 'name', 'do') ? DEFAULT_NAMES[kind] ?? refuse('a subspec without a name') : expression(p)
    if (typeof name !== 'string') refuse('a subspec whose name is no text')
    const child = newSpec(spec, name, kind)
    spec.subspecs.push(child)
    block(p, child)
  } else {
    expect(p, '=')
    const given = values(p)
    setAttribute(spec, member, given.length === 1 ? given[0] : given, platform, refuse)
  }
  return void endStatement(p)
}

// The JSON of the podspec at `path`, whose text is `source`, as CocoaPods writes it, in each of the two forms
// podspec-json.js's specJson gives; `read` gives a file's text by its path, or undefined. A PodError says what
// of it is not in the form read.
export function podspecJson(path, source, read, where) {
  const p = { tokens: tokenize(source, where), at: 0, where, path, dir: dirname(path), read, locals: new Map(), specs: new Map() }
  for (skipLines(p); !is(p, 'name', 'Pod'); skipLines(p)) {
    const token = expect(p, 'name')
    if (token.value === 'require' && is(p, 'string') && interpolate(p, peek(p).parts) === 'json') next(p)
    else if (is(p, '=')) {
      next(p)
      p.locals.set(token.value, expression(p))
    } else fail(p, `\`${token.value}\``, token)
    endStatement(p)
  }
  next(p)
  expect(p, '::')
  if (!['Spec', 'Specification'].includes(expect(p, 'name').value)) fail(p, 'a constant of Pod but Spec')
  expect(p, '.')
  expect(p, 'name', 'new')
  const root = newSpec(undefined, null)
  block(p, root)
  skipLines(p)
  if (!is(p, 'end of file')) fail(p, 'more after the specification')
  if (typeof root.attributes.get('name') !== 'string') throw new PodError('its podspec gives no name', where)
  return specJson(root)
}
