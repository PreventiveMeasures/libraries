// A lockfile read a line at a time, as yarn.lock and foundry.lock are, and
// the strings in a line that JSON writes.

import { LockfileError, quote } from './error.js'
import { hex } from './excerpt.js'

export const fail = (detail, number) => new LockfileError(`${detail} at line ${Math.max(number, 0) + 1}`)

// npm and yarn read a file with all three of these anywhere in it, in a
// string too, as a merge conflict, and merge its sides into one.
const CONFLICT = ['<<<<<<<', '=======', '>>>>>>>']

export function checkConflict(text, tool) {
  if (CONFLICT.every((marker) => text.includes(marker))) {
    throw new LockfileError(`${tool} reads a file with ${CONFLICT.map((marker) => quote(marker)).join(', ')} in it as a merge conflict`)
  }
}

// A sticky `re` read at `src.pos`, which it moves past the match.
export function take(src, re) {
  re.lastIndex = src.pos
  const m = re.exec(src.text)
  if (m !== null) src.pos = re.lastIndex
  return m
}

// What follows `pos`, for a message.
export const rest = (line, pos) => (pos < line.length ? quote(line.slice(pos)) : 'the end of the line')

// `forbidden` is what no line may have, refused by its code point.
export const lines = (text, forbidden) => ({ text, forbidden, pos: 0, number: -1, line: undefined, crlf: undefined })

// The next line into `src.line`, undefined past the last. Every line ends
// alike: a tool keeps the line ends of the file it rewrites, and git may
// check one out with CRLF throughout.
export function advance(src) {
  const { text, pos } = src
  src.line = undefined
  if (pos >= text.length) return
  let end = text.indexOf('\n', pos)
  if (end === -1) end = text.length
  src.pos = end + 1
  src.number++
  const crlf = end < text.length && text[end - 1] === '\r'
  const line = text.slice(pos, crlf ? end - 1 : end)
  const char = src.forbidden.exec(line)?.[0]
  if (char !== undefined) throw fail(`${hex(char)} is not allowed`, src.number)
  if (end < text.length && crlf !== (src.crlf ??= crlf)) throw fail(`a ${crlf ? 'CRLF' : 'LF'} line end, after ${src.crlf ? 'CRLF' : 'LF'} ones`, src.number)
  src.line = line
}

// The string opening at `pos`, as JSON.stringify writes it and no other
// way, and the position past its closing quote; a backslash escapes the
// character after it. Without one, the text is the value, as a line's
// controls and lone surrogates are refused before.
export function readJsonString(line, pos, number) {
  let end = pos + 1
  while (end < line.length && line[end] !== '"') end += line[end] === '\\' ? 2 : 1
  if (end >= line.length) throw fail('a string with no closing quote', number)
  const raw = line.slice(pos, ++end)
  if (!raw.includes('\\')) return [raw.slice(1, -1), end]
  let value
  try {
    value = JSON.parse(raw)
  } catch {
    throw fail(`${quote(raw)} is not a string as JSON writes it`, number)
  }
  if (JSON.stringify(value) !== raw) throw fail(`${quote(raw)} is not written as JSON writes ${quote(value)}`, number)
  return [value, end]
}
