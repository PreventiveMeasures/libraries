// The YAML a Podfile.lock is in, as CocoaPods' YAMLHelper writes it and
// Psych reads it back: block mappings and sequences, and a sequence under
// the key of a sequence's entry at the key's own column; plain scalars of
// the characters YAMLHelper writes plain, single-quoted ones, and
// double-quoted ones as Ruby's String#inspect writes them, with `\"` and
// `\\` alone. Each scalar is typed as Psych types it: a string, a symbol
// (`:git`), true or false. What Psych reads as anything else, a number, a
// date, a time or null, is refused: no field of a Podfile.lock holds one.
// Comments, anchors, tags, flow collections and every form YAMLHelper
// does not write are refused too; what it would lay out otherwise is for
// layout.js, which writes what was read back as YAMLHelper would.
//
// A mapping is `{ kind: 'map', entries: [{ key, value }] }`, its keys
// scalars; a sequence `{ kind: 'seq', items }`; a scalar `{ kind:
// 'scalar', type, value }`. Each has the `line` it starts on, from zero.

import { quote } from '../error.js'
import { advance, fail, lines } from '../lines.js'
import { psychType } from './psych.js'

// What YAMLHelper writes raw, all else being escaped or refused: letters,
// marks, numbers, punctuation, symbols and spaces. So no control, format,
// private-use or unassigned character, and no line or paragraph separator,
// which Ruby's String#inspect escapes, if it does not write it raw.
const FORBIDDEN = /[^\p{L}\p{M}\p{N}\p{P}\p{S}\p{Zs}]/u

// A string YAMLHelper writes plain, and a symbol as YAML.dump writes one.
const PLAIN = /^\w[\w/ ()~<>=.:`,-]*$/u
const SYMBOL = /^:[a-z_][a-z0-9_]*$/u
const DOUBLE = /^"((?:[^"\\]|\\.)*)"/u
const SINGLE = /^'((?:[^']|'')*)'/u
const MAX_DEPTH = 8
// A scalar some 2^23 characters long runs V8's regex engine out of
// backtracking stack, which is a RangeError, so a line is held to well
// below that, as yaml/parse.js holds one.
const MAX_LINE = 2 ** 20

const isEntry = (text) => text === '-' || text.startsWith('- ')

// The next line with anything on it, as `{ indent, text, number }`.
function next(src) {
  for (advance(src); src.line !== undefined; advance(src)) {
    if (src.line.length > MAX_LINE) throw fail(`a line longer than ${MAX_LINE} characters`, src.number)
    const indent = /^ */u.exec(src.line)[0].length
    const text = src.line.slice(indent)
    if (text === '') continue
    if (text.startsWith('#')) throw fail('a comment, which CocoaPods does not write', src.number)
    src.current = { indent, text, number: src.number }
    return
  }
  src.current = undefined
}

function unescape(raw, number) {
  return raw.replace(/\\(.)/gu, (escape, char) => {
    if (char === '"' || char === '\\') return char
    throw fail(`${quote(escape)}, an escape this reader does not take: CocoaPods writes \\# before {, $ and @, which Psych does not read back`, number)
  })
}

const scalar = (type, value, number) => ({ kind: 'scalar', type, value, line: number })

// A quoted scalar at the start of `text`, and what follows it.
function readQuoted(text, number) {
  const double = DOUBLE.exec(text)
  if (double !== null) return [scalar('string', unescape(double[1], number), number), text.slice(double[0].length)]
  const single = SINGLE.exec(text)
  if (single !== null) return [scalar('string', single[1].replaceAll("''", "'"), number), text.slice(single[0].length)]
  throw fail(`a quoted scalar with no closing quote in ${quote(text)}`, number)
}

function readPlain(text, number) {
  if (SYMBOL.test(text)) return scalar('symbol', text.slice(1), number)
  if (!PLAIN.test(text) || text.endsWith(' ') || text.endsWith(':') || text.includes(': ')) {
    throw fail(`${quote(text)} is not a scalar as CocoaPods writes one`, number)
  }
  const type = psychType(text)
  if (type === 'string' || type === 'boolean') return scalar(type, type === 'boolean' ? /^(?:yes|true|on)$/iu.test(text) : text, number)
  throw fail(`${quote(text)}, which Psych reads as ${type}, where a Podfile.lock holds a string, a symbol, true or false`, number)
}

