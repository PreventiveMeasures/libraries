// Two grammars cargo takes from crates of its own.
//
// Versions and version requirements as cargo reads them, by the semver
// crate's rules (1.0): a requirement is comparators joined by commas, each
// an operator (`^` where none is written) and a version that may stop short
// of its patch or end in a wildcard. A number past 2^53 is refused, where
// the crate reads up to 2^64.
//
// The platform a `[target.<platform>]` table is for, as the cargo-platform
// crate reads it: `cfg(` an expression `)`, or a target's name. An
// expression is `all(…)`, `any(…)`, `not(…)`, `true`, `false`, a name or
// `name = "value"`, with spaces and nothing else between tokens. A name or
// target that is not ASCII is refused, where the crate takes any
// alphanumeric character in a target.

import { LockfileError, quote } from '../error.js'

const NUMBER = '(0|[1-9]\\d*)'
const PART = `(?:([*Xx])|${NUMBER})`
const IDENTIFIER = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][\\dA-Za-z-]*)'
const COMPARATOR = new RegExp(
  `(>=|<=|>|<|=|~|\\^)? *${NUMBER}(?:\\.${PART}(?:\\.${PART})?)?` +
  `(?:-(${IDENTIFIER}(?:\\.${IDENTIFIER})*))?(\\+[\\dA-Za-z-]+(?:\\.[\\dA-Za-z-]+)*)? *(,)? *`,
  'uy',
)
const OPS = { __proto__: null, '>=': 'GreaterEq', '<=': 'LessEq', '>': 'Greater', '<': 'Less', '=': 'Exact', '~': 'Tilde', '^': 'Caret' }
const MAX_COMPARATORS = 32

function number(text, fail) {
  const value = Number(text)
  if (!Number.isSafeInteger(value)) fail(`${text} is past 2^53`)
  return value
}

// An empty list is `*`, which takes any version but a pre-release.
export function parseRequirement(text, where) {
  const fail = (why) => {
    throw new LockfileError(`${quote(text)} is not a version requirement: ${why}`, where)
  }
  const start = text.length - text.replace(/^ +/u, '').length
  if (/^[*Xx]/u.test(text.slice(start))) {
    if (/^[*Xx] *$/u.test(text.slice(start))) return []
    fail('a wildcard is only a requirement alone')
  }
  const comparators = []
  COMPARATOR.lastIndex = start
  for (;;) {
    const at = COMPARATOR.lastIndex
    const m = COMPARATOR.exec(text)
    if (m === null) fail(`unexpected ${at < text.length ? quote(text[at]) : 'end'}`)
    const [, op, major, minorWild, minor, patchWild, patch, pre, build, comma] = m
    if (minorWild !== undefined && patch !== undefined) fail('a wildcard is only followed by another')
    if ((pre !== undefined || build !== undefined) && patch === undefined) fail('only a full version takes a pre-release or build')
    const wild = minorWild !== undefined || patchWild !== undefined
    comparators.push({
      op: op === undefined ? (wild ? 'Wildcard' : 'Caret') : OPS[op],
      major: number(major, fail),
      minor: minor === undefined ? undefined : number(minor, fail),
      patch: patch === undefined ? undefined : number(patch, fail),
      pre: pre === undefined ? [] : pre.split('.'),
    })
    if (comma === undefined) {
      if (COMPARATOR.lastIndex !== text.length) fail(`unexpected ${quote(text[COMPARATOR.lastIndex])}`)
      return comparators
    }
    if (comparators.length === MAX_COMPARATORS) fail(`more than ${MAX_COMPARATORS} comparators`)
  }
}

// `version` is exact SemVer, as isVersion holds it.
export function parseVersion(version) {
  const [, major, minor, patch, pre] = /^(\d+)\.(\d+)\.(\d+)(?:-([^+]*))?/u.exec(version)
  return { major: Number(major), minor: Number(minor), patch: Number(patch), pre: pre === undefined ? [] : pre.split('.') }
}

// No pre-release is above any; numeric identifiers are below the rest.
function comparePre(a, b) {
  if (a.length === 0 || b.length === 0) return b.length - a.length
  for (let i = 0; i < a.length; i++) {
    if (i === b.length) return 1
    const [x, y] = [a[i], b[i]]
    const [xn, yn] = [/^\d+$/u.test(x), /^\d+$/u.test(y)]
    if (xn !== yn) return xn ? -1 : 1
    if (xn && x.length !== y.length) return x.length - y.length
    if (x !== y) return x < y ? -1 : 1
  }
  return a.length === b.length ? 0 : -1
}

const samePre = (a, b) => a.length === b.length && a.every((part, i) => part === b[i])

function exact(c, v) {
  return v.major === c.major && (c.minor === undefined || v.minor === c.minor) && (c.patch === undefined || v.patch === c.patch) && samePre(v.pre, c.pre)
}

// Where the version is above the comparator: 1, below: -1, and 0 where the
// comparator stops short of what tells them apart.
function order(c, v) {
  if (v.major !== c.major) return Math.sign(v.major - c.major)
  if (c.minor === undefined) return 0
  if (v.minor !== c.minor) return Math.sign(v.minor - c.minor)
  if (c.patch === undefined) return 0
  if (v.patch !== c.patch) return Math.sign(v.patch - c.patch)
  return Math.sign(comparePre(v.pre, c.pre))
}

function caret(c, v) {
  if (v.major !== c.major) return false
  if (c.minor === undefined) return true
  if (c.patch === undefined) return c.major > 0 ? v.minor >= c.minor : v.minor === c.minor
  if (c.major > 0) {
    if (v.minor !== c.minor) return v.minor > c.minor
  } else if (c.minor > 0) {
    if (v.minor !== c.minor) return false
  } else if (v.minor !== c.minor || v.patch !== c.patch) {
    return false
  }
  if (v.patch !== c.patch) return v.patch > c.patch
  return comparePre(v.pre, c.pre) >= 0
}

function tilde(c, v) {
  if (v.major !== c.major || (c.minor !== undefined && v.minor !== c.minor)) return false
  if (c.patch !== undefined && v.patch !== c.patch) return v.patch > c.patch
  return comparePre(v.pre, c.pre) >= 0
}

const MATCH = {
  __proto__: null,
  Exact: exact,
  Wildcard: exact,
  Greater: (c, v) => order(c, v) > 0,
  GreaterEq: (c, v) => exact(c, v) || order(c, v) > 0,
  Less: (c, v) => order(c, v) < 0,
  LessEq: (c, v) => exact(c, v) || order(c, v) < 0,
  Tilde: tilde,
  Caret: caret,
}

// A pre-release is taken only where a comparator names that version's
// major, minor and patch with a pre-release of its own.
export function matches(comparators, version) {
  if (!comparators.every((c) => MATCH[c.op](c, version))) return false
  return version.pre.length === 0 || comparators.some((c) => c.major === version.major && c.minor === version.minor && c.patch === version.patch && c.pre.length > 0)
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
