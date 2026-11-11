import { utf8fromString } from '@exodus/bytes/utf8.js'
import { concat } from '../bytes.js'
import { ArchiveError } from '../error.js'
import { decodeUtf8, hasUnsafe, quote } from '../text.js'

// `<length> <keyword>=<value>\n`, the length counting the whole record, its own digits included
function record(keyword, value) {
  const body = utf8fromString(` ${keyword}=${value}\n`)
  let length = body.length + 1
  while (body.length + String(length).length !== length) length++
  return concat([utf8fromString(String(length)), body])
}

export const encodePax = (records) => concat(records.map(([keyword, value]) => record(keyword, value)))

// Read-only, as entries under one global header share its records
const READ_ONLY = 'pax records cannot be changed'
export class Records extends Map {
  set() {
    throw new TypeError(READ_ONLY)
  }

  delete() {
    throw new TypeError(READ_ONLY)
  }

  clear() {
    throw new TypeError(READ_ONLY)
  }
}

export function decodePax(bytes, at) {
  const records = new Records()
  for (let pos = 0; pos < bytes.length;) {
    let i = pos
    let length = 0
    for (; i < bytes.length && bytes[i] >= 0x30 && bytes[i] <= 0x39; i++) length = length * 10 + (bytes[i] - 0x30)
    if (i === pos || bytes[pos] === 0x30 || bytes[i] !== 0x20) throw new ArchiveError('a pax record does not begin with its length', at)
    const end = pos + length
    if (end > bytes.length || bytes[end - 1] !== 0x0a) throw new ArchiveError('a pax record is not as long as it says', at)
    const equals = bytes.indexOf(0x3d, i + 1)
    if (equals === -1 || equals >= end - 1) throw new ArchiveError('a pax record has no keyword=value', at)
    const keyword = decodeUtf8(bytes.subarray(i + 1, equals), 'a pax record', at)
    if (keyword === '' || hasUnsafe(keyword, false) || keyword.includes(' ')) throw new ArchiveError(`pax keyword ${quote(keyword)} is malformed`, at)
    if (records.has(keyword)) throw new ArchiveError(`pax keyword ${keyword} repeats`, at)
    Map.prototype.set.call(records, keyword, decodeUtf8(bytes.subarray(equals + 1, end - 1), 'a pax record', at))
    pos = end
  }
  return records
}
