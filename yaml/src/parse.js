// A YAML document read into the data it carries — mappings, sequences and
// scalars — and nothing else. What is accepted is the subset pnpm's lockfile
// writer produces (js-yaml, with the settings pnpm gives it), plus comments,
// since a hand-written file such as pnpm-workspace.yaml has them. Everything
// beyond that is refused with a YamlError naming the line: anchors and
// aliases, tags, directives and document markers, folded block scalars, a
// sequence at the indent of its key, and every scalar spelling the core
// schema would type but JS itself never prints. There is no schema to extend
// and no way for a document to yield anything but strings, numbers,
// booleans, null, arrays and null-prototype objects.
//
// The structure is read line by line: indentation alone says where a block
// starts and ends, so each line is kept as its indent and what follows, and
// the readers below walk that list with one cursor. A mapping or sequence
// owns every line at its indent, hands a deeper line to a nested reader and
// stops at a shallower one. The values on a line — scalars and the flow
// collections `{k: v}` and `[a, b]` — are scalar.js's, and nothing here
// looks inside them.

import { YamlError } from './error.js'
import { parseInline, readKey } from './scalar.js'

// Deeper than any document has a reason to be, and the bound on the
// recursion below: a line of a thousand spaces is not a stack overflow.
const MAX_DEPTH = 64

export function parseYaml(text) {
  if (typeof text !== 'string') throw new TypeError('parseYaml expects a string')
  const doc = { lines: splitLines(text), at: 0 }
  const first = peek(doc)
  if (first === undefined) throw new YamlError('empty document')
  if (first.indent !== 0) throw new YamlError('the document does not start at column 0', first.number)
  const value = parseNode(doc, 0, 0)
  const rest = peek(doc)
  if (rest !== undefined) throw new YamlError('unexpected content', rest.number)
  if (typeof value !== 'object' || value === null) throw new YamlError('the document is a lone scalar, not a mapping or a sequence')
  return value
}

// Lines are kept raw — the indent, then everything after it, trailing spaces
// and all, since inside a `|` block those are content. A CRLF line ending is
// taken; any other control character, a tab included, is refused wherever it
// is, as is a byte order mark. YAML forbids tabs in indentation and js-yaml
// escapes every one of these elsewhere, so in a lockfile they are damage,
// and a mark at the start would otherwise read as part of the first key.
function splitLines(text) {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines.map((raw, number) => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (/[\p{Cc}\uFEFF]/u.test(line)) throw new YamlError('control character or byte order mark', number)
    const indent = /^ */u.exec(line)[0].length
    return { indent, text: line.slice(indent), number }
  })
}

