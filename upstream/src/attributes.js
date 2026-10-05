import { Buffer } from 'node:buffer'

// Whether git writes a file out with CRLF, from the .gitattributes in its
// tree alone, as `git archive` and a checkout with no config read them. Only
// `*`, `*.ext`, name and path rules are read: any other rule that sets an
// attribute line endings depend on refuses its file, and all below it.

const RELEVANT = new Set(['text', 'crlf', 'eol', 'binary', 'ident', 'filter', 'working-tree-encoding'])
const BINARY = [['diff', false], ['merge', false], ['text', false]]
const GLOB = /[*?[\\]/u
const PRINTING = new Set([0x08, 0x09, 0x0c, 0x1b]) // BS, HT, FF, ESC

function matcher(pattern) {
  const name = (path) => path.slice(path.lastIndexOf('/') + 1)
  if (pattern.endsWith('/')) return () => false // a directory
  if (!GLOB.test(pattern)) return pattern.includes('/') ? (path) => path === pattern.replace(/^\//u, '') : (path) => name(path) === pattern
  const end = pattern.slice(1)
  return pattern[0] === '*' && !GLOB.test(end) && !end.includes('/') ? (path) => name(path).endsWith(end) : null
}

// Read to the first NUL, as git reads one from a tree. A line with a name
// git takes for none, or a negative pattern, git leaves out.
function parseAttributes(bytes) {
  const nul = bytes.indexOf(0)
  const rules = []
  for (const line of Buffer.from(bytes.buffer, bytes.byteOffset, nul === -1 ? bytes.length : nul).toString('latin1').split('\n')) {
    const [pattern, ...tokens] = line.split(/[ \t\r]+/u).filter(Boolean)
    if (pattern?.startsWith('"')) return null
    if (pattern === undefined || pattern.startsWith('#') || pattern.startsWith('!')) continue
    const states = tokens.map((token) => /^([-!]?)([\w.][\w.-]*)(?:=(.*))?$/u.exec(token))
    if (states.includes(null) || !states.some(([, , name]) => RELEVANT.has(name))) continue
    const match = matcher(pattern)
    if (!match) return null
    rules.push({ match, states: states.map(([, sign, name, value = true]) => [name, sign === '-' ? false : sign === '!' ? null : value]) })
  }
  return rules
}

// `base` is the directory's path and a `/`; `bytes` is undefined where it
// has no .gitattributes, null where that is no file.
export function withAttributes(above, base, bytes) {
  if (above === null || bytes === null) return null
  const rules = bytes === undefined ? [] : parseAttributes(bytes)
  return rules && [...above, { base, rules }]
}

// convert.c's text test for `text=auto`, on the blob these bytes are written from.
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

// attr.c's order: the deepest file and its last line first. Anything else
// rewriting the file (ident, filter, working-tree-encoding) refuses it.
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
