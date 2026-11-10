// A .crate's or a .gem's gzip and tar, read as cargo and RubyGems read them.

import { crc32 } from '@exodus/bytes/crc.js'
import { CompressionError, decompress } from '@preventive/archive/compression.js'
import { ArchiveError, unpack } from '@preventive/archive/tar.js'
import { DeptreeError } from './error.js'

// Cargo's bound on what a .crate unpacks to: 512 MiB, or twenty times the
// .crate where that is more.
export const unpackLimit = (bytes) => Math.max(512 * 1024 * 1024, bytes.length * 20)

const [FTEXT, FEXTRA, FNAME, FCOMMENT] = [0x01, 0x04, 0x08, 0x10]

// Where the gzip member's deflate data starts, past its header: a header CRC
// or a reserved flag, which a reader may take or not, is refused.
function deflateStart(bytes, what, where) {
  if (bytes.length < 18 || bytes[0] !== 0x1f || bytes[1] !== 0x8b || bytes[2] !== 0x08) throw new DeptreeError(`${what} is not gzipped`, where)
  const flags = bytes[3]
  if (flags & ~(FTEXT | FEXTRA | FNAME | FCOMMENT)) throw new DeptreeError(`${what}'s gzip header has a header CRC or a reserved flag, which is not supported`, where)
  let at = 10
  if (flags & FEXTRA) at += 2 + (bytes[at] | (bytes[at + 1] << 8))
  for (const flag of [FNAME, FCOMMENT]) {
    if (!(flags & flag)) continue
    const end = bytes.indexOf(0, at)
    at = end === -1 ? bytes.length : end + 1
  }
  if (at > bytes.length - 8) throw new DeptreeError(`${what}'s gzip header runs past its end`, where)
  return at
}

// `what` as `reader` reads it, flate2 or Zlib, which read the first gzip
// member alone, so it has to be all of it, and check its trailer.
export async function gunzip(bytes, { what, reader, limit, where }) {
  const start = deflateStart(bytes, what, where)
  let data
  try {
    data = await decompress(bytes.subarray(start, bytes.length - 8), 'deflate-raw', { limit })
  } catch (error) {
    if (!(error instanceof CompressionError)) throw error
    throw new DeptreeError(error.limited ? `${what} unpacks to more than ${limit} bytes` : `${what} is not one gzip member, of which ${reader} reads the first alone`, where, { cause: error })
  }
  const trailer = new DataView(bytes.buffer, bytes.byteOffset + bytes.length - 8, 8)
  if (trailer.getUint32(0, true) !== crc32(data) || trailer.getUint32(4, true) !== data.length >>> 0) throw new DeptreeError(`${what}'s gzip trailer does not match its data`, where)
  return data
}

export function untar(tar, what, where) {
  try {
    return unpack(tar)
  } catch (error) {
    if (error instanceof ArchiveError) throw new DeptreeError(`${what} cannot be read: ${error.message}`, where, { cause: error })
    throw error
  }
}
