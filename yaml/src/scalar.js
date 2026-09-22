// The values on a line: scalars, and the flow collections `{k: v}` and
// `[a, b]` of scalars. This is everything that can follow `key: ` or `- ` on
// the same line, and what a key is; parse.js reads the structure around it
// and never looks inside.
//
// js-yaml, as pnpm drives it, writes a string plain when it can, single-
// quoted when it cannot, and double-quoted with escapes only when the string
// holds something unprintable; it writes a flow collection only for a few
// leaf keys (resolution, engines, cpu, os, libc), and those hold scalars
// alone. That is the whole of what is read here. A flow collection that
// nests, spans lines or ends in a comma, and an explicit `?` key inside one,
// are refused.

import { YamlError } from './error.js'

// Every regex below is sticky: it reads at a position, and `take` moves the
// position past what was read.
const take = (src, re) => {
  re.lastIndex = src.pos
  const m = re.exec(src.text)
  if (m !== null) src.pos = re.lastIndex
  return m
}

// A plain scalar cannot open with an indicator character — `-`, `?` and `:`
// aside, when something other than a space follows them — and inside it a
// `:` is never followed by a space nor a `#` preceded by one, since those two
// pairs are how a key and a comment start. A run of spaces is part of it
// only when more of the scalar follows — not a comment, not `: ` — so
// nothing trailing is read. Inside a flow collection `,`, `[`, `]`, `{` and
// `}` end it as well. The space is the one whitespace there is: tabs were
// refused before this, and to YAML a Unicode space is a character like any
// other.
const PLAIN = {
  block: /(?:[^ ?:,[\]{}#&*!|>'"%@`-]|[-?:](?=[^ ]))(?:[^ :#]|:(?=[^ ])|(?<=[^ ])#| +(?=[^ #:]|:[^ ]))*/uy,
  flow: /(?:[^ ?:,[\]{}#&*!|>'"%@`-]|[-?:](?=[^ ,[\]{}]))(?:[^ :#,[\]{}]|:(?=[^ ,[\]{}])|(?<=[^ ])#| +(?=[^ #:,[\]{}]|:[^ ,[\]{}]))*/uy,
}
const SINGLE = /'((?:[^']|'')*)'/uy
const DOUBLE = /"((?:[^"\\]|\\.)*)"/uy

// The escapes double quotes allow — the YAML table entire; `\x`, `\u` and
// `\U` name a code point in two, four or eight hex digits.
const ESCAPE = {
  __proto__: null,
  0: '\u0000', a: '\u0007', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\u001B',
  ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\u0085', _: '\u00A0', L: '\u2028', P: '\u2029',
}
const ESCAPED = /\\(?:x([\dA-Fa-f]{2})|u([\dA-Fa-f]{4})|U([\dA-Fa-f]{8})|(.))/gu

function unescape(raw, src) {
  return raw.replace(ESCAPED, (_, x, u, U, c) => {
    if (c !== undefined) {
      if (!(c in ESCAPE)) throw new YamlError(`unknown escape \\${c}`, src.line)
      return ESCAPE[c]
    }
    const code = Number.parseInt(x ?? u ?? U, 16)
    if (code > 0x10FFFF) throw new YamlError(`\\U${U} is beyond Unicode`, src.line)
    return String.fromCodePoint(code)
  })
}

// What a plain scalar is. The core schema types `true`, `false`, `null` and
// numbers, and js-yaml quotes a string that looks like one, so unquoted they
// are what they say. Read here are the spellings JS itself prints; the schema
// takes more — `~`, `Null`, `TRUE`, `0x1F`, `1_000`, `.5`, `1.`, `+1`, `01`,
// `.inf` — and a scalar in one of those shapes is refused rather than read
// as text, or as a number by a rule nobody asked for.
const KNOWN = { __proto__: null, true: true, false: false, null: null }
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[Ee][+-]?\d+)?$/u
const TYPED = /^(?:~|null|true|false|\.nan|[+-]?(?:\.inf|0[box][\d_a-f]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.[\d_]+)(?:e[+-]?\d+)?))$/iu

function resolve(text, src) {
  if (text in KNOWN) return KNOWN[text]
  if (NUMBER.test(text)) return Number(text)
  if (TYPED.test(text)) throw new YamlError(`ambiguous scalar ${text}, quote it`, src.line)
  return text
}

const found = (src) => (src.pos < src.text.length ? JSON.stringify(src.text.slice(src.pos, src.pos + 24)) : 'the end of the line')

// A scalar of any of the three kinds at the position, typed when plain;
// undefined when none starts there.
function matchScalar(src, context) {
  let m = take(src, SINGLE)
  if (m !== null) return m[1].replaceAll("''", "'")
  m = take(src, DOUBLE)
  if (m !== null) return unescape(m[1], src)
  m = take(src, PLAIN[context])
  return m === null ? undefined : resolve(m[0], src)
}

function readScalar(src, context) {
  const value = matchScalar(src, context)
  if (value === undefined) throw new YamlError(`expected a scalar, found ${found(src)}`, src.line)
  return value
}

const SPACES = / */uy
const COMMA = /, */uy
const BRACE_END = /\}/uy
const BRACKET_END = /\]/uy
const PAIR = /: +/uy
const KEY_END = /:(?: +|$)/uy
const LINE_END = /(?: +#.*| *)$/uy

function readFlowMapping(src) {
  const map = Object.create(null)
  src.pos++
  take(src, SPACES)
  if (take(src, BRACE_END) !== null) return map
  for (;;) {
    const key = readScalar(src, 'flow')
    if (typeof key !== 'string') throw new YamlError('keys must be strings', src.line)
    if (take(src, PAIR) === null) throw new YamlError(`expected ": " after the key, found ${found(src)}`, src.line)
    if (key in map) throw new YamlError(`duplicate key ${key}`, src.line)
    map[key] = readScalar(src, 'flow')
    take(src, SPACES)
    if (take(src, BRACE_END) !== null) return map
    if (take(src, COMMA) === null) throw new YamlError(`expected "," or "}", found ${found(src)}`, src.line)
  }
}

function readFlowSequence(src) {
  const list = []
  src.pos++
  take(src, SPACES)
  if (take(src, BRACKET_END) !== null) return list
  for (;;) {
    list.push(readScalar(src, 'flow'))
    take(src, SPACES)
    if (take(src, BRACKET_END) !== null) return list
    if (take(src, COMMA) === null) throw new YamlError(`expected "," or "]", found ${found(src)}`, src.line)
  }
}

// The whole of a value on one line: a scalar or a flow collection, and after
// it nothing but spaces or a comment.
export function parseInline(text, line) {
  const src = { text, pos: 0, line }
  const value = text.startsWith('{') ? readFlowMapping(src) : text.startsWith('[') ? readFlowSequence(src) : readScalar(src, 'block')
  if (take(src, LINE_END) === null) throw new YamlError(`unexpected ${found(src)} after the value`, line)
  return value
}

// A line opens a mapping entry when a scalar sits at its start with `:` and
// a space, or `:` and the end of the line, right after it. That scalar comes
// back with the rest of the line; null when the line is not an entry.
export function readKey(text, line) {
  const src = { text, pos: 0, line }
  const key = matchScalar(src, 'block')
  if (key === undefined || take(src, KEY_END) === null) return null
  return { key, rest: text.slice(src.pos) }
}
