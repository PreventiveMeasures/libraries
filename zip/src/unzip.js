// A zip archive in, its entries out, in the order of the central directory,
// which is what a zip is read from. Strict throughout: the end record has to
// sit at the very end, the central directory right before it, and the
// entries have to tile everything before that from byte 0 — no bytes belong
// to nothing, no two entries share any. Each local header has to agree with
// the central directory, the data has to inflate to exactly the declared
// size and match its CRC-32, and what this package does not model — zip64,
// encryption, any method but stored and deflate, several disks — is refused.

import { crc32 } from '@exodus/bytes/crc.js'
import { fromDos, inflate, view } from './bytes.js'
import { ZipError } from './error.js'
import { Names, cleanNames } from './names.js'
import { decodeUtf8, quote } from './text.js'

const LOCAL = 0x04034b50
const CENTRAL = 0x02014b50
const END = 0x06054b50
const DESCRIPTOR = 0x08074b50
const ZIP64_LOCATOR = 0x07064b50
const ZIP64_EXTRA = 0x0001
const TIMESTAMP_EXTRA = 0x5455

const ENCRYPTED = 1
const DESCRIBED = 8 // sizes and CRC follow the data, and may be 0 in the local header
const DOS_DIRECTORY = 0x10
const S_IFMT = 0o170000
const S_IFREG = 0o100000
const S_IFDIR = 0o40000
const S_IFLNK = 0o120000
const DEFAULT_MODE = { file: 0o644, directory: 0o755, symlink: 0o777 }
const EMPTY = new Uint8Array(0)

const sameBytes = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i])

// Bounds-checked little-endian reads over the archive.
function reader(bytes) {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const check = (at, width) => {
    if (at < 0 || at + width > bytes.length) throw new ZipError('the archive is truncated', at)
  }
  return {
    length: bytes.length,
    u16: (at) => (check(at, 2), data.getUint16(at, true)),
    u32: (at) => (check(at, 4), data.getUint32(at, true)),
    slice: (at, width) => (check(at, width), bytes.subarray(at, at + width)),
  }
}

// The end record is the last 22 bytes plus its comment, and nothing after.
function findEnd(r) {
  for (let at = r.length - 22; at >= Math.max(0, r.length - 22 - 0xffff); at--) {
    if (r.u32(at) === END && at + 22 + r.u16(at + 20) === r.length) {
      if (at >= 20 && r.u32(at - 20) === ZIP64_LOCATOR) throw new ZipError('zip64 is not supported', at - 20)
      return at
    }
  }
  throw new ZipError('no end of central directory record')
}

// Extra fields, each an id, a length and that many bytes, tiling the room.
function extras(raw, at) {
  const fields = new Map()
  const r = reader(raw)
  for (let pos = 0; pos < raw.length;) {
    const id = r.u16(pos)
    const size = r.u16(pos + 2)
    if (pos + 4 + size > raw.length) throw new ZipError('an extra field runs past its room', at)
    if (id === ZIP64_EXTRA) throw new ZipError('zip64 is not supported', at)
    if (!fields.has(id)) fields.set(id, raw.subarray(pos + 4, pos + 4 + size))
    pos += 4 + size
  }
  return fields
}

function readCentral(r, at) {
  if (r.u32(at) !== CENTRAL) throw new ZipError('no central directory entry where one is counted', at)
  const flags = r.u16(at + 8)
  const method = r.u16(at + 10)
  const nameLength = r.u16(at + 28)
  const extraLength = r.u16(at + 30)
  const commentLength = r.u16(at + 32)
  if (r.u16(at + 34) !== 0) throw new ZipError('the archive spans several disks', at)
  if (flags & ENCRYPTED) throw new ZipError('an entry is encrypted', at)
  if (method !== 0 && method !== 8) throw new ZipError(`compression method ${method} is not stored or deflate`, at)
  const entry = {
    at,
    flags,
    method,
    crc: r.u32(at + 16),
    csize: r.u32(at + 20),
    usize: r.u32(at + 24),
    madeBy: r.u16(at + 4),
    attributes: r.u32(at + 38),
    offset: r.u32(at + 42),
    name: r.slice(at + 46, nameLength),
    next: at + 46 + nameLength + extraLength + commentLength,
  }
  if (entry.csize === 0xffffffff || entry.usize === 0xffffffff || entry.offset === 0xffffffff) throw new ZipError('zip64 is not supported', at)
  const stamp = extras(r.slice(at + 46 + nameLength, extraLength), at).get(TIMESTAMP_EXTRA)
  entry.mtime = stamp !== undefined && stamp.length >= 5 && stamp[0] & 1 ? view(stamp).getInt32(1, true) : fromDos(r.u16(at + 14), r.u16(at + 12), at)
  return entry
}

