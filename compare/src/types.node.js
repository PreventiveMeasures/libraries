// Whether a text holds types alone, proven on Node: Node runs a `.d.ts` it imports as the `.ts` it is
// named, what its type stripping leaves of it, so oxc's syntax tree and that stripping itself must each
// find nothing but types in it, the same to the character; what stripping leaves is read again apart from
// either, and so is what its transform mode (--experimental-transform-types) leaves. The portable twin,
// types.js, proves nothing and loads nothing. oxc-parser, an optional peer, is loaded on first use, and
// without it nothing is proven: compareTrees, which stamps declaration files, needs no peer.

import * as nodeModule from 'node:module'
import { getParser } from '#oxc'
import { CODE, ERASED, bindingless, leftover, strippedAs } from './erasure.js'

// Each a fresh result, never a shared object a caller could mutate into another's.
const unsupported = () => ({ proven: false, reason: 'unsupported', at: null })
const refused = (reason, at) => ({ proven: false, reason, at })

// What stripping writes in place of what it erases is a blank of as many UTF-8 bytes (a space, a no-break
// space, an en space; a space and a byte order mark for four), unit for unit; line breaks and other blanks
// it keeps. Any blank but a line break is taken for one.
const WRITTEN = /[^\S\n\r\u2028\u2029]/u
const LINE_BREAK = /[\n\r\u2028\u2029]/u
const NOT_LINE_BREAK = /[^\n\r\u2028\u2029]/gu
const BLANK = /\s/u

