// The scalars of the YAML yaml.js reads, as Psych reads them back: how it
// types a plain one, and what a quoted or a block one comes to over its
// lines. `fail(detail, n)` refuses at the nth line of those given.

import { quote } from '../error.js'

// Psych::ScalarScanner#tokenize's types of a plain scalar, of Psych 4 and
// 5, as lockfile's psych.js reads them.
const WORDY = /^[^\d.:-]?[\p{Alpha}_ \t\n\v\f\r!@#$%^&*(){}<>|/\\~;=]/u
const TIME = /^-?\d{4}-\d{1,2}-\d{1,2}(?:[Tt]|[ \t\n\v\f\r]+)\d{1,2}:\d\d:\d\d(?:\.\d*)?(?:[ \t\n\v\f\r]*(?:Z|[-+]\d{1,2}:?(?:\d\d)?))?$/u
const DATE = /^\d{4}-(?:1[012]|0\d|\d)-(?:[12]\d|3[01]|0\d|\d)$/u
const SEXAGESIMAL = /^[-+]?\d[\d_]*(?::[0-5]?\d){1,2}(?:\.[\d_]*)?$/u
const FLOAT = /^[-+]?(?:\d[\d_,]*)?\.\d*(?:[eE][-+]\d+)?$/u
const INTEGERS = [/^[-+]?0b[01_,]+$/u, /^[-+]?0[0-7_,]+$/u, /^[-+]?(?:0|[1-9][\d_,]*)$/u, /^[-+]?0x[\dA-Fa-f_,]+$/u]
export function plainType(text) {
  if (text === '') return 'null'
  if (WORDY.test(text) || text.includes('\n')) {
    if (text.length > 5 || /^[^ytonf~]/iu.test(text)) return 'string'
    if (text === '~' || /^null$/iu.test(text)) return 'null'
    return /^(?:yes|true|on|no|false|off)$/iu.test(text) ? 'boolean' : 'string'
  }
  if (TIME.test(text)) return 'time'
  if (DATE.test(text)) return 'date'
  if (/^[-+]?\.inf$/iu.test(text) || /^\.nan$/iu.test(text)) return 'float'
  if (/^:./u.test(text)) return 'symbol'
  if (SEXAGESIMAL.test(text)) return 'number'
  if (FLOAT.test(text) && !/^[-+]?\.$/u.test(text)) return 'float'
  if (INTEGERS.some((re) => re.test(text))) return 'integer'
  return 'string'
}

const ESCAPES = { 0: '\0', a: '\u0007', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\u001B', ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\u0085', _: '\u00A0', L: '\u2028', P: '\u2029' }
const HEX = { x: 2, u: 4, U: 8 }

// Where on `text`, at its quote, a quoted scalar ends, past its closing
// quote; undefined where it goes on past the line.
export function closingQuote(text) {
  const double = text[0] === '"'
  for (let i = 1; i < text.length; i++) {
    if (double && text[i] === '\\') i++
    else if (!double && text[i] === "'" && text[i + 1] === "'") i++
    else if (text[i] === text[0]) return i + 1
  }
  return undefined
}

// A double-quoted scalar's escape at `text[i]`, its `\`: what it stands
// for and how many characters it takes.
function escape(text, i, fail) {
  const next = text[i + 1]
  if (Object.hasOwn(HEX, next)) {
    const digits = text.slice(i + 2, i + 2 + HEX[next])
    if (!/^[\dA-Fa-f]+$/u.test(digits) || digits.length !== HEX[next]) fail(`a bad \\${next} escape`)
    const code = Number.parseInt(digits, 16)
    if (code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) fail(`\\${next}${digits}, which is no character`)
    return [String.fromCodePoint(code), 2 + HEX[next]]
  }
  if (!Object.hasOwn(ESCAPES, next)) fail(`${quote(`\\${next}`)}, an escape YAML does not have`)
  return [ESCAPES[next], 2]
}

// One line of a quoted scalar: what it holds, and where on it the scalar
// ends, or `escapedBreak` where it ends in a `\`; `escaped` how much of it
// is up to its last escape, which no trailing white space is trimmed of.
function scanLine(text, double, fail) {
  let piece = ''
  let escaped = 0
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === (double ? '"' : "'") && (double || text[i + 1] !== "'")) return { piece, end: i + 1 }
    if (!double && char === "'") {
      piece += "'"
      i++
    } else if (double && char === '\\' && i === text.length - 1) {
      return { piece, escapedBreak: true }
    } else if (double && char === '\\') {
      const [value, length] = escape(text, i, fail)
      piece += value
      escaped = piece.length
      i += length - 1
    } else {
      piece += char
    }
  }
  return { piece, escaped }
}

