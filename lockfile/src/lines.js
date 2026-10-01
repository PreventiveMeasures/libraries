// A lockfile read a line at a time, as yarn.lock and foundry.lock are, and
// the strings in a line that JSON writes.

import { LockfileError, quote } from './error.js'

export const fail = (detail, number) => new LockfileError(`${detail} at line ${Math.max(number, 0) + 1}`)

export const hex = (char) => `U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`

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

// Past the quote that closes the string opening at `pos`; a backslash
// escapes the character after it.
export function closeQuote(line, pos, number) {
  let end = pos + 1
  while (end < line.length && line[end] !== '"') end += line[end] === '\\' ? 2 : 1
  if (end >= line.length) throw fail('a string with no closing quote', number)
  return end + 1
}

// A quoted string with escapes, as JSON.stringify writes it and no other way.
export function readJsonString(raw, number) {
  let value
  try {
    value = JSON.parse(raw)
  } catch {
    throw fail(`${quote(raw)} is not a string as JSON writes it`, number)
  }
  if (JSON.stringify(value) !== raw) throw fail(`${quote(raw)} is not written as JSON writes ${quote(value)}`, number)
  return value
}