// Comments a tool reads as more than prose, which stripping keeps verbatim: a triple-slash directive, which
// pulls other declarations into the file's types, and a source map or source URL pragma, which names where
// a tool looks (its legacy forms, `//@` and a `/*# */` block, among it). They join the runtime, so a change
// to one shows there rather than passing as types only. A directive is one of TypeScript's named tags
// (`reference`, `amd-module`, `amd-dependency`) carrying an attribute, so whitespace follows the name; a
// `/// <summary>`, a bare `/// <reference>` or `/// <reference/>` without one, or any other triple-slash
// comment is prose. A pragma likewise needs its grammar: the engine reads `//# sourceMappingURL=` only with
// whitespace after the `#` or `@` and a non-empty value, so `//#sourceURL=x` or an empty `//# sourceURL=`
// is prose. Erring wide is safe here (a prose change merely withholds a stamp), but matching every real
// directive or pragma is not optional: missing one would stamp its change, so each is kept as broad as its
// effective grammar allows, no stricter. A directive steers only where it leads the file,
// `prologue` true: TypeScript honours it before the first statement and reads it as prose below one, so
// moving it out of the prologue drops it, as removing it does.
const DIRECTIVE = /^\/\/\/\s*<(?:reference|amd-module|amd-dependency)\s/u
const PRAGMA = /^\/[/*][#@]\s+source(?:Mapping)?URL=\S/u
const steers = (text, prologue) => (DIRECTIVE.test(text) && prologue) || PRAGMA.test(text)

// Node's stripping is one instance for the process, its loader of `.ts` files' too, and one stopped partway
// (a stack overflowed, execution terminated) is not trusted again: one that threw here anything but its
// refusal of a text, or that does not strip the canary as it should, as one stopped elsewhere may not.
const untrusted = new WeakSet()
const REFUSALS = new Set(['ERR_INVALID_TYPESCRIPT_SYNTAX', 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX'])
const CANARY = ['let a: "\u00E9\u4E00\u{1F600}" = 1 // c\n', 'let a   \u00A0\u2002 \uFEFF  = 1 // c\n']

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
    if (error?.code === 'ERR_NO_TYPESCRIPT') return null
    if (!REFUSALS.has(error?.code)) untrusted.add(stripTypeScriptTypes)
    return { error }
  }
}

function trusted(stripTypeScriptTypes) {
  if (!untrusted.has(stripTypeScriptTypes) && strip(stripTypeScriptTypes, CANARY[0], 'strip')?.code === CANARY[1]) return true
  untrusted.add(stripTypeScriptTypes)
  return false
}

// oxc's tree, or null where oxc throws rather than tells an error.
function parsed(parseSync, text) {
  try {
    return parseSync('file.ts', text, { lang: 'ts', sourceType: 'module' })
  } catch {
    return null
  }
}

// Where stripping and oxc's tree do not agree, or -1: stripping blanks what it erases and keeps line
// breaks, and what it keeps that is no blank lies in a comment, the hashbang, or a statement it leaves to
// run -- a module load or `export {}` -- not in one oxc finds erased. A comment within an erased statement
// (strip blanks it) goes with it. A type-only specifier within a kept import blanks, and the else branch
// below allows it.
function disagreement(text, code, { comments, program }, erased, runtime) {
  const kept = new Uint8Array(text.length)
  for (const { start, end } of [...comments, ...runtime, ...(program.hashbang ? [program.hashbang] : [])]) kept.fill(1, start, end)
  for (const { start, end } of erased) kept.fill(0, start, end)
  // A character stripping changed must become a blank, not a line break written over one; one it kept
  // must be a blank, or lie in a span.
  for (let i = 0; i < text.length; i++) {
    if (code[i] === text[i] ? !kept[i] && !BLANK.test(code[i]) : !WRITTEN.test(code[i]) || LINE_BREAK.test(text[i])) return i
  }
  return -1
}

// `code` with each span blanked to spaces, its line breaks kept, so what is left of the stripped text
// once the statements it leaves to run are set aside can be read for anything else.
function blankedOutside(code, spans) {
  let out = code
  for (const { start, end } of spans) out = out.slice(0, start) + out.slice(start, end).replace(NOT_LINE_BREAK, ' ') + out.slice(end)
  return out
}

// proveTypeOnly with the stripping given: exported for tests alone, not by the package.
export function proveWith(text, stripTypeScriptTypes) {
  if (typeof text !== 'string') throw new TypeError(`a text must be a string, not ${typeof text}`)
  if (!text.isWellFormed()) throw new TypeError('a text must be a well-formed string')
  const parseSync = parser()
  if (typeof stripTypeScriptTypes !== 'function' || parseSync === null || !trusted(stripTypeScriptTypes)) return unsupported()
  // Stripping drops a byte order mark the text starts with.
  const shift = text.startsWith('\uFEFF') ? 1 : 0
  const body = text.slice(shift)
  // Stripping goes first: oxc's parser, native, overflows its stack on nesting deep enough and ends the
  // process, where stripping throws first, at less than half the depth on an 8 MB stack. oxc reads only
  // what stripping read whole: it either strips it, or refuses what it does not erase once it has read it all.
  const stripped = strip(stripTypeScriptTypes, body, 'strip')
  if (stripped === null) return unsupported()
  if ('error' in stripped && stripped.error?.code !== 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX') return refused('unparsed', null)
  const tree = parsed(parseSync, body)
  if (tree === null) return refused('unparsed', null)
  if (tree.errors.length > 0) return refused('unparsed', shift + (tree.errors[0].labels?.[0]?.start ?? 0))
  // `erased` statements strip to blanks; `runtime` ones stripping leaves to run -- a module load or
  // `export {}`. Anything else is code, which no declaration file of types alone holds.
  const erased = [], runtime = []
  for (const statement of tree.program.body) {
    const kind = strippedAs(statement)
    if (kind === CODE) return refused('code', shift + statement.start)
    ;(kind === ERASED ? erased : runtime).push(statement)
  }
  if ('error' in stripped || stripped.code.length !== body.length) return refused('disagree', null)
  const at = disagreement(body, stripped.code, tree, erased, runtime)
  if (at !== -1) return refused('disagree', shift + at)
  // Set the run statements aside; the rest of the stripped text must be blanks, comments and a hashbang.
  const left = leftover(blankedOutside(stripped.code, runtime))
  if (left !== -1) return refused('disagree', shift + left)
  // Transform mode (--experimental-transform-types) reveals a construct strip under-erases as code: its
  // output, read again, must hold nothing but run statements and what erased to nothing. A bindingless load
  // is not under-erasure here: transform emits one where it elides an inline-type import or re-export (an
  // `import { type A }` becomes a bare side-effect `import`), so it is allowed though its source form is code.
  const transformed = strip(stripTypeScriptTypes, body, 'transform')
  if (transformed === null) return unsupported()
  if ('error' in transformed) return refused('disagree', null)
  const after = parsed(parseSync, transformed.code)
  if (after === null || after.errors.length > 0 || after.program.body.some((statement) => strippedAs(statement) === CODE && !bindingless(statement))) return refused('disagree', null)
  // The runtime a change must leave untouched to be types only: the hashbang, the module loads and
  // `export {}` stripping leaves, and the directive and pragma comments it keeps -- each as stripping
  // leaves it, in source order. Empty where the file erases whole and carries none. A triple-slash
  // directive counts only in the prologue, before the first statement, where TypeScript honours it; a
  // comment blanked within an erased statement reads as blanks here, so only a kept one steers. `loads` is
  // whether any run statement is a module load or `export {}`, the runtime that runs differently per module
  // format -- a hashbang, directive or pragma does not.
  const prologue = tree.program.body.length > 0 ? tree.program.body[0].start : stripped.code.length
  const hashbang = tree.program.hashbang ? [tree.program.hashbang] : []
  const steering = tree.comments.filter(({ start, end }) => steers(stripped.code.slice(start, end), start < prologue))
  const kept = [...hashbang, ...runtime, ...steering].sort((a, b) => a.start - b.start)
  const signature = kept.map(({ start, end }) => stripped.code.slice(start, end)).join('\n')
  return { proven: true, runtime: signature, loads: runtime.length > 0 }
}

export const proveTypeOnly = (text) => proveWith(text, nodeModule.stripTypeScriptTypes)
