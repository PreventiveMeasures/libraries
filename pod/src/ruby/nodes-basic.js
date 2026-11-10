// Literals, variables and constants.

import { classOf, constIn, constOf } from './classes.js'
import { at, evaluate, getVar, raise } from './interp.js'
import { makeRegexp } from './regexp.js'
import { RubyUnsupported, arr, float, hash, hpairs, hset, isArr, isHash, range, str, sym } from './values.js'

const kind = (node) => node.constructor.name
const text = (node) => node.unescaped.value

// The parts of an interpolated literal as one string.
export function interpolate(it, parts, env) {
  let out = ''
  for (const part of parts) {
    if (kind(part) === 'StringNode') out += text(part)
    else if (kind(part) === 'EmbeddedStatementsNode') out += part.statements === null ? '' : it.tos(evaluate(it, part.statements, env))
    else if (kind(part) === 'EmbeddedVariableNode') out += it.tos(evaluate(it, part.variable, env))
    else if (kind(part) === 'InterpolatedStringNode') out += interpolate(it, part.parts, env)
    else throw new RubyUnsupported(`${kind(part)} in a string is not supported`, at(part, env))
  }
  return out
}

// The elements of an Array literal or a call's arguments, each `*splat` laid out.
export function elements(it, nodes, env) {
  const out = []
  for (const node of nodes) {
    if (kind(node) !== 'SplatNode') {
      out.push(evaluate(it, node, env))
      continue
    }
    const value = node.expression === null ? null : evaluate(it, node.expression, env)
    if (isArr(value)) out.push(...value.a)
    else if (isHash(value)) out.push(...hpairs(value).map((pair) => arr(pair)))
    else if (value?.t === 'range') out.push(...it.send(value, 'to_a').a)
    else if (value !== null) out.push(value)
  }
  return out
}

export function hashOf(it, nodes, env) {
  const h = hash()
  for (const node of nodes) {
    if (kind(node) === 'AssocNode') {
      // `{ x: }` is `{ x: x }`.
      const value = kind(node.value) === 'ImplicitNode' ? evaluate(it, node.value.value, env) : evaluate(it, node.value, env)
      hset(h, evaluate(it, node.key, env), value)
    } else if (kind(node) === 'AssocSplatNode') {
      const value = node.value === null ? null : evaluate(it, node.value, env)
      if (value !== null && !isHash(value)) raise(it, 'TypeError', `no implicit conversion of ${classOf(it, value).name} into Hash`)
      for (const [k, v] of value === null ? [] : hpairs(value)) hset(h, k, v)
    } else throw new RubyUnsupported(`${kind(node)} in a Hash is not supported`, at(node, env))
  }
  return h
}

function ivarsOf(it, self, node, env) {
  if (self !== null && typeof self === 'object' && (self.t === 'obj' || self.t === 'class')) return self.iv
  throw new RubyUnsupported('an instance variable of a value that holds none', at(node, env))
}

// The class a class variable is looked for in and set in: the innermost class the code is in, and its ancestors.
export function cvarHome(it, env, name) {
  const from = env.cref.findLast((mod) => !mod.attached) ?? it.cls.Object
  for (let cls = from; cls; cls = cls.superclass) if (cls.cvars.has(name)) return cls
  return from
}

export function missingConst(it, name) {
  return raise(it, 'NameError', `uninitialized constant ${name}`)
}

export const BASIC = {
  NilNode: () => null,
  TrueNode: () => true,
  FalseNode: () => false,
  SelfNode: (it, node, env) => env.self,
  IntegerNode: (it, node, env) => {
    if (typeof node.value !== 'number' || !Number.isSafeInteger(node.value)) throw new RubyUnsupported('an Integer past 2**53 is not supported', at(node, env))
    return node.value
  },
  FloatNode: (it, node) => float(node.value),
  StringNode: (it, node) => str(text(node)),
  SymbolNode: (it, node) => sym(text(node)),
  InterpolatedStringNode: (it, node, env) => str(interpolate(it, node.parts, env)),
  InterpolatedSymbolNode: (it, node, env) => sym(interpolate(it, node.parts, env)),
  XStringNode: (it, node, env) => it.host.backtick(it, text(node), at(node, env)),
  InterpolatedXStringNode: (it, node, env) => it.host.backtick(it, interpolate(it, node.parts, env), at(node, env)),
  RegularExpressionNode: (it, node, env) => makeRegexp(it, text(node), node, at(node, env)),
  InterpolatedRegularExpressionNode: (it, node, env) => makeRegexp(it, interpolate(it, node.parts, env), node, at(node, env)),
  ArrayNode: (it, node, env) => arr(elements(it, node.elements, env)),
  HashNode: (it, node, env) => hashOf(it, node.elements, env),
  KeywordHashNode: (it, node, env) => Object.assign(hashOf(it, node.elements, env), { kw: true }),
  RangeNode: (it, node, env) => range(node.left === null ? null : evaluate(it, node.left, env), node.right === null ? null : evaluate(it, node.right, env), node.isExcludeEnd()),
  SourceFileNode: (it, node, env) => str(env.file.path),
  SourceLineNode: (it, node, env) => Number(at(node, env).split(':').at(-1)),
  LocalVariableReadNode: (it, node, env) => getVar(env, node.name) ?? null,
  ItLocalVariableReadNode: (it, node, env) => getVar(env, 'it') ?? null,
  InstanceVariableReadNode: (it, node, env) => ivarsOf(it, env.self, node, env).get(node.name) ?? null,
  ClassVariableReadNode: (it, node, env) => {
    const home = cvarHome(it, env, node.name)
    return home.cvars.has(node.name) ? home.cvars.get(node.name) : raise(it, 'NameError', `uninitialized class variable ${node.name} in ${home.name}`)
  },
  GlobalVariableReadNode: (it, node) => it.globals.get(node.name) ?? null,
  NumberedReferenceReadNode: (it, node) => (it.lastMatch?.[node.number] === undefined ? null : str(it.lastMatch[node.number])),
  BackReferenceReadNode: (it, node, env) => {
    if (node.name !== '$~') throw new RubyUnsupported(`${node.name} is not supported`, at(node, env))
    return it.lastMatch ? it.matchData(it.lastMatch) : null
  },
  ConstantReadNode: (it, node, env) => constOf(it, env.cref, node.name) ?? it.autoload(node.name) ?? missingConst(it, node.name),
  ConstantPathNode: (it, node, env) => {
    const parent = node.parent === null ? it.cls.Object : evaluate(it, node.parent, env)
    if (parent?.t !== 'class') raise(it, 'TypeError', `${it.inspect(parent)} is not a class/module`)
    return constIn(it, parent, node.name) ?? missingConst(it, parent === it.cls.Object ? node.name : `${parent.name}::${node.name}`)
  },
  ivarsOf,
}
