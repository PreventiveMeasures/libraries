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
//     if ENV['RCT_NEW_ARCH_ENABLED'] == '1'  # a condition: if, unless, elsif, else, `... if`, ?:, ==, !=, <, >,
//       install_modules_dependencies(s)    #   !, &&, ||; and a helper of React Native's, podspec-rn.js's
//     end
//     paths.each { |path| list << path }   # each of a list or a hash that is at hand; a list or a text added
//   end                                    #   to; a hash given a value by a key
//
// What it reads beyond itself is given to it: files, read and listed, never run; the variables of the
// environment and the globals of a Podfile, as pod.config.json's `env` and `globals` have them; and React
// Native's helpers, of the version the lockfile has, where that is one they are known of. No loop but over
// what is at hand, no method but the few of podspec-methods.js, no script loaded, no command run. Anything else
// is refused, but in the branch of a condition that does not hold, which is passed over; and what is read is
// held to the lockfile's checksum by the caller, as the JSON CocoaPods wrote.

import { dirname } from 'node:path'

import { PodError } from './error.js'
import { PROXIES, expression, interpolate, list, sum } from './podspec-expr.js'
import { addDependency, newSpec, setAttribute, specJson } from './podspec-json.js'
import { plus } from './podspec-methods.js'
import { changed, expect, fail, is, next, peek, skipLines, text, truthy } from './podspec-parse.js'
import { tokenize } from './podspec-tokens.js'

const SPECS = { subspec: 'library', test_spec: 'test', app_spec: 'app' }
const DEFAULT_NAMES = { test: 'Tests', app: 'App' }
// What a value ends with, which an `if` on its line is then a modifier of; and the words that are no value.
const ENDS = new Set(['name', 'global', 'string', 'symbol', 'number', 'words', 'command', ')', ']', '}'])
const WORDS = new Set(['then', 'else', 'elsif', 'do', 'and', 'or', 'not'])
// The blocks whose `end` is not told from their words alone, which a branch passed over may not have.
const BLOCKS = new Set(['case', 'while', 'until', 'for', 'begin', 'def', 'class', 'module'])

// What a podspec is read in where nothing is said of it: no variable given, and no React Native.
const ALONE = { env: new Map(), prebuilt: {} }
// What prints, of Ruby's own and of CocoaPods' `Pod::UI`.
const OUTPUT = new Set(['puts', 'print', 'warn'])
const UI = new Set([...OUTPUT, 'message', 'notice', 'info'])

// One of several values after the first: a value; or `s.attribute = value`, which is what Ruby reads of the
// line after one that ends with a comma. The attribute is set, and what it is set to is one of the values.
function another(p) {
  const [token, dot, member, sets] = p.tokens.slice(p.at, p.at + 4)
  const spec = token.type === 'name' ? p.specs.get(token.value) : undefined
  if (spec === undefined || dot.type !== '.' || member.type !== 'name' || sets?.type !== '=') return expression(p)
  p.at += 4
  const value = expression(p)
  changed(p)
  setAttribute(spec, member.value, value, undefined, (what) => fail(p, what, token))
  return value
}

// What follows `=`, or a call's name: one value, or several, which are a list.
function values(p) {
  const items = [expression(p)]
  while (is(p, ',')) {
    next(p)
    skipLines(p)
    items.push(another(p))
  }
  return items
}
const one = (items) => (items.length === 1 ? items[0] : items)
// A statement ends with its line; one of a block in braces, with the block.
const endStatement = (p) => (is(p, 'newline') || is(p, ';') ? next(p) : (is(p, '}') && p.state.braces > 0) || fail(p, `\`${peek(p).value ?? peek(p).type}\` after a statement`))
const branchEnds = (p) => is(p, 'name', 'end') || is(p, 'name', 'else') || is(p, 'name', 'elsif')

// `do |name| ... end`, of a specification, which its statements have by that name; or by none.
function block(p, spec) {
  expect(p, 'name', 'do')
  const name = is(p, '|') ? p.tokens[p.at + 1].value : undefined
  if (name !== undefined) {
    next(p)
    expect(p, 'name')
    expect(p, '|')
    p.specs.set(name, spec)
  }
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
    setAttribute(spec, member, one(values(p)), platform, refuse)
  }
}

