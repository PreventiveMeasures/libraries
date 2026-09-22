// The records of a pax extended header, as GNU tar writes them and as this
// package reads them. Each is one line: the length of the whole line in
// decimal, a space, the keyword, `=`, the value, a newline — the length
// counting its own digits, so it is settled by trying a width and seeing
// whether the total still has that many digits, which is tar's own loop.
//
// Reading is stricter than GNU's: the length has to be exactly the record,
// the line has to end where it says, and a keyword may appear once. A
// value can hold anything UTF-8 holds, newlines included, because the
// length says where it ends.

import { utf8fromString, utf8toString } from '@exodus/bytes/utf8.js'
import { TarError } from './error.js'
import { concat } from './header.js'
import { hasUnsafe } from './names.js'

const DIGIT_0 = 0x30
const DIGIT_9 = 0x39
const SPACE = 0x20
const EQUALS = 0x3d
const NEWLINE = 0x0a

function record(keyword, value) {
  const body = utf8fromString(` ${keyword}=${value}\n`)
  let digits = 0
  for (;;) {
    const width = String(body.length + digits).length
    if (width === digits) break
    digits = width
  }
  return concat([utf8fromString(String(body.length + digits)), body])
}

// `records` is a list of [keyword, value] pairs, in the order they are to
// be written, with values already strings.
export const encodePax = (records) => concat(records.map(([keyword, value]) => record(keyword, value)))

function text(bytes, at) {
  try {
    return utf8toString(bytes)
  } catch {
    throw new TarError('a pax record is not valid UTF-8', at)
  }
}

export function decodePax(bytes, at) {
  const records = new Map()
  for (let pos = 0; pos < bytes.length;) {
    let i = pos
    let length = 0
    for (; i < bytes.length && bytes[i] >= DIGIT_0 && bytes[i] <= DIGIT_9; i++) length = length * 10 + (bytes[i] - DIGIT_0)
    if (i === pos || bytes[pos] === DIGIT_0 || bytes[i] !== SPACE) throw new TarError('a pax record does not begin with its length', at)
    const end = pos + length
    if (end > bytes.length || bytes[end - 1] !== NEWLINE) throw new TarError('a pax record is not as long as it says', at)
    const equals = bytes.indexOf(EQUALS, i + 1)
    if (equals === -1 || equals >= end - 1) throw new TarError('a pax record has no keyword=value', at)
    const keyword = text(bytes.subarray(i + 1, equals), at)
    // Keywords are printable and hold no space or `=`; anything else is a
    // record that was not written by a tar.
    if (keyword === '' || hasUnsafe(keyword, false) || keyword.includes(' ') || keyword.includes('=')) throw new TarError(`pax keyword ${JSON.stringify(keyword)} is malformed`, at)
    if (records.has(keyword)) throw new TarError(`pax keyword ${keyword} repeats`, at)
    records.set(keyword, text(bytes.subarray(equals + 1, end - 1), at))
    pos = end
  }
  return records
}
