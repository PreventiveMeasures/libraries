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
//     if ENV['RCT_NEW_ARCH_ENABLED'] == '1'  # a condition: if, unless, elsif, else, `... if`, ?:, ==, !=, !,
//       install_modules_dependencies(s)    #   &&, ||; and React Native's helper, of a version whose is known
//     end
//   end
//
// No loop, no method but these, no file read but a package.json, no variable of the environment but as
// pod.config.json's `env` and the lockfile's React Native have it. Anything else is refused, but in the branch
// of a condition that does not hold, which is passed over; and what is read is held to the lockfile's checksum
// by the caller, as the JSON CocoaPods wrote.

import { dirname } from 'node:path'

import { PodError } from './error.js'
import { PROXIES, environment, expect, expression, fail, interpolate, is, list, next, peek, reactNativeOf, skipLines, truthy } from './podspec-expr.js'
import { addDependency, newSpec, setAttribute, specJson } from './podspec-json.js'
import { tokenize } from './podspec-tokens.js'

const SPECS = { subspec: 'library', test_spec: 'test', app_spec: 'app' }
const DEFAULT_NAMES = { test: 'Tests', app: 'App' }
// What a value ends with, which an `if` on its line is then a modifier of; and the words that are no value.
const ENDS = new Set(['name', 'string', 'symbol', 'number', 'words', ')', ']', '}'])
const WORDS = new Set(['then', 'else', 'elsif', 'do', 'and', 'or', 'not'])
// The blocks whose `end` is not told from their words alone, which a branch passed over may not have.
const BLOCKS = new Set(['case', 'while', 'until', 'for', 'begin', 'def', 'class', 'module'])

// What a podspec is read in where nothing is said of it: no variable given, and no React Native.
const ALONE = { env: new Map(), prebuilt: {} }

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
const branchEnds = (p) => is(p, 'name', 'end') || is(p, 'name', 'else') || is(p, 'name', 'elsif')

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

// `s.attribute = ...`, `s.dependency ...`, `s.subspec ... do`, of the specification `token` names.
function ofSpec(p, token, refuse) {
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
}

// `install_modules_dependencies(s)`: React Native's, as the version of the lockfile has it.
function installModules(p, token, refuse) {
  const parenthesized = is(p, '(')
  if (parenthesized) next(p)
  const spec = p.specs.get(expect(p, 'name').value) ?? refuse('`install_modules_dependencies` of what is no specification')
  if (parenthesized) expect(p, ')')
  const { prebuilt, reactNative: version } = p.context
  reactNativeOf(p, token, "`install_modules_dependencies` is React Native's").install(spec, { env: (name) => environment(p, name, token), prebuilt, refuse })
  p.helpers.add(`install_modules_dependencies of React Native ${version}${prebuilt.core ? ', its core prebuilt' : ''}${prebuilt.deps ? ', its dependencies prebuilt' : ''}`)
}

// One statement that is no condition: of a specification, a local name given a value or a list one more,
// `require 'json'`, or React Native's helper called.
function simple(p) {
  const token = expect(p, 'name')
  const refuse = (what) => fail(p, what, token)
  if (p.specs.has(token.value)) ofSpec(p, token, refuse)
  else if (token.value === 'require' && is(p, 'string') && interpolate(p, peek(p).parts) === 'json') next(p)
  else if (is(p, '=')) {
    next(p)
    p.locals.set(token.value, expression(p))
  } else if (is(p, '<<')) {
    next(p)
    const items = p.locals.get(token.value)
    if (!Array.isArray(items)) refuse('a `<<` to what is no list')
    items.push(expression(p))
  } else if (token.value === 'install_modules_dependencies') installModules(p, token, refuse)
  else refuse(`\`${token.value}\``)
  return void endStatement(p)
}