// `.each { |name| ... }` and `.each do |key, value| ... end`, of a list or of a hash that is at hand: its
// statements, read for each in turn.
function each(p, value, refuse) {
  p.at += 2
  const braces = is(p, '{')
  expect(p, braces ? '{' : 'name', braces ? undefined : 'do')
  expect(p, '|')
  const names = [expect(p, 'name').value]
  while (is(p, ',')) {
    next(p)
    names.push(expect(p, 'name').value)
  }
  expect(p, '|')
  const items = Array.isArray(value) && names.length === 1 ? value.map((item) => [item]) : value instanceof Map && names.length === 2 ? [...value] : refuse('an `each` of what is no list, or no hash by its keys and values')
  const start = p.at
  const before = names.map((name) => [name, p.locals.has(name), p.locals.get(name)])
  const closes = () => (braces ? is(p, '}') : is(p, 'name', 'end'))
  if (braces) p.state.braces++
  for (const item of items) {
    p.at = start
    names.forEach((name, at) => p.locals.set(name, item[at]))
    for (skipLines(p); !closes(); skipLines(p)) statement(p)
  }
  if (items.length === 0) pass(p, braces)
  if (braces) p.state.braces--
  next(p)
  for (const [name, had, was] of before) {
    if (had) p.locals.set(name, was)
    else p.locals.delete(name)
  }
}

// Whether `value` is, or has in it, the text `wanted`.
const has = (value, wanted) => value === wanted || (Array.isArray(value) && value.some((item) => has(item, wanted))) || (value instanceof Map && [...value.values()].some((item) => has(item, wanted)))
const hasIn = (spec, wanted) => has(spec.attributes, wanted) || spec.subspecs.some((child) => hasIn(child, wanted))

// `name << value << value`: a list one longer for each; or a text, longer by each. Ruby adds to the text
// itself, and so to whatever else has it; that is not followed, and a text anything else may have is refused.
function append(p, token, refuse) {
  let local = p.locals.get(token.value)
  const others = [...[...p.locals].filter(([name]) => name !== token.value).map(([, value]) => value), ...p.globals.values()]
  if (typeof local === 'string' && (p.frozen || others.some((value) => has(value, local)) || [...p.specs.values()].some((spec) => hasIn(spec, local)))) refuse('a `<<` to a text that may not be added to, or that something else may have')
  while (is(p, '<<')) {
    next(p)
    const added = sum(p)
    if (Array.isArray(local)) local.push(added)
    else if (typeof local === 'string' && typeof added === 'string') local += added
    else refuse('a `<<` to what is no list, or of what is no text to a text')
  }
  p.locals.set(token.value, local)
}

// A value read for what reading it does: a helper of React Native's called; or each of a list.
function read(p) {
  const token = peek(p)
  const value = expression(p)
  if (is(p, '.') && p.tokens[p.at + 1].value === 'each') each(p, value, (what) => fail(p, what, token))
}