// The next line with something on it: blank lines and comment lines are
// nothing to the structure, wherever they fall.
function peek(doc) {
  while (doc.at < doc.lines.length && /^(?:#|$)/u.test(doc.lines[doc.at].text)) doc.at++
  return doc.lines[doc.at]
}

const isEntry = (line) => /^-(?: |$)/u.test(line.text)
const isBlockScalar = (rest) => /^[|>]/u.test(rest)
const MARKER = /^(?:---|\.\.\.)(?: |$)|^%/u

// One node, of whatever kind the line at the cursor opens: `- ` a sequence,
// `? ` or `key:` a mapping, anything else a value on that one line.
function parseNode(doc, indent, depth) {
  const line = peek(doc)
  if (depth > MAX_DEPTH) throw new YamlError('nested too deep', line.number)
  if (MARKER.test(line.text)) throw new YamlError('document markers and directives are not supported', line.number)
  if (isEntry(line)) return parseSequence(doc, indent, depth)
  if (line.text.startsWith('? ') || readKey(line.text, line.number) !== null) return parseMapping(doc, indent, depth)
  doc.at++
  return parseInline(line.text, line.number)
}

// Entries are `key: value`, or js-yaml's `? key` above `: value` for a key
// longer than 1024 characters, which a package with many peers can reach.
function parseMapping(doc, indent, depth) {
  const map = Object.create(null)
  let line = peek(doc)
  while (line?.indent === indent) {
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
    if (typeof key !== 'string') throw new YamlError('keys must be strings', line.number)
    if (key in map) throw new YamlError(`duplicate key ${key}`, line.number)
    map[key] = value
    line = peek(doc)
  }
  if (line !== undefined && line.indent > indent) throw new YamlError('bad indentation', line.number)
  return map
}

function parseSequence(doc, indent, depth) {
  const list = []
  let line = peek(doc)
  while (line?.indent === indent) {
    if (!isEntry(line)) throw new YamlError(`expected "- ", found ${JSON.stringify(line.text.slice(0, 24))}`, line.number)
    list.push(parseCompact(doc, line, indent, depth))
    line = peek(doc)
  }
  if (line !== undefined && line.indent > indent) throw new YamlError('bad indentation', line.number)
  return list
}

// What follows `key: ` on the line, or is missing from it.
function parseValue(doc, rest, indent, depth, owner) {
  if (rest === '') return parseNested(doc, indent, depth, owner)
  if (isBlockScalar(rest)) return readLiteral(doc, rest, indent, owner)
  return parseInline(rest, owner.number)
}

// What follows `- ` or `: ` on the line is a node of its own that begins at
// that column — YAML's compact notation, the form js-yaml writes a mapping
// inside a sequence in. Reading it as though it stood on a line of its own
// at that column is exactly what the notation means, so the line is
// rewritten in place and read again. A `|` block is the one thing read here
// instead, its content being measured against the enclosing block rather
// than the column; nothing after the indicator means the node is the deeper
// block below.
function parseCompact(doc, line, indent, depth) {
  const spaces = /^[-:] */u.exec(line.text)[0].length
  const rest = line.text.slice(spaces)
  if (rest !== '' && !isBlockScalar(rest)) {
    doc.lines[doc.at] = { indent: line.indent + spaces, text: rest, number: line.number }
    return parseNode(doc, line.indent + spaces, depth + 1)
  }
  doc.at++
  return rest === '' ? parseNested(doc, indent, depth, line) : readLiteral(doc, rest, indent, line)
}

// A value on the lines below has to sit deeper than what it belongs to. A
// sequence at the indent of its key is valid YAML that js-yaml never writes,
// and gets its own message since the general one would mislead.
function parseNested(doc, indent, depth, owner) {
  const next = peek(doc)
  if (next?.indent === indent && isEntry(next)) throw new YamlError('a sequence under a key must be indented', next.number)
  if (next === undefined || next.indent <= indent) throw new YamlError('missing value', owner.number)
  return parseNode(doc, next.indent, depth + 1)
}

// `|` keeps every line break, and is the only block scalar pnpm writes: what
// js-yaml does with a string that has a line break in it, a deprecation
// notice for one. `>` folds them and is refused. The header may end in a
// chomping indicator — `-` drops the final line break, `+` keeps every
// trailing one, neither keeps exactly one — and js-yaml also puts the
// indentation there when the text opens with a space, since the first line
// then cannot show where the content starts. Content is every following line
// deeper than the enclosing block, blank lines included wherever they are;
// the trailing blank ones are the indicator's to keep or drop.
function readLiteral(doc, header, indent, owner) {
  const m = /^\|([1-9]?)([+-]?)$/u.exec(header)
  if (m === null) throw new YamlError(`unsupported block scalar ${JSON.stringify(header)}`, owner.number)
  const raw = []
  while (doc.at < doc.lines.length && (doc.lines[doc.at].text === '' || doc.lines[doc.at].indent > indent)) raw.push(doc.lines[doc.at++])
  const first = raw.find((line) => line.text !== '')
  const inner = m[1] === '' ? (first?.indent ?? indent + 1) : indent + Number(m[1])
  const lines = raw.map((line) => {
    if (line.text !== '' && line.indent < inner) throw new YamlError('bad indentation in the block scalar', line.number)
    return ' '.repeat(Math.max(line.indent - inner, 0)) + line.text
  })
  let end = lines.length
  while (end > 0 && lines[end - 1] === '') end--
  const clipped = lines.slice(0, end).join('\n')
  if (m[2] === '-') return clipped
  if (m[2] === '+') return lines.length === 0 ? '' : `${lines.join('\n')}\n`
  return clipped === '' ? '' : `${clipped}\n`
}
