// The 512-byte header block, as GNU tar 1.35 writes it and reads it. The
// layout is the POSIX ustar one and is shared by every format this package
// speaks: gnu and ustar differ only in the eight magic bytes and in what a
// number too big for its field turns into, and pax is ustar with extra
// records in front. What is in each field is decided by pack.js and
// unpack.js; this module only knows how a field is written and read.
//
// Numbers are octal, one digit fewer than the field and a NUL after them,
// which is the only form ustar has. GNU's own format keeps that where it
// fits and otherwise writes 0x80 (0xff for a negative number) followed by
// the value in base 256, big-endian, in the rest of the field: tar's
// to_chars, which is where the two forms and their boundaries come from.
//
// Strings come back as bytes, cut at the first NUL, not as text: a name too
// long for its field is cut at 100 bytes by GNU tar wherever the real name
// went, and 100 bytes is not always a whole character. Whoever reads a
// field decides whether it is the one that counts, and decodes it then.

import { TarError } from './error.js'

export const BLOCK = 512
// Read-only, and handed out as padding: a subarray of it is never written.
export const ZEROS = new Uint8Array(BLOCK)
export const EMPTY = ZEROS.subarray(0, 0)

export const NAME_SIZE = 100
export const PREFIX_SIZE = 155
// The uname and gname fields are 32 bytes, and GNU tar always ends them
// with a NUL, so 31 is the most a name can be.
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

// "ustar\0" and "00" for ustar and pax; "ustar " and " \0" for gnu.
const USTAR_MAGIC = new Uint8Array([0x75, 0x73, 0x74, 0x61, 0x72, 0, 0x30, 0x30])
const GNU_MAGIC = new Uint8Array([0x75, 0x73, 0x74, 0x61, 0x72, 0x20, 0x20, 0])

const SPACE = 0x20

// The largest value a field of `size` bytes holds in octal.
export const octalMax = (size) => 8 ** (size - 1) - 1
export const fitsOctal = (value, size) => value >= 0 && value <= octalMax(size)

function writeOctal(block, offset, size, value) {
  let v = value
  for (let i = offset + size - 2; i >= offset; i--) {
    block[i] = 0x30 + (v % 8)
    v = Math.floor(v / 8)
  }
}

// GNU's fallback: a marker byte, then the value in base 256 over the rest of
// the field, in two's complement when negative — which the marker also says.
function writeBase256(block, offset, size, value) {
  block[offset] = value < 0 ? 0xff : 0x80
  let v = BigInt.asUintN((size - 1) * 8, BigInt(value))
  for (let i = offset + size - 1; i > offset; i--) {
    block[i] = Number(v & 0xffn)
    v >>= 8n
  }
}

// The caller has already decided the value can be written: in gnu anything
// a safe integer holds can be, elsewhere only what fits in octal. The check
// here is a guard against that decision being missed, not a way to make it.
export function writeNumber(block, offset, size, value, gnu) {
  if (fitsOctal(value, size)) writeOctal(block, offset, size, value)
  else if (gnu) writeBase256(block, offset, size, value)
  else throw new TarError(`${value} does not fit an octal field of ${size - 1} digits`)
}

// What GNU tar accepts: leading spaces (older tars wrote them), octal digits,
// and then NUL or space to the end of the field — or its own base 256, with
// the marker byte exactly as it writes it.
export function readNumber(block, offset, size, what, at) {
  const first = block[offset]
  if (first === 0x80 || first === 0xff) {
    let v = 0n
    for (let i = offset + 1; i < offset + size; i++) v = (v << 8n) | BigInt(block[i])
    if (first === 0xff) v = BigInt.asIntN((size - 1) * 8, v)
    if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < -BigInt(Number.MAX_SAFE_INTEGER)) throw new TarError(`the ${what} field is too large`, at)
    return Number(v)
  }
  const end = offset + size
  let i = offset
  while (i < end && block[i] === SPACE) i++
  const start = i
  let value = 0
  for (; i < end && block[i] >= 0x30 && block[i] <= 0x37; i++) value = value * 8 + (block[i] - 0x30)
  if (i === start) throw new TarError(`the ${what} field holds no number`, at)
  for (; i < end; i++) {
    if (block[i] !== 0 && block[i] !== SPACE) throw new TarError(`the ${what} field is not octal`, at)
  }
  return value
}