// The local header checked against the central entry; returns where the
// entry's bytes end and notes where its data starts.
function readLocal(r, entry) {
  const at = entry.offset
  if (r.u32(at) !== LOCAL) throw new ZipError('no local header where the central directory points', at)
  const flags = r.u16(at + 6)
  const nameLength = r.u16(at + 26)
  const extraLength = r.u16(at + 28)
  if (flags & ENCRYPTED) throw new ZipError('an entry is encrypted', at)
  if (!sameBytes(r.slice(at + 30, nameLength), entry.name)) throw new ZipError('the local header names a different entry', at)
  if (r.u16(at + 8) !== entry.method) throw new ZipError('the local header has a different compression method', at)
  extras(r.slice(at + 30 + nameLength, extraLength), at)
  const described = flags & DESCRIBED
  const agrees = (field, value) => r.u32(at + field) === value || (described && r.u32(at + field) === 0)
  if (!agrees(14, entry.crc) || !agrees(18, entry.csize) || !agrees(22, entry.usize)) throw new ZipError('the local header disagrees with the central directory', at)
  entry.dataAt = at + 30 + nameLength + extraLength
  let end = entry.dataAt + entry.csize
  if (described) {
    if (r.u32(end) === DESCRIPTOR) end += 4
    if (r.u32(end) !== entry.crc || r.u32(end + 4) !== entry.csize || r.u32(end + 8) !== entry.usize) throw new ZipError('the data descriptor disagrees with the central directory', end)
    end += 12
  }
  return end
}

function typeOf(entry, rawName, mode) {
  const format = mode & S_IFMT
  const slashed = rawName.endsWith('/')
  if (slashed) {
    if (format !== 0 && format !== S_IFDIR) throw new ZipError(`${quote(rawName)} is a directory by its name but not by its mode`, entry.at)
    return 'directory'
  }
  if (format === S_IFDIR) throw new ZipError(`${quote(rawName)} is a directory by its mode but not by its name`, entry.at)
  if (entry.attributes & DOS_DIRECTORY) throw new ZipError(`${quote(rawName)} is a directory by its attributes but not by its name`, entry.at)
  if (format === S_IFLNK) return 'symlink'
  if (format === 0 || format === S_IFREG) return 'file'
  throw new ZipError(`the mode of ${quote(rawName)} (${mode.toString(8)}) is not one this package reads`, entry.at)
}

async function entryOf(r, entry, names) {
  const { at, method, csize, usize } = entry
  const rawName = decodeUtf8(entry.name, 'entry name', at)
  // Only a Unix maker's attributes carry a mode.
  const mode = entry.madeBy >> 8 === 3 ? Math.floor(entry.attributes / 0x10000) : 0
  const type = typeOf(entry, rawName, mode)
  if (type === 'directory' && usize !== 0) throw new ZipError(`directory ${quote(rawName)} has data`, at)
  if (method === 0 && csize !== usize) throw new ZipError('a stored entry has two sizes', at)
  const body = method === 8 ? await inflate(r.slice(entry.dataAt, csize), usize, at) : r.slice(entry.dataAt, csize)
  if (crc32(body) !== entry.crc) throw new ZipError('the data does not match its CRC-32', at)
  const target = type === 'symlink' ? decodeUtf8(body, 'symlink target', at) : ''
  let named
  try {
    named = cleanNames(rawName, type, target)
  } catch (error) {
    throw new ZipError(error.message, at)
  }
  const out = { ...named, type, mode: mode === 0 ? DEFAULT_MODE[type] : mode & 0o7777, mtime: entry.mtime, data: type === 'file' ? body : EMPTY }
  try {
    names.add(out)
  } catch (error) {
    throw new ZipError(error.message, at)
  }
  return out
}

export async function unzip(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new ZipError('the archive is not a Uint8Array')
  const r = reader(bytes)
  const end = findEnd(r)
  const count = r.u16(end + 8)
  if (r.u16(end + 4) !== 0 || r.u16(end + 6) !== 0 || count !== r.u16(end + 10)) throw new ZipError('the archive spans several disks', end)
  const size = r.u32(end + 12)
  const start = r.u32(end + 16)
  if (count === 0xffff || size === 0xffffffff || start === 0xffffffff) throw new ZipError('zip64 is not supported', end)
  if (start + size !== end) throw new ZipError('the central directory does not end at the end record', end)
  const entries = []
  let pos = start
  for (let i = 0; i < count; i++) {
    const entry = readCentral(r, pos)
    entries.push(entry)
    pos = entry.next
  }
  if (pos !== end) throw new ZipError('the central directory does not hold what the end record counts', pos)
  let expected = 0
  for (const entry of entries.toSorted((a, b) => a.offset - b.offset)) {
    if (entry.offset !== expected) throw new ZipError(entry.offset > expected ? 'bytes belong to no entry' : 'two entries overlap', expected)
    expected = readLocal(r, entry)
  }
  if (expected !== start) throw new ZipError('bytes belong to no entry', expected)
  const names = new Names()
  const out = []
  for (const entry of entries) out.push(await entryOf(r, entry, names))
  return out
}
