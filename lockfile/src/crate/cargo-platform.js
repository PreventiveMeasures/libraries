// The cargo-platform crate, 0.3: Platform::from_str, Cfg::from_str and
// Platform::matches. A name or target that is not ASCII is refused, where
// the crate takes any alphanumeric character in a target, and so is a cfg
// nested more than 64 deep. A platform matched against may be known in
// part, which the crate's never is: then a match may be undecided.

import { text } from './semver.js'

const TOKEN = / *(?:([(),=])|"([^"]*)"|(r#)?([A-Z_a-z]\w*)|(.|$))/gsuy
// Deeper than any cfg(...) is written, and shallow enough to read and match
// without running out of stack, as the PEP 508 marker reader holds one.
const MAX_DEPTH = 64

class Refused extends Error {}

const refuse = () => {
  throw new Refused()
}

function tokenize(source) {
  const tokens = []
  for (const [, punct, string, raw, ident, other] of source.matchAll(TOKEN)) {
    if (other === '') break
    if (other !== undefined) refuse()
    tokens.push(ident === undefined ? { punct, string } : { ident, raw: raw !== undefined })
  }
  return tokens
}

function parser(source) {
  const tokens = tokenize(source)
  let pos = 0
  const peek = () => tokens[pos]
  const eat = (punct) => {
    if (peek()?.punct !== punct) refuse()
    pos++
  }
  // A cfg and its key: the value has no `"`, and raw names match plain ones.
  const cfg = () => {
    const token = tokens[pos++]
    if (token?.ident === undefined) refuse()
    if (peek()?.punct !== '=') return { name: token.ident, key: token.ident }
    pos++
    const value = tokens[pos++]?.string
    if (value === undefined) refuse()
    return { name: token.ident, value, key: `${token.ident}="${value}"` }
  }
  // all(...) and any(...) of any number, a comma after each; not(...) of one.
  const expr = (depth = 0) => {
    const token = peek()
    if (token?.raw === false && ['all', 'any', 'not'].includes(token.ident)) {
      if (depth >= MAX_DEPTH) refuse()
      pos++
      eat('(')
      const list = []
      while (peek()?.punct !== ')') {
        list.push(expr(depth + 1))
        if (token.ident === 'not' || peek()?.punct !== ',') break
        pos++
      }
      if (token.ident === 'not' && list.length === 0) refuse()
      eat(')')
      return { op: token.ident, list }
    }
    const { name, value, key } = cfg()
    if (value === undefined && (name === 'true' || name === 'false')) return { op: name, list: [] }
    return { op: 'cfg', name, key }
  }
  return { expr, cfg, done: () => peek() === undefined }
}

function parse(source, read) {
  try {
    const p = parser(source)
    const result = read(p)
    return p.done() ? result : undefined
  } catch (error) {
    if (error instanceof Refused) return undefined
    throw error
  }
}

// `{ name }` for a target, `{ expr }` for cfg(...); undefined where the crate errs.
export function parsePlatform(source) {
  const inner = /^cfg\((.*)\)$/su.exec(text(source))?.[1]
  if (inner === undefined) return /^[\w.-]+$/u.test(source) ? { name: source, expr: undefined } : undefined
  return parse(inner, (p) => ({ name: undefined, expr: p.expr() }))
}

// A line of `rustc --print cfg`, as a key into `target.cfg`; undefined
// where the crate errs.
export function parseCfg(source) {
  return parse(text(source), (p) => p.cfg().key)
}

// Kleene's three values: undefined where what is undecided could make it
// either.
const EVAL = {
  __proto__: null,
  all: (e, decide) => settle(e.list, decide, false),
  any: (e, decide) => settle(e.list, decide, true),
  not: (e, decide) => {
    const value = evaluate(e.list[0], decide)
    return value === undefined ? undefined : !value
  },
  true: () => true,
  false: () => false,
  cfg: (e, decide) => decide(e),
}

function evaluate(expr, decide) {
  return EVAL[expr.op](expr, decide)
}

// `settles` where any item is; the other where every item is the other.
function settle(list, decide, settles) {
  let open = false
  for (const item of list) {
    const value = evaluate(item, decide)
    if (value === settles) return settles
    if (value === undefined) open = true
  }
  return open ? undefined : !settles
}

// `target` is { name, cfg, decides }: `cfg` a Set of what parseCfg gives,
// `decides` a Set of the names of the cfgs of which `cfg` lists every value
// that holds, or undefined for every name's; `name` undefined where not
// known. A cfg of another name is undecided, and so is the match where that
// could make it either.
export function platformMatches(platform, target) {
  if (platform.expr === undefined) return target.name === undefined ? undefined : platform.name === target.name
  const decided = (name) => target.decides === undefined || target.decides.has(name)
  return evaluate(platform.expr, (leaf) => (target.cfg.has(leaf.key) ? true : (decided(leaf.name) ? false : undefined)))
}
