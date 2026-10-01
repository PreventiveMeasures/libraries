// The cargo-platform crate, 0.3: Platform::from_str, Cfg::from_str and
// Platform::matches. A name or target that is not ASCII is refused, where
// the crate takes any alphanumeric character in a target.

const TOKEN = / *(?:([(),=])|"([^"]*)"|(r#)?([A-Z_a-z]\w*)|(.|$))/suy

class Refused extends Error {}

const refuse = () => {
  throw new Refused()
}

function text(value) {
  if (typeof value !== 'string') throw new TypeError('expected a string')
  return value
}

function tokenize(source) {
  const tokens = []
  TOKEN.lastIndex = 0
  while (TOKEN.lastIndex < source.length) {
    const [, punct, string, raw, ident, other] = TOKEN.exec(source)
    if (other === '') break
    if (other !== undefined) refuse()
    tokens.push(ident === undefined ? { punct, string } : { ident, raw: raw !== undefined })
  }
  return tokens
}

// The value has no `"`, and raw names match plain ones.
const key = (name, value) => (value === undefined ? name : `${name}="${value}"`)

function parser(source) {
  const tokens = tokenize(source)
  let pos = 0
  const peek = () => tokens[pos]
  const eat = (punct) => {
    if (peek()?.punct !== punct) refuse()
    pos++
  }
  const cfg = () => {
    const token = tokens[pos++]
    if (token?.ident === undefined) refuse()
    if (peek()?.punct !== '=') return { name: token.ident }
    pos++
    const value = tokens[pos++]?.string
    if (value === undefined) refuse()
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

// `{ name }` for a target, `{ expr }` for cfg(…); undefined where the crate errs.
export function parsePlatform(source) {
  const inner = /^cfg\((.*)\)$/su.exec(text(source))?.[1]
  if (inner === undefined) return /^[\w.-]+$/u.test(source) ? { name: source, expr: undefined } : undefined
  return parse(inner, (p) => ({ name: undefined, expr: p.expr() }))
}

// A line of `rustc --print cfg`, as a key into `target.cfg`; undefined
// where the crate errs.
export function parseCfg(source) {
  return parse(text(source), (p) => {
    const { name, value } = p.cfg()
    return key(name, value)
  })
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
