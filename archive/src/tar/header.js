import { EMPTY } from '../bytes.js'
import { ArchiveError } from '../error.js'

export const BLOCK = 512

export const isDevice = (type) => type === 'character-device' || type === 'block-device'

export const TYPEFLAGS = {
  file: 0x30,
  hardlink: 0x31,
  symlink: 0x32,
  'character-device': 0x33,
  'block-device': 0x34,
  directory: 0x35,
  fifo: 0x36,
  'contiguous-file': 0x37,
}
export const EXTENDED_TYPEFLAGS = { pax: 0x78, global: 0x67, longname: 0x4c, longlink: 0x4b }

export const NAME_SIZE = 100
export const PREFIX_SIZE = 155
export const OWNER_SIZE = 32 // GNU always ends one with a NUL, so 31 bytes at most

const NAME = 0
const NUMBERS = [['mode', 100, 8], ['uid', 108, 8], ['gid', 116, 8], ['size', 124, 12], ['mtime', 136, 12]]
const CHKSUM = 148
const TYPEFLAG = 156
const LINKNAME = 157
const MAGIC = 257
const UNAME = 265
const GNAME = 297
const DEVMAJOR = 329
const DEVMINOR = 337
const PREFIX = 345
// Under the gnu magic, the old sparse map and real size: libarchive reads them whatever the type flag
const OLD_SPARSE = 386
const OLD_SPARSE_END = 495

const USTAR_MAGIC = 'ustar\u000000' // ustar and pax
const GNU_MAGIC = 'ustar  \0'

const latin1 = (text) => Uint8Array.from(text, (c) => c.codePointAt(0))
const ascii = (raw) => String.fromCodePoint(...raw)
const put = (block, offset, size, bytes) => block.subarray(offset, offset + size).set(bytes) // throws rather than overflow
const field = (block, offset, size) => untilNul(block.subarray(offset, offset + size))

export const octalMax = (size) => 8 ** (size - 1) - 1
export const fitsOctal = (value, size) => value >= 0 && value <= octalMax(size)

// Octal digits and a NUL, or for gnu, 0x80 (0xff if negative) and two's complement base 256 after it
export function writeNumber(block, offset, size, value, gnu) {
  if (fitsOctal(value, size)) {
    put(block, offset, size, latin1(value.toString(8).padStart(size - 1, '0')))
    return
  }
  if (!gnu) throw new ArchiveError(`${value} does not fit an octal field of ${size - 1} digits`)
  block[offset] = value < 0 ? 0xff : 0x80
  let v = BigInt.asUintN((size - 1) * 8, BigInt(value))
  for (let i = offset + size - 1; i > offset; i--) {
    block[i] = Number(v & 0xffn)
    v >>= 8n
  }
}

// Spaces around the digits and a blank field (0) are read as GNU tar and libarchive do. A NUL ends
// the number wherever it sits, as in GNU tar, which reading past it would disagree with.
export function readNumber(block, offset, size, what, at, signed = false) {
  const first = block[offset]
  if (first === 0x80 || first === 0xff) {
    let v = 0n
    for (let i = offset + 1; i < offset + size; i++) v = (v << 8n) | BigInt(block[i])
    if (first === 0xff) v = BigInt.asIntN((size - 1) * 8, v)
    if (v < 0n && !signed) throw new ArchiveError(`the ${what} field is negative`, at)
    if (!Number.isSafeInteger(Number(v))) throw new ArchiveError(`the ${what} field is too large`, at)
    return Number(v)
  }
  const match = /^ *([0-7]*) *$/u.exec(ascii(field(block, offset, size)))
  if (!match) throw new ArchiveError(`the ${what} field is not an octal number`, at)
  return match[1] === '' ? 0 : Number.parseInt(match[1], 8)
}

export function untilNul(raw) {
  const end = raw.indexOf(0)
  return end === -1 ? raw : raw.subarray(0, end)
}

// The checksum field itself counts as spaces
function checksum(block) {
  let sum = 8 * 0x20
  for (let i = 0; i < CHKSUM; i++) sum += block[i]
  for (let i = CHKSUM + 8; i < BLOCK; i++) sum += block[i]
  return sum
}

export const isZeroBlock = (block) => block.every((byte) => byte === 0)

// Strings are bytes already cut to size, numbers already fit; device numbers are null but for a device
export function encodeHeader(f) {
  const block = new Uint8Array(BLOCK)
  put(block, NAME, NAME_SIZE, f.name)
  for (const [key, offset, size] of NUMBERS) writeNumber(block, offset, size, f[key], f.gnu)
  block[TYPEFLAG] = f.typeflag
  put(block, LINKNAME, NAME_SIZE, f.linkname)
  put(block, MAGIC, 8, latin1(f.gnu ? GNU_MAGIC : USTAR_MAGIC))
  put(block, UNAME, OWNER_SIZE - 1, f.uname)
  put(block, GNAME, OWNER_SIZE - 1, f.gname)
  if (f.devmajor !== null) writeNumber(block, DEVMAJOR, 8, f.devmajor, f.gnu)
  if (f.devminor !== null) writeNumber(block, DEVMINOR, 8, f.devminor, f.gnu)
  put(block, PREFIX, PREFIX_SIZE, f.prefix)
  put(block, CHKSUM, 8, latin1(`${checksum(block).toString(8).padStart(6, '0')}\0 `))
  return block
}

const isOctal = (block, offset, size) => /^ *[0-7]+ *$/u.test(ascii(field(block, offset, size)))

// Strings come back as bytes: GNU cuts a long name at 100 bytes, not always on a whole character
export function decodeHeader(block, at) {
  if (checksum(block) !== readNumber(block, CHKSUM, 8, 'checksum', at)) throw new ArchiveError('header checksum does not match', at)
  const magic = ascii(block.subarray(MAGIC, MAGIC + 8))
  const gnu = magic === GNU_MAGIC
  if (!gnu && magic !== USTAR_MAGIC) throw new ArchiveError('header is not in the ustar, pax or gnu format', at)
  if (gnu && !isZeroBlock(block.subarray(OLD_SPARSE, OLD_SPARSE_END))) throw new ArchiveError('header carries an old GNU sparse map or real size', at)
  const typeflag = block[TYPEFLAG]
  const device = typeflag === TYPEFLAGS['character-device'] || typeflag === TYPEFLAGS['block-device']
  const numbers = [['checksum', CHKSUM, 8], ...NUMBERS, ...(device ? [['devmajor', DEVMAJOR, 8], ['devminor', DEVMINOR, 8]] : [])]
  return {
    gnu,
    typeflag,
    name: field(block, NAME, NAME_SIZE),
    prefix: gnu ? EMPTY : field(block, PREFIX, PREFIX_SIZE), // gnu has its own fields there
    linkname: field(block, LINKNAME, NAME_SIZE),
    uname: field(block, UNAME, OWNER_SIZE),
    gname: field(block, GNAME, OWNER_SIZE),
    ...Object.fromEntries(NUMBERS.map(([key, offset, size]) => [key, readNumber(block, offset, size, key, at, key === 'mtime')])),
    devmajor: device ? readNumber(block, DEVMAJOR, 8, 'devmajor', at) : 0,
    devminor: device ? readNumber(block, DEVMINOR, 8, 'devminor', at) : 0,
    octal: numbers.every(([, offset, size]) => isOctal(block, offset, size)),
  }
}
