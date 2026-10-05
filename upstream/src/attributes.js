import { Buffer } from 'node:buffer'

import { matches } from './args.js'

// Whether git writes a file out with CRLF where it has LF, from the
// .gitattributes of the tree it is in, as `git archive` and a checkout read
// them from a tree: no info/attributes, no config, so core.eol is LF and
// core.autocrlf unset. Names and patterns are latin1 strings, a char per
// byte, as git matches the bytes. What git versions read apart, or this
// does not read as git does, is no answer: a quoted pattern, a `[:class:]`,
// a UTF-8 BOM, a line of 2048 bytes or a file of 100 MiB, a `builtin_`
// name, or a .gitattributes that is no file. Any of those on the way to a
// path makes its answer false.

const MAX_LINE = 2048
const MAX_FILE = 100 * 1024 * 1024
const isName = matches(/^[\w.][\w.-]*$/u)
// BS, HT, FF and ESC, the controls convert.c counts as printing.
const PRINTING = new Set([0x08, 0x09, 0x0c, 0x1b])

// wildmatch.c's results; any but MATCH is no match.
const MATCH = 0
const NOMATCH = 1
const ABORT_ALL = -1
const ABORT_TO_STARSTAR = -2

// The `[...]` class at p[pi], against `ch`: where its `]` is, and whether
// it matches, as `/` never does; null where it does not close.
function matchClass(p, pi, ch) {
  let c = p[++pi]
  const negated = c === '!' || c === '^'
  if (negated) c = p[++pi]
  let prev = ''
  let matched = false
  do {
    if (c === '-' && prev && p[pi + 1] !== undefined && p[pi + 1] !== ']') {
      c = p[++pi] === '\\' ? p[++pi] : p[pi]
      if (c === undefined) return null
      matched ||= ch <= c && ch >= prev
      c = ''
    } else {
      if (c === '\\') c = p[++pi]
      if (c === undefined) return null
      matched ||= ch === c
    }
    prev = c
    c = p[++pi]
  } while (c !== ']')
  return { end: pi, matched: matched !== negated && ch !== '/' }
}

// The rest of the pattern from p[pi], after a `*`, tried from each place
// in `text` from ti on, past a `/` only where `crosses`; a literal next is
// looked for first. Not found, a `*` that crosses gives up altogether, and
// one that does not leaves a `**` around it to try further on.
function afterStar(p, text, pi, ti, crosses, memo) {
  const literal = '*?[\\'.includes(p[pi]) ? '' : p[pi]
  for (let t = ti; t < text.length; t++) {
    if (literal) {
      const found = text.indexOf(literal, t)
      const slash = crosses ? -1 : text.indexOf('/', t)
      if (found === -1 || (slash !== -1 && slash < found)) return crosses ? ABORT_ALL : NOMATCH
      t = found
    }
    const matched = dowild(p, text, pi, t, memo)
    if (matched === NOMATCH) {
      if (!crosses && text[t] === '/') return ABORT_TO_STARSTAR
    } else if (!crosses || matched !== ABORT_TO_STARSTAR) return matched
  }
  return ABORT_ALL
}

// A `*` at p[pi], or a run of them: `**` between slashes, or at an end,
// crosses them, and `**/` may match no directory at all.
function star(p, text, pi, ti, memo) {
  let at = pi + 1
  while (p[at] === '*') at++
  const crosses = at > pi + 1 && (pi === 0 || p[pi - 1] === '/') && (at === p.length || p[at] === '/' || (p[at] === '\\' && p[at + 1] === '/'))
  if (crosses) memo ??= new Map()
  if (crosses && p[at] === '/' && dowild(p, text, at + 1, ti, memo) === MATCH) return MATCH
  if (at === p.length) return !crosses && text.includes('/', ti) ? NOMATCH : MATCH
  if (!crosses && p[at] === '/') {
    const slash = text.indexOf('/', ti)
    return slash === -1 ? NOMATCH : dowild(p, text, at + 1, slash + 1, memo)
  }
  return afterStar(p, text, at, ti, crosses, memo)
}

// A port of git's wildmatch with WM_PATHNAME, as a .gitattributes pattern
// is matched: `*`, `?` and a class never match `/`. Under a `**` each pair
// of places is tried once, as a run of `**/` would try the same ones over
// and over.
function dowild(p, text, pi, ti, memo) {
  if (!memo) return walk(p, text, pi, ti)
  const key = pi * (text.length + 1) + ti
  if (!memo.has(key)) memo.set(key, walk(p, text, pi, ti, memo))
  return memo.get(key)
}

function walk(p, text, pi, ti, memo) {
  for (; pi < p.length; pi++, ti++) {
    const tc = text[ti]
    if (p[pi] === '*') return star(p, text, pi, ti, memo)
    if (tc === undefined) return ABORT_ALL
    if (p[pi] === '[') {
      const found = matchClass(p, pi, tc)
      if (!found) return ABORT_ALL
      if (!found.matched) return NOMATCH
      pi = found.end
    } else if (p[pi] === '?') {
      if (tc === '/') return NOMATCH
    } else {
      if (p[pi] === '\\') pi++
      if (tc !== p[pi]) return NOMATCH
    }
  }
  return ti < text.length ? NOMATCH : MATCH
}