// A single- or double-quoted scalar over `lines`, its first at its quote,
// folded as YAML folds one: its value, how many lines it takes, and where
// on the last it ends.
export function scanQuoted(lines, fail) {
  const double = lines[0][0] === '"'
  let value = ''
  let blanks = 0
  let escapedBreak = false
  for (let n = 0; n < lines.length; n++) {
    const text = n === 0 ? lines[0].slice(1) : lines[n].replace(/^[ \t]+/u, '')
    if (n > 0 && text === '') {
      blanks++
      continue
    }
    if (n > 0) value += escapedBreak || blanks > 0 ? '\n'.repeat(blanks) : ' '
    blanks = 0
    const line = scanLine(text, double, (detail) => fail(detail, n))
    if (line.end !== undefined) return { value: value + line.piece, lines: n + 1, end: lines[n].length - text.length + line.end }
    escapedBreak = line.escapedBreak === true
    value += escapedBreak ? line.piece : line.piece.slice(0, line.escaped) + line.piece.slice(line.escaped).replace(/[ \t]+$/u, '')
  }
  return fail('a quoted scalar with no closing quote', 0)
}

// Flow scalar lines, trimmed, folded: a break between two lines a space,
// each blank line between them a newline.
export function fold(parts) {
  let value = parts[0]
  let blanks = 0
  for (const part of parts.slice(1)) {
    if (part === '') {
      blanks++
      continue
    }
    value += (blanks === 0 ? ' ' : '\n'.repeat(blanks)) + part
    blanks = 0
  }
  return value
}

// A folded block scalar's lines: a break between two lines of text a
// space; one before or after a more indented line kept.
function foldBlock(lines) {
  let value = ''
  let blanks = 0
  let previous
  for (const line of lines) {
    if (line === '') {
      blanks++
      continue
    }
    const kind = /^[ \t]/u.test(line) ? 'more' : 'text'
    if (previous === undefined) value += '\n'.repeat(blanks)
    else if (kind === 'text' && previous === 'text') value += blanks === 0 ? ' ' : '\n'.repeat(blanks)
    else value += '\n'.repeat(blanks + 1)
    value += line
    previous = kind
    blanks = 0
  }
  return value
}

const isBlank = (line) => /^ *$/u.test(line)
const indentOf = (line) => /^ */u.exec(line)[0].length

// A block scalar whose header, `|` or `>`, its indentation indicator and
// its chomping, is `header`, and whose lines, `lines`, follow it, of a node
// under `parent`: its value, and how many of the lines it takes.
export function blockScalar(lines, header, parent, fail) {
  const m = /^([|>])(?:([1-9])([+-])?|([+-])([1-9])?)?$/u.exec(header)
  if (m === null) fail(`${quote(header)} is no block scalar header as Psych writes one`, -1)
  const [, style, m1, c1, c2, m2] = m
  const chomp = c1 ?? c2 ?? ''
  const base = Math.max(parent, 0)
  let indent = m1 ?? m2
  if (indent === undefined) {
    const first = lines.findIndex((line) => !isBlank(line))
    indent = Math.max(first === -1 ? base + 1 : indentOf(lines[first]), parent + 1)
    for (let i = 0; i < first; i++) if (lines[i].length > indent) fail('a blank line deeper than the block scalar it leads', i)
  } else {
    indent = base + Number(indent)
  }
  const content = []
  for (const line of lines) {
    if (isBlank(line) && line.length <= indent) content.push('')
    else if (indentOf(line) >= indent) content.push(line.slice(indent))
    else break
  }
  const taken = content.length
  let trailing = 0
  while (content.length > 0 && content.at(-1) === '') {
    content.pop()
    trailing++
  }
  const body = style === '|' ? content.join('\n') : foldBlock(content)
  const keep = chomp === '+' ? '\n'.repeat(trailing) : ''
  const end = chomp === '-' ? '' : content.length === 0 ? keep : `\n${keep}`
  return { value: body + end, lines: taken }
}
