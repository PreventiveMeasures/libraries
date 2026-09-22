// Little-endian fields, one buffer out of several, and raw deflate through
// the platform's streams — the only compressor this package has.

import { ArchiveError } from '../error.js'

export function concat(chunks) {
  const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

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

// The stream fed all of `bytes`, read back whole; reading and writing go on
// together, since the stream would otherwise fill up and wait. Output past
// `limit` is refused where it is, not after it has been made.
async function through(bytes, stream, limit, at) {
  const writer = stream.writable.getWriter()
  const writing = writer.write(bytes).then(() => writer.close())
  writing.catch(() => {})
  const reader = stream.readable.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    total += value.length
    if (total > limit) {
      await reader.cancel()
      throw new ArchiveError('an entry inflates to more than its declared size', at)
    }
    chunks.push(value)
  }
  await writing
  return concat(chunks)
}

export const deflate = (bytes) => through(bytes, new CompressionStream('deflate-raw'), Infinity)

export async function inflate(bytes, size, at) {
  let out
  try {
    out = await through(bytes, new DecompressionStream('deflate-raw'), size, at)
  } catch (error) {
    if (error instanceof ArchiveError) throw error
    throw new ArchiveError('an entry does not inflate', at)
  }
  if (out.length !== size) throw new ArchiveError('an entry inflates to less than its declared size', at)
  return out
}

// DOS time is two seconds and a year from 1980, in the maker's local time —
// read and written here as UTC.
export function toDos(mtime) {
  const date = new Date(mtime * 1000)
  const year = date.getUTCFullYear()
  if (year < 1980 || year > 2107) throw new ArchiveError(`mtime ${mtime} is outside DOS time, 1980 to 2107`)
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  }
}

export function fromDos(date, time, at) {
  const fields = [1980 + (date >> 9), (date >> 5) & 15, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2]
  const [year, month, day, hours, minutes, seconds] = fields
  const stamp = Date.UTC(year, month - 1, day, hours, minutes, seconds)
  const back = new Date(stamp)
  const same = [back.getUTCFullYear(), back.getUTCMonth() + 1, back.getUTCDate(), back.getUTCHours(), back.getUTCMinutes(), back.getUTCSeconds()]
  if (same.some((value, i) => value !== fields[i])) throw new ArchiveError('an entry has an invalid DOS time', at)
  return stamp / 1000
}
