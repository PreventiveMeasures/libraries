// The evaluator: a method sent, a block called, parameters bound, an exception raised. The nodes of Prism's
// tree are evaluated by the handlers of nodes-*.js; what is not handled is refused with a RubyUnsupported.

import { classOf, findMethod } from './classes.js'
import { cmp, compare, eq, inspect, tos } from './objects.js'
import { RubyUnsupported, arr, hash, hdel, hhas, hpairs, isArr, isHash, isSignal, signal, str, sym, truthy } from './values.js'

const MAX_DEPTH = 400

// "path:line" of a node, by the file the code around it is of.
export function at(node, env) {
  const file = env?.file
  if (!file || !node?.location) return file?.path
  const offset = node.location.startOffset
  let low = 0
  let high = file.lines.length - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (file.lines[mid] <= offset) low = mid
    else high = mid - 1
  }
  return `${file.path}:${low + 1}`
}

export function evaluate(it, node, env) {
  const handler = it.handlers[node.constructor.name]
  if (handler === undefined) throw new RubyUnsupported(`${node.constructor.name.replace(/Node$/u, '')} is not supported`, at(node, env))
  return handler(it, node, env)
}

export function raise(it, cls, message) {
  const exception = { t: 'obj', cls: typeof cls === 'string' ? it.cls[cls] ?? it.cls.Object.consts.get(cls) : cls, iv: new Map([['@message', str(message)]]), where: it.where() }
  throw signal('raise', exception)
}

export function send(it, recv, name, args = [], block = null) {
  const method = findMethod(it, recv, name)
  if (method !== undefined) return invoke(it, method, recv, args, block)
  const missing = findMethod(it, recv, 'method_missing')
  if (missing !== undefined && !missing.base) return invoke(it, missing, recv, [sym(name), ...args], block)
  const what = recv === null ? 'nil' : recv?.t === 'class' ? `${recv.module ? 'module' : 'class'} ${recv.name}` : `an instance of ${classOf(it, recv).name}`
  return raise(it, 'NoMethodError', `undefined method \`${name}' for ${what}`)
}

export function invoke(it, method, self, args, block) {
  if (method.fn) return method.fn(it, self, args, block, method)
  if (method.proc) return callProc(it, method.proc, args, block, { self, lambda: true })
  if (++it.depth > MAX_DEPTH) throw new RubyUnsupported('calls nested too deep', it.where())
  const frame = { method, self, args, block }
  const env = { vars: new Map(), up: null, self, cref: method.cref, frame, file: method.file, vis: null, tag: null }
  try {
    bindParams(it, method.node.parameters, args, env, true, block)
    return method.node.body === null ? null : evaluate(it, method.node.body, env)
  } catch (error) {
    if (isSignal(error, 'return') && error.tag === frame) return error.value
    throw error
  } finally {
    it.depth--
  }
}

// A block, a proc or a lambda called. A `next` in it is its value; a `return` in a lambda, and a `break`, too.
export function callProc(it, proc, args, block = null, { self, lambda = proc.lambda, cref } = {}) {
  if (proc.fn) return proc.fn(it, args, block, self)
  const up = proc.env
  const frame = lambda ? { ...up.frame, block: up.frame?.block ?? null } : up.frame
  const env = { vars: new Map(), up, self: self === undefined ? proc.self : self, cref: cref ?? up.cref, frame, file: up.file, vis: up.vis, tag: proc }
  if (++it.depth > MAX_DEPTH) throw new RubyUnsupported('calls nested too deep', it.where())
  try {
    bindParams(it, proc.node.parameters, args, env, lambda, block)
    return proc.node.body === null ? null : evaluate(it, proc.node.body, env)
  } catch (error) {
    if (isSignal(error, 'next') && error.tag === proc) return error.value
    if (lambda && ((isSignal(error, 'return') && error.tag === frame) || (isSignal(error, 'break') && error.tag === proc))) return error.value
    throw error
  } finally {
    it.depth--
  }
}

export function setVar(env, name, value) {
  for (let scope = env; scope; scope = scope.up) {
    if (scope.vars.has(name)) {
      scope.vars.set(name, value)
      return value
    }
  }
  env.vars.set(name, value)
  return value
}
export function getVar(env, name) {
  for (let scope = env; scope; scope = scope.up) if (scope.vars.has(name)) return scope.vars.get(name)
  return undefined
}

const kind = (node) => node.constructor.name
// A parameter that destructures, `|(a, b), c|`, or one by its name.
function bindTarget(it, target, value, env) {
  if (kind(target) !== 'MultiTargetNode') return void env.vars.set(target.name, value)
  const items = isArr(value) ? value.a : [value]
  const { lefts, rest, rights } = target
  lefts.forEach((left, i) => bindTarget(it, left, items[i] ?? null, env))
  const tail = Math.max(lefts.length, items.length - rights.length)
  if (rest?.expression) bindTarget(it, rest.expression, arr(items.slice(lefts.length, tail)), env)
  rights.forEach((right, i) => bindTarget(it, right, items[tail + i] ?? null, env))
  return undefined
}

