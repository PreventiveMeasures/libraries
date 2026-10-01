// Two grammars cargo takes from crates of its own.
//
// Version requirements, by the semver crate's port in ../crate/semver.js,
// which this holds to a place in the manifest.
//
// The platform a `[target.<platform>]` table is for, as the cargo-platform
// crate reads it: `cfg(` an expression `)`, or a target's name. An
// expression is `all(…)`, `any(…)`, `not(…)`, `true`, `false`, a name or
// `name = "value"`, with spaces and nothing else between tokens. A name or
// target that is not ASCII is refused, where the crate takes any
// alphanumeric character in a target.

import { parseVersionReq } from '../crate/semver.js'
import { LockfileError, quote } from '../error.js'

// The comparators of a requirement; refused where the crate refuses it.
export function parseRequirement(text, where) {
  const comparators = parseVersionReq(text)
  if (comparators === undefined) throw new LockfileError(`${quote(text)} is not a version requirement`, where)
  return comparators
}

const TOKEN = / *(?:([(),=])|"([^"]*)"|(r#)?([A-Z_a-z]\w*)|(.|$))/suy

function tokenize(text, fail) {
  const tokens = []
  TOKEN.lastIndex = 0
  while (TOKEN.lastIndex < text.length) {
    const [, punct, string, raw, ident, other] = TOKEN.exec(text)
    if (other === '') break
    if (other !== undefined) fail(`unexpected ${quote(other)}`)
    tokens.push(ident === undefined ? { punct, string } : { ident, raw: raw !== undefined })
  }
  return tokens
}

// A name or `name="value"` as a key into a set of them: the value has no
// `"`, and raw names match plain ones.
const key = (name, value) => (value === undefined ? name : `${name}="${value}"`)

function parser(text, where) {
  const fail = (why) => {
    throw new LockfileError(`${quote(text)} is not a cfg expression: ${why}`, where)
  }
  const tokens = tokenize(text, fail)
  let pos = 0
  const peek = () => tokens[pos]
  const eat = (punct) => {
    if (peek()?.punct !== punct) fail(`expected ${quote(punct)}`)
    pos++
  }
  const cfg = () => {
    const token = tokens[pos++]
    if (token?.ident === undefined) fail('expected a name')
    if (peek()?.punct !== '=') return { name: token.ident }
    pos++
    const value = tokens[pos++]?.string
    if (value === undefined) fail('expected a string')
    return { name: token.ident, value }
  }
  const expr = () => {
    const token = peek()
    if (token?.raw === false && (token.ident === 'all' || token.ident === 'any')) {
      pos++
      eat('(')
      const list = []
      while (peek()?.punct !== ')') {
        list.push(expr())
        if (peek()?.punct !== ',') break
        pos++
      }
      eat(')')
      return { op: token.ident, list }
    }
    if (token?.raw === false && token.ident === 'not') {
      pos++
      eat('(')
      const inner = expr()
      eat(')')
      return { op: 'not', list: [inner] }
    }
    const { name, value } = cfg()
    if (value === undefined && (name === 'true' || name === 'false')) return { op: name, list: [] }
    return { op: 'cfg', key: key(name, value) }
  }
  const done = () => {
    const token = tokens[pos]
    if (token !== undefined) fail(`unexpected ${token.string === undefined ? quote(token.punct ?? token.ident) : 'string'}`)
  }
  return { expr, cfg, done }
}

// Where the text is a target's name, `name` is it; otherwise `expr` is the
// expression.
export function parsePlatform(text, where) {
  const inner = /^cfg\((.*)\)$/su.exec(text)?.[1]
  if (inner === undefined) {
    if (!/^[\w.-]+$/u.test(text)) throw new LockfileError(`${quote(text)} is neither a target's name nor cfg(…)`, where)
    return { name: text, expr: undefined }
  }
  const p = parser(inner, where)
  const expr = p.expr()
  p.done()
  return { name: undefined, expr }
}

// One line of `rustc --print cfg`: a name or `name="value"`.
export function parseCfg(text, where) {
  const p = parser(text, where)
  const { name, value } = p.cfg()
  p.done()
  return key(name, value)
}

const EVAL = {
  __proto__: null,
  all: (e, cfg) => e.list.every((item) => evaluate(item, cfg)),
  any: (e, cfg) => e.list.some((item) => evaluate(item, cfg)),
  not: (e, cfg) => !evaluate(e.list[0], cfg),
  true: () => true,
  false: () => false,
  cfg: (e, cfg) => cfg.has(e.key),
}

function evaluate(expr, cfg) {
  return EVAL[expr.op](expr, cfg)
}

// `target` is { name, cfg }, `cfg` a Set of what parseCfg gives.
export function platformMatches(platform, target) {
  return platform.expr === undefined ? platform.name === target.name : evaluate(platform.expr, target.cfg)
}
