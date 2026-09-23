// What the zip half shares: the record signatures and mode bits, little-
// endian fields, DOS time, and raw deflate under zip's own words.

import { compress, decompressInto } from '../compression.js'
import { ArchiveError } from '../error.js'

export const LOCAL = 0x04034b50
export const CENTRAL = 0x02014b50
export const END = 0x06054b50

// The Unix file type bits, which the external attributes carry.
export const TYPE_MASK = 0o170000
export const TYPE_BITS = { file: 0o100000, directory: 0o40000, symlink: 0o120000 }

export const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

// A record laid out as [width, value] pairs, widths 1, 2 or 4. A value
// that does not fit its width is a bug upstream, not a field to truncate.
export function record(fields) {
  const out = new Uint8Array(fields.reduce((total, [width]) => total + width, 0))
  const data = view(out)
  let at = 0
  for (const [width, value] of fields) {
    if (!Number.isInteger(value) || value < 0 || value >= 2 ** (8 * width)) throw new RangeError(`${value} does not fit ${width} bytes`)
    if (width === 1) data.setUint8(at, value)
    else if (width === 2) data.setUint16(at, value, true)
    else data.setUint32(at, value, true)
    at += width
  }
  return out
}

export const deflate = (bytes) => compress(bytes, 'deflate-raw')

// Deflate spends at least two bits on a match, and a match is at most 258
// bytes, so no data inflates to more than 1032 times its own size: zlib's
// best, on zeros, is 1028.8.
const MAX_RATIO = 1032

// Exactly the declared size, made in place, with output past it refused
// where it is. Room for all of it is made first, so a size the data could
// not inflate to is refused before that: past it, a few bytes of archive
// would have room made for gigabytes no valid one of their size holds.
export async function inflate(bytes, size, at) {
  if (size > bytes.length * MAX_RATIO) throw new ArchiveError('an entry declares more than its data can inflate to', at)
  let out
  try {
    out = await decompressInto(bytes, 'deflate-raw', new Uint8Array(size))
  } catch (error) {
    throw new ArchiveError(error.limited ? 'an entry inflates to more than its declared size' : 'an entry does not inflate', at)
  }
  if (out.length !== size) throw new ArchiveError('an entry inflates to less than its declared size', at)
  return out
}

// DOS time is two seconds and a year from 1980, in the maker's local time —
// read and written here as UTC.
function dos(seconds) {
  const date = new Date(seconds * 1000)
  const year = date.getUTCFullYear()
  if (year < 1980 || year > 2107) return null
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  }
}

export function toDos(mtime) {
  const fields = dos(mtime)
  if (fields === null) throw new ArchiveError(`mtime ${mtime} is outside DOS time, 1980 to 2107`)
  return fields
}

// Fields that do not come back as themselves named no date at all.
export function fromDos(date, time, at) {
  const seconds = Date.UTC(1980 + (date >> 9), ((date >> 5) & 15) - 1, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2) / 1000
  const fields = dos(seconds)
  if (fields === null || fields.time !== time || fields.date !== date) throw new ArchiveError('an entry has an invalid DOS time', at)
  return seconds
}