// The bytes of a string field up to its first NUL, or the whole field when
// it has none, which a 100-byte name is allowed to be.
function field(block, offset, size) {
  let end = offset
  const limit = offset + size
  while (end < limit && block[end] !== 0) end++
  return block.subarray(offset, end)
}

// The sum of every byte with the checksum field itself read as spaces —
// both when it is computed to be written, and when it is recomputed to be
// checked. It fits six octal digits, which is what the field is given, with
// a NUL and a space after them rather than only the NUL: the one field
// written that way.
function checksum(block) {
  let sum = 8 * SPACE
  for (let i = 0; i < CHKSUM; i++) sum += block[i]
  for (let i = CHKSUM + 8; i < BLOCK; i++) sum += block[i]
  return sum
}

export const isZeroBlock = (block) => block.every((byte) => byte === 0)

// `name`, `prefix`, `linkname`, `uname` and `gname` are bytes already cut to
// their fields; the numbers already fit the format asked for; `devmajor` and
// `devminor` are null for anything but a device, where GNU tar leaves the
// two fields NUL in every format.
export function encodeHeader(f) {
  const block = new Uint8Array(BLOCK)
  block.set(f.name, NAME)
  writeNumber(block, MODE, 8, f.mode, f.gnu)
  writeNumber(block, UID, 8, f.uid, f.gnu)
  writeNumber(block, GID, 8, f.gid, f.gnu)
  writeNumber(block, SIZE, 12, f.size, f.gnu)
  writeNumber(block, MTIME, 12, f.mtime, f.gnu)
  block[TYPEFLAG] = f.typeflag
  block.set(f.linkname, LINKNAME)
  block.set(f.gnu ? GNU_MAGIC : USTAR_MAGIC, MAGIC)
  block.set(f.uname, UNAME)
  block.set(f.gname, GNAME)
  if (f.devmajor !== null) writeNumber(block, DEVMAJOR, 8, f.devmajor, f.gnu)
  if (f.devminor !== null) writeNumber(block, DEVMINOR, 8, f.devminor, f.gnu)
  block.set(f.prefix, PREFIX)
  writeOctal(block, CHKSUM, 7, checksum(block))
  block[CHKSUM + 7] = SPACE
  return block
}

const sameBytes = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i])

// A header read back: the checksum has to hold and the magic has to be one
// of the two this package writes, or the block is not a header it can trust
// — a v7 archive, a corrupted one, or something that is not tar at all.
// The prefix field is only a prefix under the ustar magic; under gnu's, the
// bytes there belong to the old GNU header and say nothing about the name.
export function decodeHeader(block, at) {
  if (checksum(block) !== readNumber(block, CHKSUM, 8, 'checksum', at)) throw new TarError('header checksum does not match', at)
  const magic = block.subarray(MAGIC, MAGIC + 8)
  const gnu = sameBytes(magic, GNU_MAGIC)
  if (!gnu && !sameBytes(magic, USTAR_MAGIC)) throw new TarError('header is not in the ustar, pax or gnu format', at)
  const typeflag = block[TYPEFLAG]
  const device = typeflag === 0x33 || typeflag === 0x34
  return {
    gnu,
    typeflag,
    name: field(block, NAME, NAME_SIZE),
    prefix: gnu ? EMPTY : field(block, PREFIX, PREFIX_SIZE),
    linkname: field(block, LINKNAME, NAME_SIZE),
    uname: field(block, UNAME, OWNER_SIZE),
    gname: field(block, GNAME, OWNER_SIZE),
    mode: readNumber(block, MODE, 8, 'mode', at),
    uid: readNumber(block, UID, 8, 'uid', at),
    gid: readNumber(block, GID, 8, 'gid', at),
    size: readNumber(block, SIZE, 12, 'size', at),
    mtime: readNumber(block, MTIME, 12, 'mtime', at),
    devmajor: device ? readNumber(block, DEVMAJOR, 8, 'devmajor', at) : 0,
    devminor: device ? readNumber(block, DEVMINOR, 8, 'devminor', at) : 0,
  }
}

// One buffer out of several, which is what pack() hands back and what a
// body that arrived in pieces becomes.
export function concat(chunks) {
  let total = 0
  for (const chunk of chunks) total += chunk.length
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}
