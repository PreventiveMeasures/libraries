// Whether a text holds types alone, proven on Node: Node runs a `.d.ts` it imports as the `.ts` it is
// named, what its type stripping leaves of it, so oxc's syntax tree and that stripping itself must each
// find nothing but types in it, the same to the character; what stripping leaves is read again apart from
// either, and so is what its transform mode (--experimental-transform-types) leaves. The portable twin,
// types.js, proves nothing and loads nothing. oxc-parser, an optional peer, is loaded on first use, and
// without it nothing is proven: compareTrees, which stamps declaration files, needs no peer.

import * as nodeModule from 'node:module'
import { getParser } from '#oxc'
import { CODE, ERASED, IMPORT, INERT, leftover, strippedAs } from './erasure.js'

const UNSUPPORTED = { proven: false, reason: 'unsupported', at: null }
const refused = (reason, at) => ({ proven: false, reason, at })

// What stripping writes in place of what it erases, unit for unit: a space, or a no-break space or a
// byte order mark for a character of more UTF-8 bytes. Line breaks it keeps.
const BLANKS = new Set([' ', '\u00A0', '\uFEFF'])
const LINE_BREAK = /[\n\r\u2028\u2029]/u
const BLANK = /\s/u

function parser() {
  try {
    return getParser()
  } catch {
    return null
  }
}

// Node's stripping in either mode: null where this Node has none, built without it.
function strip(stripTypeScriptTypes, text, mode) {
  try {
    return { code: stripTypeScriptTypes(text, { mode }) }
  } catch (error) {
    return error?.code === 'ERR_NO_TYPESCRIPT' ? null : { error }
  }
}

// Where stripping and oxc's tree do not agree, or -1: stripping blanks what it erases and keeps line
// breaks, and what it keeps that is no blank lies in a comment or the hashbang outside the statements
// oxc finds erased, or in an inert one. A comment within an erased statement goes with it.
function disagreement(text, code, { comments, program }, { erased, inert }) {
  const kept = new Uint8Array(text.length)
  for (const { start, end } of [...comments, ...inert, ...(program.hashbang ? [program.hashbang] : [])]) kept.fill(1, start, end)
  for (const { start, end } of erased) kept.fill(0, start, end)
  for (let i = 0; i < text.length; i++) {
    if (code[i] === text[i] ? !kept[i] && !BLANK.test(code[i]) : !BLANKS.has(code[i]) || LINE_BREAK.test(text[i])) return i
  }
  return -1
}

// proveTypeOnly with the stripping given: exported for tests alone, not by the package.
export function proveWith(text, stripTypeScriptTypes) {
  if (typeof text !== 'string') throw new TypeError(`a text must be a string, not ${typeof text}`)
  const parseSync = parser()
  if (typeof stripTypeScriptTypes !== 'function' || parseSync === null) return UNSUPPORTED
  // Stripping drops a byte order mark the text starts with.
  const shift = text.startsWith('\uFEFF') ? 1 : 0
  const body = text.slice(shift)
  if (!body.isWellFormed()) return refused('unparsed', shift + body.search(/\p{Cs}/u))
  // Stripping goes first: oxc's parser, native, overflows its stack on nesting deep enough and ends the
  // process, where stripping throws first, at less than half the depth on an 8 MB stack. oxc reads only
  // what stripping read whole: it either strips it, or refuses what it does not erase once it has read it all.
  const stripped = strip(stripTypeScriptTypes, body, 'strip')
  if (stripped === null) return UNSUPPORTED
  if ('error' in stripped && stripped.error?.code !== 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX') return refused('unparsed', null)
  const tree = parseSync('file.ts', body, { lang: 'ts', sourceType: 'module' })
  if (tree.errors.length > 0) return refused('unparsed', shift + (tree.errors[0].labels?.[0]?.start ?? 0))
  const spans = { [ERASED]: [], [INERT]: [] }
  for (const statement of tree.program.body) {
    const kind = strippedAs(statement)
    if (kind === IMPORT || kind === CODE) return refused(kind, shift + statement.start)
    spans[kind].push(statement)
  }
  if ('error' in stripped || stripped.code.length !== body.length) return refused('disagree', null)
  const at = disagreement(body, stripped.code, tree, spans)
  const left = at === -1 ? leftover(stripped.code) : at
  if (left !== -1) return refused('disagree', shift + left)
  const transformed = strip(stripTypeScriptTypes, body, 'transform')
  if (transformed === null) return UNSUPPORTED
  return 'code' in transformed && leftover(transformed.code) === -1 ? { proven: true } : refused('disagree', null)
}

export const proveTypeOnly = (text) => proveWith(text, nodeModule.stripTypeScriptTypes)