const wildmatch = (pattern, text) => walk(pattern, text, 0, 0) === MATCH

// A token's attribute: `name` set, `-name` unset, `!name` unspecified,
// `name=value`; undefined for a name git takes for none, null for one only
// some versions take.
function parseState(token) {
  const [, sign, name, value = true] = /^([-!]?)([^=]*)(?:=(.*))?$/u.exec(token)
  if (!isName(name)) return undefined
  if (name.startsWith('builtin_')) return null
  if (sign) return [name, sign === '-' ? false : null]
  return [name, value]
}

// A .gitattributes as attr.c reads one from a tree, to the first NUL: its
// rules, each { pattern, states }, and, at the root alone, its macros by
// name. A line git leaves out is left out; null for any this cannot read.
function parseAttributes(bytes, root) {
  if (bytes.length >= MAX_FILE) return null
  const nul = bytes.indexOf(0)
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, nul === -1 ? bytes.length : nul).toString('latin1')
  if (text.startsWith('\u00EF\u00BB\u00BF')) return null
  const rules = []
  const macros = new Map()
  for (const line of text.split('\n')) {
    const tokens = line.split(/[ \t\r\n]+/u).filter(Boolean)
    if (tokens.length === 0 || tokens[0].startsWith('#')) continue
    if (line.length >= MAX_LINE || tokens[0].startsWith('"')) return null
    const [name, ...rest] = tokens
    const states = rest.map(parseState)
    if (states.includes(null)) return null
    if (states.includes(undefined)) continue
    if (name.startsWith('[attr]') && name.length > '[attr]'.length) {
      const macro = name.slice('[attr]'.length)
      if (root && macro.startsWith('builtin_')) return null
      if (root && isName(macro)) macros.set(macro, states)
      continue
    }
    if (name.startsWith('!')) continue
    if (name.includes('[:')) return null
    rules.push({ pattern: name, states })
  }
  return { rules, macros }
}

// dir.c's path_matches for a file, at `path` from the .gitattributes: a
// pattern with no `/` matches its name, one with a `/` its path, less a
// leading `/`, and one ending in `/` only a directory. As match_pathname
// does, the pattern's literal start is matched first and taken off both,
// so a `**` just after it starts what is left, and crosses a `/`.
function matchesFile(pattern, path) {
  if (pattern.endsWith('/')) return false
  if (!pattern.includes('/')) return wildmatch(pattern, path.slice(path.lastIndexOf('/') + 1))
  const glob = pattern.startsWith('/') ? pattern.slice(1) : pattern
  const literal = glob.search(/[*?[\\]/u)
  if (literal === -1) return path === glob
  return path.startsWith(glob.slice(0, literal)) && wildmatch(glob.slice(literal), path.slice(literal))
}

// The .gitattributes from the root down to the directory at `base`, its
// path and a `/`, or '' at the root: those `above` it, each { base,
// rules, macros }, and its own, from `bytes`, undefined where it has none.
// Null from where one cannot be read, or is no file (`bytes` null) on.
export function withAttributes(above, base, bytes) {
  if (above === null || bytes === null) return null
  const own = bytes === undefined ? { rules: [], macros: new Map() } : parseAttributes(bytes, base === '')
  return own && [...above, { base, ...own }]
}

// Each attribute's state at `path`, from `files`, as withAttributes lists
// them down to its directory: as attr.c fills them, the deepest file and
// its last line first, a state taken once, a macro set to true expanded
// where it is set.
export function attributesOf(files, path) {
  const macros = new Map([['binary', [['diff', false], ['merge', false], ['text', false]]], ...files[0].macros])
  const states = new Map()
  const fill = (list) => {
    for (const [name, value] of list.toReversed()) {
      if (states.has(name)) continue
      states.set(name, value)
      if (value === true && macros.has(name)) fill(macros.get(name))
    }
  }
  for (const { base, rules } of files.toReversed()) {
    for (const { pattern, states: list } of rules.toReversed()) if (matchesFile(pattern, path.slice(base.length))) fill(list)
  }
  return states
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
// each LF of the blob: `eol=crlf` where `text`, or else `crlf`, is not
// unset, and is `auto` only where the blob is text; and nothing rewrites
// it otherwise, an `ident`, a `filter` or a `working-tree-encoding`.
export function writtenWithCrlf(files, path, written) {
  if (files === null) return false
  const states = attributesOf(files, path)
  if (states.get('ident') === true || typeof states.get('filter') === 'string' || states.get('working-tree-encoding')) return false
  // convert.c's crlf_action: `text`, or else `crlf`, where set, unset, `input` or `auto`.
  const action = [states.get('text'), states.get('crlf')].find((value) => typeof value === 'boolean' || value === 'input' || value === 'auto')
  if (action === false || states.get('eol') !== 'crlf') return false
  return action !== 'auto' || isAutoText(written)
}
