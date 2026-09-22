// pax extended header records: `<length> <keyword>=<value>\n`, the length
// in decimal counting the whole line, its own digits included.

import { utf8fromString, utf8toString } from '@exodus/bytes/utf8.js'
import { TarError } from './error.js'
import { concat } from './header.js'
import { hasUnsafe } from './names.js'

function record(keyword, value) {
  const body = utf8fromString(` ${keyword}=${value}\n`)
  // The smallest total that still has as many digits as it counts.
  let total = body.length
  for (let next = body.length + String(total).length; next !== total; next = body.length + String(total).length) total = next
  return concat([utf8fromString(String(total)), body])
}

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
    for (; i < bytes.length && bytes[i] >= 0x30 && bytes[i] <= 0x39; i++) length = length * 10 + (bytes[i] - 0x30)
    if (i === pos || bytes[pos] === 0x30 || bytes[i] !== 0x20) throw new TarError('a pax record does not begin with its length', at)
    const end = pos + length
    if (end > bytes.length || bytes[end - 1] !== 0x0a) throw new TarError('a pax record is not as long as it says', at)
    const equals = bytes.indexOf(0x3d, i + 1)
    if (equals === -1 || equals >= end - 1) throw new TarError('a pax record has no keyword=value', at)
    const keyword = text(bytes.subarray(i + 1, equals), at)
    if (keyword === '' || hasUnsafe(keyword, false) || keyword.includes(' ')) throw new TarError(`pax keyword ${JSON.stringify(keyword)} is malformed`, at)
    if (records.has(keyword)) throw new TarError(`pax keyword ${keyword} repeats`, at)
    records.set(keyword, text(bytes.subarray(equals + 1, end - 1), at))
    pos = end
  }
  return records
}
