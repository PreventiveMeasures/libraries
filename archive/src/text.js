import { utf8toString } from '@exodus/bytes/utf8.js'
import { ArchiveError } from './error.js'

// Escaped, so a name in a message cannot carry a terminal sequence, and cut
// short, not inside a surrogate pair, so a long one cannot flood it
export function quote(text) {
  if (text.length <= 200) return JSON.stringify(text)
  return JSON.stringify(`${text.slice(0, text.codePointAt(199) > 0xffff ? 199 : 200)}\u2026`)
}

// Controls, line and paragraph separators, and bidi controls: each breaks or reorders a name as shown
const UNSAFE = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/u
const UNSAFE_OR_BACKSLASH = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}\\]/u

export const hasUnsafe = (text, backslash) => (backslash ? UNSAFE_OR_BACKSLASH : UNSAFE).test(text)

// Every string from a caller passes here first: a lone surrogate has no UTF-8 to measure or write
export function checkString(value, what) {
  if (typeof value !== 'string') throw new ArchiveError(`${what} is not a string`)
  if (!value.isWellFormed()) throw new ArchiveError(`${what} is not well-formed Unicode`)
}

export function utf8Length(text) {
  let length = 0
  for (const char of text) {
    const code = char.codePointAt(0)
    length += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return length
}

// A code unit is 1 to 3 bytes of UTF-8, so only text of max/3 to max units is counted
export const tooLong = (text, max) => text.length > max || (text.length * 3 > max && utf8Length(text) > max)

export function decodeUtf8(raw, what, at) {
  try {
    return utf8toString(raw)
  } catch {
    throw new ArchiveError(`${what} is not valid UTF-8`, at)
  }
}
