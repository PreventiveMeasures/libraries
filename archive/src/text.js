import { utf8fromString, utf8toString } from '@exodus/bytes/utf8.js'
import { ArchiveError } from './error.js'

// Escaped, so a name in a message cannot carry a terminal sequence, and cut
// short of a surrogate pair, so a long one cannot flood it.
export function quote(text) {
  if (text.length <= 200) return JSON.stringify(text)
  return JSON.stringify(`${text.slice(0, text.codePointAt(199) > 0xffff ? 199 : 200)}…`)
}

// A C0, DEL or C1 control; a Unicode line separator or bidirectional
// control, which break or reorder a name as shown; and a backslash if
// asked.
export function hasUnsafe(text, backslash) {
  for (const char of text) {
    const code = char.codePointAt(0)
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || (backslash && code === 0x5c)) return true
    if (code === 0x2028 || code === 0x2029 || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) return true
  }
  return false
}

// Every string taken from a caller goes through here first: a lone
// surrogate has no UTF-8, and so no length or bytes for any later check
// to look at, and JSON.stringify would only hide it.
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

export function encodeUtf8(text, what) {
  try {
    return utf8fromString(text)
  } catch {
    throw new ArchiveError(`${what} is not well-formed Unicode`)
  }
}

export function decodeUtf8(raw, what, at) {
  try {
    return utf8toString(raw)
  } catch {
    throw new ArchiveError(`${what} is not valid UTF-8`, at)
  }
}
