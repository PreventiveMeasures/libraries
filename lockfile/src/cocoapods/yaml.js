// The YAML a Podfile.lock is in, as CocoaPods' YAMLHelper writes it and
// Psych reads it back: block mappings and sequences, and a sequence under
// the key of a sequence's entry at the key's own column; plain scalars of
// the characters YAMLHelper writes plain, single-quoted ones, and
// double-quoted ones as Ruby's String#inspect writes them, with `\"` and
// `\\` alone. Each scalar is typed as Psych types it: a string, a symbol
// (`:git`), true or false. What Psych reads as anything else, a number, a
// date, a time or null, is refused: no field of a Podfile.lock holds one.
// Comments, anchors, tags, flow collections but an empty one, and every
// form YAMLHelper does not write are refused too; what it would lay out
// otherwise is for layout.js, which writes what was read back as
// YAMLHelper would.
//
// A mapping is `{ kind: 'map', entries: [{ key, value }] }`, its keys
// scalars; a sequence `{ kind: 'seq', items }`; a scalar `{ kind:
// 'scalar', type, value, line }`, of the line it is on, from zero.

import { quote } from '../error.js'
import { advance, fail, lines } from '../lines.js'
import { PLAIN, SYMBOL } from './layout.js'
import { psychRead } from './psych.js'

// What YAMLHelper writes raw, all else being escaped or refused: letters,
// marks, numbers, punctuation, symbols and spaces. So no control, format,
// private-use or unassigned character, and no line or paragraph separator,
// which Ruby's String#inspect escapes, if it does not write it raw.
const FORBIDDEN = /[^\p{L}\p{M}\p{N}\p{P}\p{S}\p{Zs}]/u

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

// A plain scalar, of the characters YAMLHelper writes plain, as Psych
// reads it: not where it would read the end of one, or a mapping.
function readPlain(text, number) {
  if (SYMBOL.test(text)) return scalar('symbol', text.slice(1), number)
  if (!PLAIN.test(text) || text.endsWith(' ') || text.endsWith(':') || text.includes(': ')) {
    throw fail(`${quote(text)} is not a scalar as CocoaPods writes one`, number)
  }
  const { type, value } = psychRead(text)
  if (type !== 'string' && type !== 'boolean') throw fail(`${quote(text)}, which Psych reads as ${type}, where a Podfile.lock holds a string, a symbol, true or false`, number)
  return scalar(type, value, number)
}

// A value on the line, after `key: ` or `- `, or on a line of its own:
// an empty sequence or mapping, as YAMLHelper writes one, is `[]` or `{}`.
function readValue(text, number) {
  if (text === '[]') return { kind: 'seq', items: [] }
  if (text === '{}') return { kind: 'map', entries: [] }
  if (text.startsWith('"') || text.startsWith("'")) {
    const [value, rest] = readQuoted(text, number)
    if (rest !== '') throw fail(`${quote(rest)} after a quoted scalar`, number)
    return value
  }
  return readPlain(text, number)
}

// `key:` or `key: value` at the start of `text`, with the text of the
// value, or null where `text` is not a mapping entry.
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
  return { key, value }
}

function checkDepth(src, depth) {
  if (depth > MAX_DEPTH) throw fail('nested deeper than a Podfile.lock is', src.current.number)
}

// A mapping or a sequence whose lines are at `indent`, or an empty one,
// which YAMLHelper writes on a line of its own under its key.
function parseNode(src, indent, depth) {
  const { number, text } = src.current
  if (text !== '[]' && text !== '{}') return (isEntry(text) ? parseSeq : parseMap)(src, indent, depth)
  next(src)
  return readValue(text, number)
}

// A mapping at `indent`, its first entry already read where `entry` is, as
// in a sequence's entry. A sequence under a key may sit at the key's own
// column. A line deeper than the mapping ends it, and the file's end
// refuses it.
function parseMap(src, indent, depth, entry) {
  checkDepth(src, depth)
  const map = { kind: 'map', entries: [] }
  const seen = new Set()
  do {
    const { number, text } = src.current
    entry ??= readKey(text, number)
    if (entry === null) throw fail(`expected a mapping key, found ${quote(text)}`, number)
    const { key } = entry
    const id = `${key.type}:${key.value}`
    if (seen.has(id)) throw fail(`a second ${quote(String(key.value))}`, number)
    seen.add(id)
    next(src)
    let value
    if (entry.value !== '') value = readValue(entry.value, number)
    else if (src.current?.indent > indent) value = parseNode(src, src.current.indent, depth + 1)
    else if (src.current?.indent === indent && isEntry(src.current.text)) value = parseSeq(src, indent, depth + 1)
    else throw fail(`nothing under ${quote(String(key.value))}`, number)
    map.entries.push({ key, value })
    entry = undefined
  } while (src.current?.indent === indent)
  return map
}

function parseSeq(src, indent, depth) {
  checkDepth(src, depth)
  const seq = { kind: 'seq', items: [] }
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

// The mapping a Podfile.lock is, and whether its lines end in CRLF.
export function parseCocoaYaml(text) {
  const src = lines(text, FORBIDDEN)
  next(src)
  if (src.current === undefined) throw fail('an empty file, where CocoaPods writes its version at least', 0)
  if (src.current.indent !== 0 || isEntry(src.current.text)) throw fail('expected a mapping at column 0', src.current.number)
  const root = parseMap(src, 0, 0)
  if (src.current !== undefined) throw fail('bad indentation', src.current.number)
  return { root, crlf: src.crlf === true }
}
