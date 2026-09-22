// The 512-byte ustar header block, as GNU tar 1.35 writes and reads it.
// String fields come back as bytes cut at the first NUL, not text: GNU cuts
// a long name at 100 bytes wherever the real name went, and that is not
// always a whole character, so only the field that counts gets decoded.

import { TarError } from './error.js'

export const BLOCK = 512
export const EMPTY = new Uint8Array(0)

export const NAME_SIZE = 100
export const PREFIX_SIZE = 155
// 32 bytes, and GNU always ends them with a NUL, so 31 is the most.
export const OWNER_SIZE = 32

const NAME = 0
const MODE = 100
const UID = 108
const GID = 116
const SIZE = 124
const MTIME = 136
const CHKSUM = 148
const TYPEFLAG = 156
const LINKNAME = 157
const MAGIC = 257
const UNAME = 265
const GNAME = 297
const DEVMAJOR = 329
const DEVMINOR = 337
const PREFIX = 345

const USTAR_MAGIC = 'ustar\u000000' // "ustar", NUL, "00": ustar and pax
const GNU_MAGIC = 'ustar  \0'

const latin1 = (text) => Uint8Array.from(text, (c) => c.codePointAt(0))
const ascii = (raw) => String.fromCodePoint(...raw)
// Throws (RangeError) rather than overwriting the next field.
const put = (block, offset, size, bytes) => block.subarray(offset, offset + size).set(bytes)

export const octalMax = (size) => 8 ** (size - 1) - 1
export const fitsOctal = (value, size) => value >= 0 && value <= octalMax(size)

// A number is size-1 octal digits and a NUL. GNU's format falls back to
// 0x80 (0xff when negative) and the value in base 256, big-endian, two's
// complement, over the rest of the field.
export function writeNumber(block, offset, size, value, gnu) {
  if (fitsOctal(value, size)) {
    put(block, offset, size, latin1(value.toString(8).padStart(size - 1, '0')))
    return
  }
  if (!gnu) throw new TarError(`${value} does not fit an octal field of ${size - 1} digits`)
  block[offset] = value < 0 ? 0xff : 0x80
  let v = BigInt.asUintN((size - 1) * 8, BigInt(value))
  for (let i = offset + size - 1; i > offset; i--) {
    block[i] = Number(v & 0xffn)
    v >>= 8n
  }
}

// Older tars wrote leading spaces, and either spaces or NULs after; a field
// left blank (npm's packer wrote uid and gid so for years) is 0, as GNU tar,
// libarchive and the rest read it. Only a time may be negative.
export function readNumber(block, offset, size, what, at, signed = false) {
  const first = block[offset]
  if (first === 0x80 || first === 0xff) {
    let v = 0n
    for (let i = offset + 1; i < offset + size; i++) v = (v << 8n) | BigInt(block[i])
    if (first === 0xff) v = BigInt.asIntN((size - 1) * 8, v)
    if (v < 0n && !signed) throw new TarError(`the ${what} field is negative`, at)
    if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < -BigInt(Number.MAX_SAFE_INTEGER)) throw new TarError(`the ${what} field is too large`, at)
    return Number(v)
  }
  const match = /^ *([0-7]*) *$/u.exec(ascii(block.subarray(offset, offset + size)).replaceAll('\0', ' '))
  if (!match) throw new TarError(`the ${what} field is not an octal number`, at)
  return match[1] === '' ? 0 : Number.parseInt(match[1], 8)
}

export function untilNul(raw) {
  const end = raw.indexOf(0)
  return end === -1 ? raw : raw.subarray(0, end)
}

const field = (block, offset, size) => untilNul(block.subarray(offset, offset + size))

// Every byte, with the checksum field itself counted as spaces.
function checksum(block) {
  let sum = 8 * 0x20
  for (let i = 0; i < CHKSUM; i++) sum += block[i]
  for (let i = CHKSUM + 8; i < BLOCK; i++) sum += block[i]
  return sum
}

export const isZeroBlock = (block) => block.every((byte) => byte === 0)

// String fields are bytes already cut to size; numbers already fit the
// format. `devmajor` and `devminor` are null except for a device, since
// GNU leaves those fields NUL for everything else.
export function encodeHeader(f) {
  const block = new Uint8Array(BLOCK)
  put(block, NAME, NAME_SIZE, f.name)
  writeNumber(block, MODE, 8, f.mode, f.gnu)
  writeNumber(block, UID, 8, f.uid, f.gnu)
  writeNumber(block, GID, 8, f.gid, f.gnu)
  writeNumber(block, SIZE, 12, f.size, f.gnu)
  writeNumber(block, MTIME, 12, f.mtime, f.gnu)
  block[TYPEFLAG] = f.typeflag
  put(block, LINKNAME, NAME_SIZE, f.linkname)
  put(block, MAGIC, 8, latin1(f.gnu ? GNU_MAGIC : USTAR_MAGIC))
  put(block, UNAME, OWNER_SIZE - 1, f.uname)
  put(block, GNAME, OWNER_SIZE - 1, f.gname)
  if (f.devmajor !== null) writeNumber(block, DEVMAJOR, 8, f.devmajor, f.gnu)
  if (f.devminor !== null) writeNumber(block, DEVMINOR, 8, f.devminor, f.gnu)
  put(block, PREFIX, PREFIX_SIZE, f.prefix)
  // The one field written as digits, NUL, space.
  put(block, CHKSUM, 8, latin1(`${checksum(block).toString(8).padStart(6, '0')}\0 `))
  return block
}

export function decodeHeader(block, at) {
  if (checksum(block) !== readNumber(block, CHKSUM, 8, 'checksum', at)) throw new TarError('header checksum does not match', at)
  const magic = ascii(block.subarray(MAGIC, MAGIC + 8))
  const gnu = magic === GNU_MAGIC
  if (!gnu && magic !== USTAR_MAGIC) throw new TarError('header is not in the ustar, pax or gnu format', at)
  const typeflag = block[TYPEFLAG]
  const device = typeflag === 0x33 || typeflag === 0x34
  return {
    gnu,
    typeflag,
    name: field(block, NAME, NAME_SIZE),
    // Under the gnu magic those bytes belong to the old GNU header instead.
    prefix: gnu ? EMPTY : field(block, PREFIX, PREFIX_SIZE),
    linkname: field(block, LINKNAME, NAME_SIZE),
    uname: field(block, UNAME, OWNER_SIZE),
    gname: field(block, GNAME, OWNER_SIZE),
    mode: readNumber(block, MODE, 8, 'mode', at),
    uid: readNumber(block, UID, 8, 'uid', at),
    gid: readNumber(block, GID, 8, 'gid', at),
    size: readNumber(block, SIZE, 12, 'size', at),
    mtime: readNumber(block, MTIME, 12, 'mtime', at, true),
    devmajor: device ? readNumber(block, DEVMAJOR, 8, 'devmajor', at) : 0,
    devminor: device ? readNumber(block, DEVMINOR, 8, 'devminor', at) : 0,
  }
}

export function concat(chunks) {
  const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}