// Past the branch of a condition that does not hold, to the `else`, `elsif` or `end` that is its own: by the
// words that open a block and the `end` of each, with nothing of it read.
function pass(p) {
  for (let depth = 0; ; next(p)) {
    const token = peek(p)
    const before = p.tokens[p.at - 1]
    if (token.type === 'end of file') fail(p, 'a condition without its `end`')
    if (token.type !== 'name' || before.type === '.' || p.tokens[p.at + 1].type === ':') continue
    if (BLOCKS.has(token.value)) fail(p, `\`${token.value}\` where a condition does not hold`)
    const modifies = before.line === token.line && ENDS.has(before.type) && !WORDS.has(before.value)
    if (token.value === 'do' || ((token.value === 'if' || token.value === 'unless') && !modifies)) depth++
    else if (depth === 0 && branchEnds(p)) return
    else if (token.value === 'end') depth--
  }
}

// `if ... elsif ... else ... end`, and `unless`: the statements of the branch that holds are read, the others
// passed over.
function conditional(p) {
  let holds = (next(p).value === 'if') === truthy(expression(p))
  for (let done = false; ; ) {
    if (is(p, 'name', 'then')) next(p)
    if (holds && !done) {
      for (skipLines(p); !branchEnds(p); skipLines(p)) statement(p)
      done = true
    } else pass(p)
    const word = next(p).value
    if (word === 'end') return
    holds = !done && (word === 'else' || truthy(expression(p)))
  }
}

// Where the statement at hand has a modifier, `... if condition`, the place of its `if` or `unless`; else -1.
function modifierAt(p) {
  let depth = 0
  for (let at = p.at; ; at++) {
    const { type, value } = p.tokens[at]
    if (type === 'end of file' || (depth === 0 && type === 'name' && value === 'do')) return -1
    if (type === '(' || type === '[' || type === '{') depth++
    else if (type === ')' || type === ']' || type === '}') depth--
    else if (depth === 0 && (type === 'newline' || type === ';') && p.tokens[at - 1].type !== ',') return -1
    else if (depth === 0 && at > p.at && type === 'name' && (value === 'if' || value === 'unless')) return at
  }
}

function statement(p) {
  if (is(p, 'name', 'if') || is(p, 'name', 'unless')) {
    conditional(p)
    return void endStatement(p)
  }
  const at = modifierAt(p)
  if (at === -1) return simple(p)
  const start = p.at
  const modifier = p.tokens[at]
  p.at = at + 1
  const holds = truthy(expression(p)) === (modifier.value === 'if')
  const after = p.at
  if (holds) {
    // The statement, read as one that ends where its modifier is.
    p.tokens[at] = { type: 'newline', line: modifier.line }
    p.at = start
    simple(p)
    p.tokens[at] = modifier
  }
  p.at = after
  return void endStatement(p)
}

// The JSON of the podspec at `path`, whose text is `source`, as CocoaPods writes it: `forms`, each of the two
// podspec-json.js's specJson gives. `read` gives a file's text by its path, or undefined. `context` is what a
// podspec is read in: `env`, a Map of the variables of the environment given, null one that is not set;
// `reactNative`, the version the lockfile has of it, if any; `prebuilt`, whether its `core` and its `deps` are;
// `frameworks`, "static" or "dynamic" where pods are built as frameworks. `conditions` says what of these the
// podspec was read by. A PodError says what of it is not in the form read.
export function podspecJson(path, source, read, where, context = ALONE) {
  const p = { tokens: tokenize(source, where), at: 0, where, path, dir: dirname(path), read, context, locals: new Map(), specs: new Map(), env: new Map(), helpers: new Set() }
  let root
  for (skipLines(p); !is(p, 'end of file'); skipLines(p)) {
    if (root !== undefined) fail(p, 'more after the specification')
    if (is(p, 'name', 'Pod')) {
      next(p)
      expect(p, '::')
      if (!['Spec', 'Specification'].includes(expect(p, 'name').value)) fail(p, 'a constant of Pod but Spec')
      expect(p, '.')
      expect(p, 'name', 'new')
      root = newSpec(undefined, null)
      block(p, root)
    } else statement(p)
  }
  if (typeof root?.attributes.get('name') !== 'string') throw new PodError('its podspec gives no name', where)
  return { forms: specJson(root), conditions: [...[...p.env].map(([name, value]) => (value === null ? `${name} not set` : `${name}=${value}`)), ...p.helpers] }
}
