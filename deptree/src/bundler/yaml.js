// The YAML of a .gem's metadata, as Psych writes it and safe_load reads it;
// what it would read otherwise or refuse is refused. Nodes are { kind:
// 'map', entries }, { kind: 'seq', items } or { kind: 'scalar', type, value }.

import { DeptreeError, quote } from '../error.js'
import { blockScalar, closingQuote, fold, plainType, scanQuoted } from './scalar.js'

const TAGS = new Set(['Specification', 'Version', 'Requirement', 'Dependency', 'Platform', 'Version::Requirement'].map((name) => `!ruby/object:Gem::${name}`))
const SYMBOLS = new Set(['development', 'runtime'])
const MAX_DEPTH = 64

// What libyaml writes raw: no control but a tab, and none of the line
// breaks of YAML 1.1 but LF, which libyaml would read lines by.
const FORBIDDEN = /(?!\t)[\p{Cc}\u2028\u2029\uFEFF\uFFFE\uFFFF]/u

const indentOf = (line) => /^ */u.exec(line)[0].length
const textOf = (line) => line.slice(indentOf(line))
const isBlank = (line) => /^ *$/u.test(line)
const isEntry = (text) => text === '-' || text.startsWith('- ')
// As YAML trims a line of a flow scalar: of spaces and tabs alone.
const trimWhite = (text) => text.replace(/^[ \t]+|[ \t]+$/gu, '')

