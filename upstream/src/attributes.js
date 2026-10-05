import { Buffer } from 'node:buffer'

// Whether git writes a file out with CRLF where it has LF, from the
// .gitattributes of the tree it is in, as `git archive` and a checkout read
// them from a tree: no info/attributes, no config, so core.eol is LF and
// core.autocrlf unset. Only rules for `*`, `*.ext`, a name or a path are
// read; a .gitattributes with any other rule that sets an attribute line
// endings depend on, or with what git versions read apart, is refused,
// and with it every answer below it.

const MAX_LINE = 2048
const MAX_FILE = 100 * 1024 * 1024
const RELEVANT = new Set(['text', 'crlf', 'eol', 'binary', 'ident', 'filter', 'working-tree-encoding'])
const BINARY = [['diff', false], ['merge', false], ['text', false]]
const GLOB = /[*?[\\]/u
// BS, HT, FF and ESC, the controls convert.c counts as printing.
const PRINTING = new Set([0x08, 0x09, 0x0c, 0x1b])

// What a pattern matches of a path from its .gitattributes: a name with no
// `/` that name anywhere below, one with a `/` that path, one ending in `/`
// only a directory, and `*` or `*.ext` a name ending so; null for others.
function matcher(pattern) {
  const name = (path) => path.slice(path.lastIndexOf('/') + 1)
  if (pattern.endsWith('/')) return () => false
  if (!GLOB.test(pattern)) return pattern.includes('/') ? (path) => path === pattern.replace(/^\//u, '') : (path) => name(path) === pattern
  const end = pattern.slice(1)
  return pattern[0] === '*' && !GLOB.test(end) && !end.includes('/') ? (path) => name(path).endsWith(end) : null
}

// A token's attribute: `name` set, `-name` unset, `!name` unspecified, or
// `name=value`.
function state([, sign, name, value = true]) {
  if (sign === '-') return [name, false]
  return [name, sign === '!' ? null : value]
}

// A .gitattributes to its first NUL, as attr.c reads one from a tree: the
// rules that set a RELEVANT attribute, each { match, states }, where a line
// with a name git takes for none, or a negative pattern, is left out as git
// leaves it; null where one is a rule this does not read.
function parseAttributes(bytes) {
  if (bytes.length >= MAX_FILE) return null
  const nul = bytes.indexOf(0)
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, nul === -1 ? bytes.length : nul).toString('latin1')
  if (text.startsWith('ï»¿')) return null
  const rules = []
  for (const line of text.split('\n')) {
    const [pattern, ...tokens] = line.split(/[ \t\r]+/u).filter(Boolean)
    if (pattern?.startsWith('"')) return null
    if (pattern === undefined || pattern.startsWith('#') || pattern.startsWith('!')) continue
    const tokenized = tokens.map((token) => /^([-!]?)([\w.][\w.-]*)(?:=(.*))?$/u.exec(token))
    if (tokenized.includes(null) || !tokenized.some(([, , name]) => RELEVANT.has(name))) continue
    const match = matcher(pattern)
    if (!match || line.length >= MAX_LINE || tokenized.some(([, , name]) => name.startsWith('builtin_'))) return null
    rules.push({ match, states: tokenized.map(state) })
  }
  return rules
}

// The .gitattributes from the root down to the directory at `base`, its
// path and a `/`, or '' at the root: those `above` it, each { base, rules },
// and its own, from `bytes`, undefined where it has none. Null from where
// one is refused, or is no file (`bytes` null), on.
export function withAttributes(above, base, bytes) {
  if (above === null || bytes === null) return null
  const rules = bytes === undefined ? [] : parseAttributes(bytes)
  return rules && [...above, { base, rules }]
}

// convert.c's convert_is_binary, and no CR, on the blob these bytes are
// written from with each LF's CR taken out, as `text=auto` writes only text.
function isAutoText(written) {
  let printable = 0
  let other = written.at(-1) === 0x1a ? -1 : 0
  for (let i = 0; i < written.length; i++) {
    const c = written[i]
    if (c === 0x0d && written[i + 1] !== 0x0a) return false
    if (c === 0x0d || c === 0x0a) continue
    if (c === 0) return false
    if (c >= 0x20 ? c !== 0x7f : PRINTING.has(c)) printable++
    else other++
  }
  return printable >> 7 >= other
}

// Whether git writes the file at `path`, these bytes, out with a CR before
// each LF: as attr.c fills its attributes, the deepest file and its last
// line first, a state taken once, `binary` expanded where it is set; then
// `eol=crlf` where `text`, or else `crlf`, is not unset, and is `auto` only
// where the blob is text, and nothing else rewrites it, an `ident`, a
// `filter` or a `working-tree-encoding`.
export function writtenWithCrlf(files, path, written) {
  if (files === null) return false
  const states = new Map()
  const fill = (list) => {
    for (const [name, value] of list.toReversed()) {
      if (states.has(name)) continue
      states.set(name, value)
      if (name === 'binary' && value === true) fill(BINARY)
    }
  }
  for (const { base, rules } of files.toReversed()) {
    for (const { match, states: list } of rules.toReversed()) if (match(path.slice(base.length))) fill(list)
  }
  if (states.get('ident') === true || typeof states.get('filter') === 'string' || states.get('working-tree-encoding')) return false
  const action = [states.get('text'), states.get('crlf')].find((value) => typeof value === 'boolean' || value === 'input' || value === 'auto')
  if (action === false || states.get('eol') !== 'crlf') return false
  return action !== 'auto' || isAutoText(written)
}
