// The subset of YAML that pnpm writes lockfiles in, plus comments: block and
// flow mappings and sequences, plain and quoted scalars, `|` block scalars,
// and js-yaml's `? key` form for keys over 1024 characters. Anchors, aliases,
// tags, directives, document markers, `>` folded scalars, nested or
// multi-line flow collections, tabs, duplicate keys and the `<<` merge key
// are refused, as is any plain scalar the core schema would type by a rule
// not implemented here (`~`, `TRUE`, `0x1F`, `.inf`, ...) and any js-yaml
// would read as a date. Mappings come back with a null prototype. A stream of
// documents, each after a `---` line, is what pnpm 12 writes when the project
// pins its package manager: that manager's own lockfile first, the project's
// second.

import { YamlError } from './error.js'
import { parseInline, readKey, setKey } from './scalar.js'

const MAX_DEPTH = 64
// A scalar some 2^23 characters long runs V8's regex engine out of
// backtracking stack, which is a RangeError rather than a YamlError, so a
// line is held to well below that.
const MAX_LINE = 2 ** 20

export function parseYaml(text) {
  const docs = parseYamlStream(text)
  if (docs.length !== 1) throw new YamlError(`expected a single document, found ${docs.length}`)
  return docs[0]
}

export function parseYamlStream(text) {
  if (typeof text !== 'string') throw new TypeError('parseYaml expects a string')
  const doc = { lines: splitLines(text), at: 0 }
  const docs = []
  skipMarker(doc)
  do docs.push(parseDocument(doc)); while (skipMarker(doc))
  return docs
}

// Steps over a `---` line when one is next, and says whether it did.
function skipMarker(doc) {
  if (peek(doc) !== undefined || doc.at === doc.lines.length) return false
  doc.at++
  return true
}

function parseDocument(doc) {
  const first = peek(doc)
  if (first === undefined) throw new YamlError('empty document', doc.lines[doc.at]?.number)
  if (first.indent !== 0) throw new YamlError('the document does not start at column 0', first.number)
  const value = parseNode(doc, 0, 0)
  const rest = peek(doc)
  if (rest !== undefined) throw new YamlError('unexpected content after the document', rest.number)
  if (typeof value !== 'object' || value === null) throw new YamlError('the document is a lone scalar, not a mapping or a sequence')
  return value
}

// Tabs and other control characters are refused everywhere: pnpm never
// writes them raw, and a byte order mark would read as part of the first key.
// So are the lone surrogates, U+FFFE and U+FFFF that js-yaml refuses, and
// U+2028 and U+2029, which end a line to a YAML 1.1 reader.
const FORBIDDEN = /[\p{Cc}\p{Cs}\uFEFF\uFFFE\uFFFF\u2028\u2029]/u

function splitLines(text) {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines.map((raw, number) => {
    const line = raw.replace(/\r$/u, '')
    if (line.length > MAX_LINE) throw new YamlError(`line longer than ${MAX_LINE} characters`, number)
    const char = FORBIDDEN.exec(line)?.[0]
    if (char !== undefined) throw new YamlError(`U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')} is not allowed`, number)
    const indent = /^ */u.exec(line)[0].length
    return { indent, text: line.slice(indent), number }
  })
}

// At column 0, a line that opens with `---` is a document marker, refused
// with anything but spaces after it: at the start of a document js-yaml reads
// `---x: 1` as the marker and then `x: 1`, where YAML reads the key `---x`.
// A `...` there ends the document even where a key could be read instead,
// and js-yaml writes keys like `... k` unquoted; that and a `%` directive are
// refused outright.
const END_OR_DIRECTIVE = /^\.\.\.(?: |$)|^%/u