// Where a plain scalar may not start, as YAML reads it.
const PLAIN_START = /^(?:[-?:](?:[ ]|$)|[,[\]{}#&*!|>'"%@`])/u
const PROPERTY = /^([&!])(\S*)(?: +|$)/u

class Reader {
  constructor(text, where) {
    this.where = where
    this.lines = text.split('\n')
    while (this.lines.length > 0 && isBlank(this.lines.at(-1))) this.lines.pop()
    // The end marker libyaml writes after a document that ends open.
    if (this.lines.length > 1 && this.lines.at(-1) === '...') this.lines.pop()
    this.anchors = new Map()
    this.depth = 0
    for (const [i, line] of this.lines.entries()) {
      if (FORBIDDEN.test(line)) this.fail('a control character, or a line break of YAML 1.1 but LF, which is not supported', i)
    }
  }

  fail(detail, line) {
    throw new DeptreeError(`line ${line + 1}: ${detail}`, this.where)
  }

  content(at) {
    while (at < this.lines.length && isBlank(this.lines[at])) at++
    return at
  }

  // A line's text where a node or an entry starts: no comment, and no tab
  // before it, which YAML reads as neither indentation nor text.
  structural(line) {
    const text = textOf(this.lines[line])
    if (text.startsWith('#')) this.fail('a comment, which Psych does not write', line)
    if (text.startsWith('\t')) this.fail('a tab where a node starts', line)
    return text
  }

  document() {
    const first = this.lines[0] ?? ''
    if (first !== '---' && !first.startsWith('--- ')) this.fail('no `---` first, as Psych writes a document', 0)
    let node
    if (isBlank(first.slice(3))) {
      this.at = this.content(1)
      if (this.at === this.lines.length) this.fail('nothing in the document', 0)
      node = this.block(-1)
    } else {
      node = this.inline(0, 3 + indentOf(first.slice(3)), -1, {})
    }
    if (this.content(this.at) !== this.lines.length) this.fail('more after the document', this.content(this.at))
    return node
  }

  enter(line) {
    if (++this.depth > MAX_DEPTH) this.fail(`nested past ${MAX_DEPTH} levels`, line)
  }

  // A node that starts on a line of its own, at `this.at`, deeper than
  // `parent`.
  block(parent) {
    const line = this.at
    const text = this.structural(line)
    const indent = indentOf(this.lines[line])
    if (isEntry(text)) return this.sequence(indent, line, indent)
    if (this.key(text, line) !== undefined) return this.mapping(indent, line, indent)
    return this.inline(line, indent, parent, {})
  }

  // `&anchor` and `!tag`, in either order, and what follows them.
  properties(text, col, line) {
    let anchor
    let tag
    for (let m = PROPERTY.exec(text); m !== null; m = PROPERTY.exec(text)) {
      if (m[1] === '&') {
        if (anchor !== undefined || m[2] === '') this.fail('an anchor where Psych writes none', line)
        anchor = m[2]
      } else {
        if (tag !== undefined) this.fail('two tags on one node', line)
        tag = m[0].trimEnd()
        if (tag !== '!binary' && !TAGS.has(tag)) this.fail(`the tag ${quote(tag)}, of a class RubyGems does not permit`, line)
      }
      col += m[0].length
      text = text.slice(m[0].length)
    }
    return { anchor, tag, text, col }
  }

  // Nothing after `key:`, `- ` or the properties of a node: the node on the
  // lines after, deeper than `parent`; of a mapping's value, a sequence at
  // the key's own column; or null.
  following(line, parent, value, tag) {
    this.at = this.content(line + 1)
    const next = this.lines[this.at]
    const indent = next === undefined ? -1 : indentOf(next)
    if (indent > parent) return this.block(parent)
    if (value && indent === parent && isEntry(this.structural(this.at))) return this.sequence(indent, this.at, indent)
    if (tag !== undefined) this.fail(`${quote(tag)} on nothing`, line)
    return { kind: 'scalar', type: 'null', value: '' }
  }

  alias(text, props, line) {
    if (props.anchor !== undefined || props.tag !== undefined) this.fail('an alias with an anchor or a tag', line)
    const name = /^\*(\S+)$/u.exec(text)?.[1]
    if (name === undefined || !this.anchors.has(name)) this.fail(`an alias to no anchor before it, ${quote(text)}`, line)
    this.at = line + 1
    return this.anchors.get(name)
  }

  // A node from `col` of `line`, going on over lines deeper than `parent`;
  // of a sequence's `entry`, a mapping or sequence may start on its line.
  inline(line, col, parent, { entry = false, value = false }) {
    this.enter(line)
    const props = this.properties(this.lines[line].slice(col), col, line)
    const { anchor, tag, text } = props
    const bare = entry && anchor === undefined && tag === undefined
    let node
    if (text.startsWith('*')) node = this.alias(text, props, line)
    else if (text === '') node = this.following(line, parent, value, tag)
    else if (text.startsWith('|') || text.startsWith('>')) node = this.blockScalar(line, text, parent)
    else if (text === '[]') node = this.empty({ kind: 'seq', items: [] }, line)
    else if (text === '{}') node = this.empty({ kind: 'map', entries: new Map() }, line)
    else if (bare && isEntry(text)) node = this.sequence(props.col, line, props.col)
    else if (bare && this.key(text, line) !== undefined) node = this.mapping(props.col, line, props.col)
    else node = this.flowScalar(line, props.col, parent)
    if (tag !== undefined) {
      const kind = tag === '!binary' ? 'scalar' : 'map'
      if (node.kind !== kind) this.fail(`${quote(tag)} on a ${{ map: 'mapping', seq: 'sequence', scalar: 'scalar' }[node.kind]}`, line)
      node = { ...node, tag, ...(kind === 'scalar' && { type: 'binary' }) }
    }
    if (anchor !== undefined) {
      if (this.anchors.has(anchor)) this.fail(`the anchor ${quote(anchor)} twice`, line)
      this.anchors.set(anchor, node)
    }
    this.depth--
    return node
  }

  empty(node, line) {
    this.at = line + 1
    return node
  }

  // `key: value` at the start of `text`, as { key, rest }; `? key`, as
  // { complex: true }; undefined where `text` is no mapping entry.
  key(text, line) {
    if (text.startsWith('? ') || text === '?') return { complex: true }
    if (text.startsWith('"') || text.startsWith("'")) {
      const end = closingQuote(text)
      const rest = end === undefined ? '' : text.slice(end)
      if (rest !== ':' && !rest.startsWith(': ')) return undefined
      return { key: scanQuoted([text], (detail) => this.fail(detail, line)).value, rest: rest.slice(1) }
    }
    const colon = /:(?: |$)/u.exec(text)
    if (colon === null || PLAIN_START.test(text)) return undefined
    const key = text.slice(0, colon.index)
    if (key === '' || key.endsWith(' ') || key.includes(' #')) this.fail(`${quote(key)} is no key as Psych writes one`, line)
    if (key === '<<') this.fail('a merge key, which Psych does not write', line)
    if (plainType(key) === 'symbol') this.symbol(key, line)
    return { key, rest: text.slice(colon.index + 1) }
  }

  mapping(indent, line, col) {
    this.enter(line)
    const entries = new Map()
    let at = line
    for (let start = col; ; start = indent) {
      const text = this.lines[at].slice(start)
      const found = this.key(text, at) ?? this.fail(`expected a mapping key, found ${quote(text)}`, at)
      const { key, value } = found.complex ? this.complexEntry(at, start, indent) : { key: found.key, value: this.inline(at, start + text.length - found.rest.length + indentOf(found.rest), indent, { value: true }) }
      if (entries.has(key)) this.fail(`a second ${quote(key)}`, at)
      entries.set(key, value)
      at = this.content(this.at)
      if (at === this.lines.length || indentOf(this.lines[at]) < indent) break
      if (indentOf(this.lines[at]) > indent || isEntry(this.structural(at))) this.fail('bad indentation', at)
    }
    this.at = at
    this.depth--
    return { kind: 'map', entries }
  }

  // `? key` at `col` of `line`, then `: value` at the mapping's column.
  complexEntry(line, col, indent) {
    const text = this.lines[line].slice(col + 1)
    const key = this.inline(line, col + 1 + indentOf(text), indent, {})
    if (key.kind !== 'scalar') this.fail('a key that is no scalar, which RubyGems sets no attribute of', line)
    const at = this.content(this.at)
    const after = at === this.lines.length ? undefined : this.lines[at]
    if (after === undefined || indentOf(after) !== indent || (textOf(after) !== ':' && !textOf(after).startsWith(': '))) this.fail('a `? ` key with no `: ` value after it', line)
    return { key: key.value, value: this.inline(at, indent + 1 + indentOf(textOf(after).slice(1)), indent, { value: true }) }
  }

  sequence(indent, line, col) {
    this.enter(line)
    const items = []
    let at = line
    for (let start = col; ; start = indent) {
      const text = this.lines[at].slice(start)
      if (!isEntry(text)) this.fail(`expected a sequence entry, found ${quote(text)}`, at)
      items.push(this.inline(at, start + 1 + indentOf(text.slice(1)), indent, { entry: true }))
      at = this.content(this.at)
      if (at === this.lines.length || indentOf(this.lines[at]) < indent || (indentOf(this.lines[at]) === indent && !isEntry(this.structural(at)))) break
      if (indentOf(this.lines[at]) > indent) this.fail('bad indentation', at)
    }
    this.at = at
    this.depth--
    return { kind: 'seq', items }
  }

  symbol(text, line) {
    const name = /^:(["'])(.*)\1$/u.exec(text)?.[2] ?? text.slice(1)
    if (!SYMBOLS.has(name)) this.fail(`the symbol ${quote(text)}, which RubyGems does not permit`, line)
  }

  // The lines after `line` a flow scalar goes on over: deeper than
  // `parent`, or blank before one that is.
  continuation(line, parent) {
    const lines = []
    for (let at = line + 1; ;) {
      const next = this.content(at)
      if (next === this.lines.length || indentOf(this.lines[next]) <= parent) return lines
      for (; at < next; at++) lines.push('')
      lines.push(this.lines[next])
      at = next + 1
    }
  }

  flowScalar(line, col, parent) {
    const text = this.lines[line].slice(col)
    const parts = [text, ...this.continuation(line, parent)]
    if (text.startsWith('"') || text.startsWith("'")) {
      const { value, lines, end } = scanQuoted(parts, (detail, n) => this.fail(detail, line + n))
      const after = trimWhite(parts[lines - 1].slice(end))
      if (after !== '') this.fail(`${quote(after)} after a quoted scalar`, line + lines - 1)
      this.at = line + lines
      return { kind: 'scalar', type: 'string', value }
    }
    if (PLAIN_START.test(text)) this.fail(`${quote(text)} is no scalar as Psych writes one`, line)
    for (const [i, part] of parts.entries()) {
      if (part.includes(': ') || part.endsWith(':') || /(?:^|[ \t])#/u.test(trimWhite(part))) this.fail(`${quote(trimWhite(part))} in a plain scalar, which Psych would read otherwise`, line + i)
    }
    this.at = line + parts.length
    const value = fold(parts.map(trimWhite))
    const type = plainType(value)
    if (type === 'symbol') this.symbol(value, line)
    return { kind: 'scalar', type, value }
  }

  blockScalar(line, header, parent) {
    const { value, lines } = blockScalar(this.lines.slice(line + 1), header, parent, (detail, n) => this.fail(detail, line + 1 + n))
    this.at = line + 1 + lines
    return { kind: 'scalar', type: 'string', value }
  }
}

export const parsePsych = (text, where) => new Reader(text, where).document()
