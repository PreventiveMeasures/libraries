import { utf8fromString, utf8toString } from '@exodus/bytes/utf8.js'
import { TarError } from './error.js'

// Escaped, so a name in a message cannot carry a terminal sequence, and cut,
// so a long one cannot flood it.
export const quote = (text) => JSON.stringify(text.length > 200 ? `${text.slice(0, 200)}…` : text)

// A C0, DEL or C1 control, and a backslash if asked.
export function hasUnsafe(text, backslash) {
  for (const char of text) {
    const code = char.codePointAt(0)
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || (backslash && code === 0x5c)) return true
  }
  return false
}

export function utf8Length(text) {
  let length = 0
  for (const char of text) {
    const code = char.codePointAt(0)
    length += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return length
}

export function encodeUtf8(text, what) {
  try {
    return utf8fromString(text)
  } catch {
    throw new TarError(`${what} is not well-formed Unicode`)
  }
}

export function decodeUtf8(raw, what, at) {
  try {
    return utf8toString(raw)
  } catch {
    throw new TarError(`${what} is not valid UTF-8`, at)
  }
}