// The next line of the document with something on it: blank and comment
// lines are skipped, and a `---` line ends the document, for the stream
// reader alone to step over.
function peek(doc) {
  while (doc.at < doc.lines.length && /^(?:#|$)/u.test(doc.lines[doc.at].text)) doc.at++
  const line = doc.lines[doc.at]
  if (line?.indent !== 0) return line
  if (END_OR_DIRECTIVE.test(line.text)) throw new YamlError('document end markers and directives are not supported', line.number)
  if (!line.text.startsWith('---')) return line
  if (!/^--- *$/u.test(line.text)) throw new YamlError('content on the document marker line', line.number)
  return undefined
}

const isEntry = (line) => /^-(?: |$)/u.test(line.text)
const isBlockScalar = (rest) => /^[|>]/u.test(rest)
// The indicator, its spaces, and a comment when that is all that follows.
const COMPACT = /^[-:] *(?:#.*)?/u

function parseNode(doc, indent, depth) {
  const line = peek(doc)
  if (depth > MAX_DEPTH) throw new YamlError('nested too deep', line.number)
  if (isEntry(line)) return parseSequence(doc, indent, depth)
  if (line.text.startsWith('? ') || readKey(line.text, line.number) !== null) return parseMapping(doc, indent, depth)
  doc.at++
  return parseInline(line.text, line.number)
}

// Every line at the indent is an entry; a deeper one after the last is an error.
function parseBlock(doc, indent, entry) {
  let line = peek(doc)
  while (line?.indent === indent) {
    entry(line)
    line = peek(doc)
  }
  if (line !== undefined && line.indent > indent) throw new YamlError('bad indentation', line.number)
}

function parseMapping(doc, indent, depth) {
  const map = Object.create(null)
  parseBlock(doc, indent, (line) => {
    let key, value
    if (line.text.startsWith('? ')) {
      doc.at++
      key = parseInline(line.text.slice(2), line.number)
      const next = peek(doc)
      if (next?.indent !== indent || !/^:(?: |$)/u.test(next.text)) throw new YamlError('expected ": " below the explicit key', (next ?? line).number)
      value = parseCompact(doc, next, indent, depth)
    } else {
      const entry = readKey(line.text, line.number)
      if (entry === null) throw new YamlError(`expected a mapping key, found ${JSON.stringify(line.text.slice(0, 24))}`, line.number)
      doc.at++
      key = entry.key
      value = parseValue(doc, entry.rest, indent, depth, line)
    }
    setKey(map, key, value, line.number)
  })
  return map
}

function parseSequence(doc, indent, depth) {
  const list = []
  parseBlock(doc, indent, (line) => {
    if (!isEntry(line)) throw new YamlError(`expected "- ", found ${JSON.stringify(line.text.slice(0, 24))}`, line.number)
    list.push(parseCompact(doc, line, indent, depth))
  })
  return list
}

// What follows `key: `, `- ` or `: `: a block scalar, a node on the line, or,
// when nothing does, the deeper block below. YAML lets the entries of a
// sequence under a key sit at the key's own column; after `- ` they are the
// next entries of the same sequence.
function parseValue(doc, rest, indent, depth, owner) {
  if (isBlockScalar(rest)) return readLiteral(doc, rest, indent, owner)
  if (rest !== '') return parseInline(rest, owner.number)
  const next = peek(doc)
  if (next?.indent === indent && isEntry(next) && !isEntry(owner)) throw new YamlError('a sequence under a key must be indented', next.number)
  if (next === undefined || next.indent <= indent) throw new YamlError('missing value', owner.number)
  return parseNode(doc, next.indent, depth + 1)
}

// After `- ` or `: ` a node may begin mid-line, with its further entries at
// that column below (`- a: 1` then `  b: 2`), so the line is reread as though
// it started at that column.
function parseCompact(doc, line, indent, depth) {
  const spaces = COMPACT.exec(line.text)[0].length
  const rest = line.text.slice(spaces)
  if (rest === '' || isBlockScalar(rest)) {
    doc.at++
    return parseValue(doc, rest, indent, depth, line)
  }
  doc.lines[doc.at] = { ...line, indent: line.indent + spaces, text: rest }
  return parseNode(doc, line.indent + spaces, depth + 1)
}

// `|` with an optional indentation digit and chomping indicator: `-` drops
// every trailing line break, `+` keeps them all, neither keeps exactly one.
// Content is every line deeper than the enclosing block, blank ones included.
// Without the digit, its indentation is the deepest of the lines up to the
// first that is not blank: a blank line above that one may not be deeper, and
// blank lines alone make an empty scalar, both as YAML and js-yaml have it.
function readLiteral(doc, header, indent, owner) {
  const m = /^\|([1-9]?)([+-]?)$/u.exec(header)
  if (m === null) throw new YamlError(`unsupported block scalar ${JSON.stringify(header)}`, owner.number)
  const raw = []
  while (doc.at < doc.lines.length && (doc.lines[doc.at].text === '' || doc.lines[doc.at].indent > indent)) raw.push(doc.lines[doc.at++])
  let inner = indent + Number(m[1])
  if (m[1] === '') {
    for (const line of raw) {
      inner = Math.max(inner, line.indent)
      if (line.text !== '') break
    }
  }
  const text = raw.map((line) => {
    if (line.text !== '' && line.indent < inner) throw new YamlError('bad indentation in the block scalar', line.number)
    return `${' '.repeat(Math.max(line.indent - inner, 0))}${line.text}\n`
  }).join('')
  let end = text.length
  while (end > 0 && text[end - 1] === '\n') end--
  const body = text.slice(0, end)
  return m[2] === '+' ? text : m[2] === '-' ? body : body && `${body}\n`
}