// A value on the line, after `key: ` or `- `.
function readValue(text, number) {
  if (text.startsWith('"') || text.startsWith("'")) {
    const [value, rest] = readQuoted(text, number)
    if (rest !== '') throw fail(`${quote(rest)} after a quoted scalar`, number)
    return value
  }
  return readPlain(text, number)
}

// `key:` or `key: value` at the start of `text`, or null where `text` is
// not a mapping entry.
function readKey(text, number) {
  let key
  let rest
  if (text.startsWith('"') || text.startsWith("'")) {
    [key, rest] = readQuoted(text, number)
    if (rest !== ':' && !rest.startsWith(': ')) return null
  } else {
    const colon = /:(?: |$)/u.exec(text)
    if (colon === null) return null
    key = readPlain(text.slice(0, colon.index), number)
    rest = text.slice(colon.index)
  }
  const value = rest.slice(2)
  if (value.startsWith(' ')) throw fail('more than one space after ":"', number)
  return { key, rest: value }
}

const keyOf = (key) => `${key.type}:${key.value}`

// A mapping at `indent`, its first entry already read where `first` is,
// as in a sequence's entry. A sequence under a key may sit at the key's
// own column.
function deep(src, depth) {
  if (depth > MAX_DEPTH) throw fail('nested deeper than a Podfile.lock is', src.current.number)
}

function parseMap(src, indent, depth, first) {
  deep(src, depth)
  const map = { kind: 'map', entries: [], line: src.current.number }
  const seen = new Set()
  for (let entry = first; entry !== undefined || src.current?.indent === indent; entry = undefined) {
    const { number, text } = src.current
    entry ??= readKey(text, number)
    if (entry === null) throw fail(`expected a mapping key, found ${quote(text)}`, number)
    if (seen.has(keyOf(entry.key))) throw fail(`a second ${quote(String(entry.key.value))}`, number)
    seen.add(keyOf(entry.key))
    next(src)
    let value
    if (entry.rest !== '') value = readValue(entry.rest, number)
    else if (src.current?.indent > indent) value = parseBlock(src, src.current.indent, depth + 1)
    else if (src.current?.indent === indent && isEntry(src.current.text)) value = parseSeq(src, indent, depth + 1)
    else throw fail(`nothing under ${quote(String(entry.key.value))}`, number)
    map.entries.push({ key: entry.key, value })
  }
  return map
}

function parseSeq(src, indent, depth) {
  deep(src, depth)
  const seq = { kind: 'seq', items: [], line: src.current.number }
  while (src.current?.indent === indent && isEntry(src.current.text)) {
    const { number, text } = src.current
    const rest = text.slice(2)
    if (rest === '' || rest.startsWith(' ')) throw fail('expected one space and a value after "-"', number)
    const entry = readKey(rest, number)
    if (entry === null) {
      seq.items.push(readValue(rest, number))
      next(src)
    } else {
      seq.items.push(parseMap(src, indent + 2, depth + 1, entry))
    }
  }
  return seq
}

function parseBlock(src, indent, depth) {
  const block = isEntry(src.current.text) ? parseSeq(src, indent, depth) : parseMap(src, indent, depth)
  if (src.current?.indent > indent) throw fail('bad indentation', src.current.number)
  return block
}

// The mapping a Podfile.lock is, and whether its lines end in CRLF.
export function parseCocoaYaml(text) {
  const src = lines(text, FORBIDDEN)
  next(src)
  if (src.current === undefined) throw fail('an empty file, where CocoaPods writes its version at least', 0)
  if (src.current.indent !== 0 || isEntry(src.current.text)) throw fail('expected a mapping at column 0', src.current.number)
  const root = parseBlock(src, 0, 0)
  if (src.current !== undefined) throw fail('bad indentation', src.current.number)
  return { root, crlf: src.crlf === true }
}
