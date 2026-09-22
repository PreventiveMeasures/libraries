// The subset of YAML that pnpm writes lockfiles in, plus comments: block and
// flow mappings and sequences, plain and quoted scalars, `|` block scalars,
// and js-yaml's `? key` form for keys over 1024 characters. Anchors, aliases,
// tags, directives, document markers, `>` folded scalars, nested or
// multi-line flow collections, tabs and duplicate keys are refused, as is any
// plain scalar the core schema would type by a rule not implemented here
// (`~`, `TRUE`, `0x1F`, `.inf`, ...). Mappings come back with a null
// prototype.

import { YamlError } from './error.js'
import { parseInline, readKey, setKey } from './scalar.js'

const MAX_DEPTH = 64

export function parseYaml(text) {
  const doc = { lines: splitLines(text), at: 0 }
  const first = peek(doc)
  if (first === undefined) throw new YamlError('empty document')
  if (first.indent !== 0) throw new YamlError('the document does not start at column 0', first.number)
  const value = parseNode(doc, 0, 0)
  if (typeof value !== 'object' || value === null) throw new YamlError('the document is a lone scalar, not a mapping or a sequence')
  return value
}

// Tabs and other control characters are refused everywhere: pnpm never
// writes them raw, and a byte order mark would read as part of the first key.
function splitLines(text) {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines.map((raw, number) => {
    const line = raw.replace(/\r$/u, '')
    if (/[\p{Cc}\uFEFF]/u.test(line)) throw new YamlError('control character or byte order mark', number)
    const indent = /^ */u.exec(line)[0].length
    return { indent, text: line.slice(indent), number }
  })
}

function peek(doc) {
  while (doc.at < doc.lines.length && /^(?:#|$)/u.test(doc.lines[doc.at].text)) doc.at++
  return doc.lines[doc.at]
}

const isEntry = (line) => /^-(?: |$)/u.test(line.text)
const isBlockScalar = (rest) => /^[|>]/u.test(rest)
const MARKER = /^(?:---|\.\.\.)(?: |$)|^%/u

function parseNode(doc, indent, depth) {
  const line = peek(doc)
  if (depth > MAX_DEPTH) throw new YamlError('nested too deep', line.number)
  if (MARKER.test(line.text)) throw new YamlError('document markers and directives are not supported', line.number)
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

function parseValue(doc, rest, indent, depth, owner) {
  if (rest === '') return parseNested(doc, indent, depth, owner)
  if (isBlockScalar(rest)) return readLiteral(doc, rest, indent, owner)
  return parseInline(rest, owner.number)
}

// After `- ` or `: ` a node may begin mid-line, with its further entries at
// that column below (`- a: 1` then `  b: 2`), so the line is reread as though
// it started at that column.
function parseCompact(doc, line, indent, depth) {
  const spaces = /^[-:] */u.exec(line.text)[0].length
  const rest = line.text.slice(spaces)
  if (rest === '' || isBlockScalar(rest)) {
    doc.at++
    return parseValue(doc, rest, indent, depth, line)
  }
  doc.lines[doc.at] = { ...line, indent: line.indent + spaces, text: rest }
  return parseNode(doc, line.indent + spaces, depth + 1)
}

function parseNested(doc, indent, depth, owner) {
  const next = peek(doc)
  if (next?.indent === indent && isEntry(next)) throw new YamlError('a sequence under a key must be indented', next.number)
  if (next === undefined || next.indent <= indent) throw new YamlError('missing value', owner.number)
  return parseNode(doc, next.indent, depth + 1)
}

// `|` with an optional indentation digit and chomping indicator: `-` drops
// every trailing line break, `+` keeps them all, neither keeps exactly one.
// Content is every line deeper than the enclosing block, blank ones included.
function readLiteral(doc, header, indent, owner) {
  const m = /^\|([1-9]?)([+-]?)$/u.exec(header)
  if (m === null) throw new YamlError(`unsupported block scalar ${JSON.stringify(header)}`, owner.number)
  const raw = []
  while (doc.at < doc.lines.length && (doc.lines[doc.at].text === '' || doc.lines[doc.at].indent > indent)) raw.push(doc.lines[doc.at++])
  const inner = m[1] ? indent + Number(m[1]) : (raw.find((line) => line.text !== '')?.indent ?? indent + 1)
  const text = raw.map((line) => {
    if (line.text !== '' && line.indent < inner) throw new YamlError('bad indentation in the block scalar', line.number)
    return `${' '.repeat(Math.max(line.indent - inner, 0))}${line.text}\n`
  }).join('')
  const body = text.replace(/\n+$/u, '')
  return m[2] === '+' ? text : m[2] === '-' ? body : body && `${body}\n`
}