// The keywords of a call: its last argument where the call wrote that as keywords, `k: v` or `**h`, as Ruby 3
// takes them; a Hash passed as such is an argument.
function takeKeywords(positional) {
  const last = positional.at(-1)
  return isHash(last) && last.kw ? hash(hpairs(positional.pop())) : hash()
}

function bindKeywords(it, params, given, env, strict) {
  for (const param of params.keywords) {
    const key = sym(param.name)
    if (hhas(given, key)) env.vars.set(param.name, hdel(given, key))
    else if (kind(param) === 'OptionalKeywordParameterNode') env.vars.set(param.name, evaluate(it, param.value, env))
    else raise(it, 'ArgumentError', `missing keyword: :${param.name}`)
  }
  const rest = params.keywordRest
  if (rest !== null && kind(rest) === 'KeywordRestParameterNode') {
    if (rest.name) env.vars.set(rest.name, given)
  } else if (strict && given.map.size > 0) {
    raise(it, 'ArgumentError', `unknown keyword: ${hpairs(given).map(([key]) => inspect(it, key)).join(', ')}`)
  }
}

function bindPositional(it, params, given, env, strict) {
  const { requireds, optionals, rest, posts } = params
  const fixed = requireds.length + posts.length
  let positional = given
  const splats = fixed + optionals.length > 1 || (rest !== null && (fixed + optionals.length > 0 || kind(rest) === 'ImplicitRestNode'))
  if (!strict && positional.length === 1 && isArr(positional[0]) && splats) positional = [...positional[0].a]
  if (strict && (positional.length < fixed || (rest === null && positional.length > fixed + optionals.length))) {
    const expected = rest === null ? (optionals.length > 0 ? `${fixed}..${fixed + optionals.length}` : fixed) : `${fixed}+`
    raise(it, 'ArgumentError', `wrong number of arguments (given ${positional.length}, expected ${expected})`)
  }
  let next = 0
  for (const param of requireds) bindTarget(it, param, positional[next++] ?? null, env)
  const spare = Math.max(0, positional.length - fixed)
  optionals.forEach((param, i) => env.vars.set(param.name, i < spare ? positional[next++] : evaluate(it, param.value, env)))
  const tail = Math.max(next, positional.length - posts.length)
  if (rest !== null && kind(rest) === 'RestParameterNode' && rest.name) env.vars.set(rest.name, arr(positional.slice(next, tail)))
  posts.forEach((param, i) => bindTarget(it, param, positional[tail + i] ?? null, env))
}

// The parameters of a method or a block bound to the arguments of a call, in `env`. A method and a lambda are
// `strict` of how many they take; a block takes a lone Array for its parameters, and nil for one not given.
export function bindParams(it, parameters, args, env, strict, block) {
  let params = parameters
  if (params !== null && kind(params) === 'BlockParametersNode') {
    for (const local of params.locals) env.vars.set(local.name, null)
    params = params.parameters
  }
  const positional = [...args]
  if (params === null) {
    if (strict && positional.length > 0 && !(positional.length === 1 && positional[0]?.kw && positional[0].map.size === 0)) raise(it, 'ArgumentError', `wrong number of arguments (given ${positional.length}, expected 0)`)
    return
  }
  if (kind(params) === 'NumberedParametersNode') {
    const items = params.maximum > 1 && positional.length === 1 && isArr(positional[0]) ? positional[0].a : positional
    for (let i = 1; i <= params.maximum; i++) env.vars.set(`_${i}`, items[i - 1] ?? null)
    return
  }
  if (kind(params) === 'ItParametersNode') return void env.vars.set('it', positional[0] ?? null)
  if (params.keywordRest !== null && kind(params.keywordRest) === 'ForwardingParameterNode') throw new RubyUnsupported('`...` parameters are not supported', it.where())
  const keyworded = params.keywords.length > 0 || (params.keywordRest !== null && kind(params.keywordRest) === 'KeywordRestParameterNode')
  const keywords = keyworded ? takeKeywords(positional) : null
  for (const arg of positional) if (arg?.kw) arg.kw = false
  bindPositional(it, params, positional, env, strict)
  if (keyworded) bindKeywords(it, params, keywords, env, strict)
  if (params.block?.name) env.vars.set(params.block.name, block)
}

// What the natives call back into.
export function api(it) {
  Object.assign(it, {
    eval: (node, env) => evaluate(it, node, env),
    send: (recv, name, args, block) => send(it, recv, name, args, block),
    call: (proc, args = [], block = null, options = undefined) => callProc(it, proc, args, block, options),
    raise: (cls, message) => raise(it, cls, message),
    tos: (v) => tos(it, v),
    inspect: (v) => inspect(it, v),
    eq: (a, b) => eq(it, a, b),
    cmp: (a, b) => cmp(it, a, b),
    compare: (a, b) => compare(it, a, b),
    truthy,
    where: () => (it.sites.length > 0 ? at(it.sites.at(-1)[0], it.sites.at(-1)[1]) : undefined),
    unsupported: (message) => { throw new RubyUnsupported(message, it.where()) },
  })
  return it
}