// One statement that is no condition: of a specification; a local name given a value, or added to, or a hash
// a value by a key; `require 'json'`; or a value read for what reading it does, a helper of React Native's
// called, or each of a list.
function simple(p) {
  if (!is(p, 'name') && !is(p, 'global')) {
    read(p)
    return void endStatement(p)
  }
  if (is(p, 'global')) {
    // `$name = value`: a global, which this podspec then has. No other podspec has it of this one.
    const name = next(p).value
    expect(p, '=')
    p.globals.set(name, one(values(p)))
    return void endStatement(p)
  }
  const token = expect(p, 'name')
  const refuse = (what) => fail(p, what, token)
  const local = p.locals.get(token.value)
  const ui = token.value === 'Pod' && is(p, '::') && p.tokens[p.at + 1].value === 'UI' && UI.has(p.tokens[p.at + 3]?.value)
  if (ui || (local === undefined && OUTPUT.has(token.value))) {
    // What is printed is nothing of the podspec; what it is printed of is read all the same.
    if (ui) p.at += 4
    if (is(p, '(')) {
      next(p)
      list(p, ')')
    } else if (!is(p, 'newline') && !is(p, ';')) values(p)
  } else if (p.specs.has(token.value) && is(p, '.')) ofSpec(p, token, refuse)
  else if (token.value === 'require' && is(p, 'string') && interpolate(p, peek(p).parts) === 'json') next(p)
  else if (is(p, '=')) {
    next(p)
    p.locals.set(token.value, one(values(p)))
  } else if (is(p, '+=')) {
    next(p)
    p.locals.set(token.value, plus(p, local ?? refuse(`\`${token.value}\``), expression(p), { ...token, type: '+' }))
  } else if (is(p, '<<')) append(p, token, refuse)
  else if (is(p, '[') && local instanceof Map) {
    next(p)
    const key = text(p, expression(p))
    expect(p, ']')
    expect(p, '=')
    local.set(key, expression(p))
  } else {
    p.at--
    read(p)
  }
  return void endStatement(p)
}

// Past the branch of a condition that does not hold, to the `else`, `elsif` or `end` that is its own: by the
// words that open a block and the `end` of each, with nothing of it read. And past a block in `braces`, to its
// `}`.
function pass(p, braces = false) {
  for (let depth = 0; ; next(p)) {
    const token = peek(p)
    const before = p.tokens[p.at - 1]
    if (token.type === 'end of file') fail(p, 'a condition, or a block, without its end')
    if (braces && token.type === '}' && depth-- === 0) return
    if (braces && token.type === '{') depth++
    if (braces || token.type !== 'name' || before.type === '.' || p.tokens[p.at + 1].type === ':') continue
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
    else if ((type === ')' || type === ']' || type === '}') && depth-- === 0) return -1
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
// podspec-json.js's specJson gives. `files` is the files it may read: `read(path)`, a file's text or undefined;
// and, where it may ask more of them, `glob(dir, pattern, where)`, files.js's dirGlob, and `kind(path)`,
// "file" or "directory" for what is there. `context` is what a podspec is read in: `env`, a Map of the
// variables of the environment given, null one that is not set; `globals`, a Map of the globals a Podfile
// set; `reactNative`, the version the lockfile has of it, if any; `prebuilt`, whether its `core` and its `deps`
// are; `frameworks`, "static" or "dynamic" where pods are built as frameworks; `cocoapods`, the version the
// lockfile is of. `conditions` says what of these the podspec was read by. A PodError says what of it is not
// in the form read.
export function podspecJson(path, source, files, where, context = ALONE) {
  const p = { tokens: tokenize(source, where), at: 0, where, path, dir: dirname(path), files, context, locals: new Map(), globals: new Map(), specs: new Map(), env: new Map(), helpers: new Set(), state: { changes: 0, braces: 0 }, frozen: /^#\s*frozen_string_literal:\s*true/mu.test(source) }
  let root
  for (skipLines(p); !is(p, 'end of file'); skipLines(p)) {
    if (root !== undefined) fail(p, 'more after the specification')
    if (is(p, 'name', 'Pod') && ['Spec', 'Specification'].includes(p.tokens[p.at + 2].value)) {
      p.at += 3
      expect(p, '.')
      expect(p, 'name', 'new')
      root = newSpec(undefined, null)
      block(p, root)
    } else statement(p)
  }
  if (typeof root?.attributes.get('name') !== 'string') throw new PodError('its podspec gives no name', where)
  const { prebuilt, reactNative: version } = context
  const helpers = p.helpers.size === 0 ? [] : [`${[...p.helpers].join(', ')} of React Native ${version}${prebuilt.core ? ', its core prebuilt' : ''}${prebuilt.deps ? ', its dependencies prebuilt' : ''}`]
  return { forms: specJson(root), conditions: [...[...p.env].map(([name, value]) => (value === null ? `${name} not set` : `${name}=${value}`)), ...helpers] }
}
