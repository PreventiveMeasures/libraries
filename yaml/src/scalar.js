// One line's worth of value: a scalar, or a flow collection of scalars.

import { YamlError } from './error.js'

// Sticky regexes read at `src.pos`; `take` moves it past the match.
const take = (src, re) => {
  re.lastIndex = src.pos
  const m = re.exec(src.text)
  if (m !== null) src.pos = re.lastIndex
  return m
}

// A plain scalar opens with anything but an indicator (`-`, `?` and `:` are
// fine when not followed by a space), contains no `: ` and no ` #`, and ends
// before trailing spaces; in a flow collection `,[]{}` end it too. Only the
// space counts as whitespace: tabs were refused earlier, and to YAML a
// Unicode space is an ordinary character.
const PLAIN = {
  block: /(?:[^ ?:,[\]{}#&*!|>'"%@`-]|[-?:](?=[^ ]))(?:[^ :#]|:(?=[^ ])|(?<=[^ ])#| +(?=[^ #:]|:[^ ]))*/uy,
  flow: /(?:[^ ?:,[\]{}#&*!|>'"%@`-]|[-?:](?=[^ ,[\]{}]))(?:[^ :#,[\]{}]|:(?=[^ ,[\]{}])|(?<=[^ ])#| +(?=[^ #:,[\]{}]|:[^ ,[\]{}]))*/uy,
}
const SINGLE = /'((?:[^']|'')*)'/uy
const DOUBLE = /"((?:[^"\\]|\\.)*)"/uy

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

// Only the spellings JS itself prints are typed. Everything else the core
// schema would type (`~`, `TRUE`, `0x1F`, `1_000`, `.5`, `1.`, `+1`, `01`,
// `.inf`, ...) is refused rather than silently read as a string.
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

export function setKey(map, key, value, line) {
  if (typeof key !== 'string') throw new YamlError('keys must be strings', line)
  if (key in map) throw new YamlError(`duplicate key ${key}`, line)
  map[key] = value
}

const SPACES = / */uy
const COMMA = /, */uy
const PAIR = /: +/uy
const KEY_END = /:(?: +|$)/uy
const LINE_END = /(?: +#.*| *)$/uy

function readFlow(src, closer, item) {
  src.pos++
  take(src, SPACES)
  if (src.text[src.pos] !== closer) {
    do {
      item()
      take(src, SPACES)
    } while (take(src, COMMA) !== null)
  }
  if (src.text[src.pos] !== closer) throw new YamlError(`expected "," or "${closer}", found ${found(src)}`, src.line)
  src.pos++
}

function readFlowMapping(src) {
  const map = Object.create(null)
  readFlow(src, '}', () => {
    const key = readScalar(src, 'flow')
    if (take(src, PAIR) === null) throw new YamlError(`expected ": " after the key, found ${found(src)}`, src.line)
    setKey(map, key, readScalar(src, 'flow'), src.line)
  })
  return map
}

function readFlowSequence(src) {
  const list = []
  readFlow(src, ']', () => list.push(readScalar(src, 'flow')))
  return list
}

export function parseInline(text, line) {
  const src = { text, pos: 0, line }
  const value = text.startsWith('{') ? readFlowMapping(src) : text.startsWith('[') ? readFlowSequence(src) : readScalar(src, 'block')
  if (take(src, LINE_END) === null) throw new YamlError(`unexpected ${found(src)} after the value`, line)
  return value
}

// `key: rest` or `key:` at the start of a line; null when the line is not a
// mapping entry.
export function readKey(text, line) {
  const src = { text, pos: 0, line }
  const key = matchScalar(src, 'block')
  if (key === undefined || take(src, KEY_END) === null) return null
  return { key, rest: text.slice(src.pos) }
}
