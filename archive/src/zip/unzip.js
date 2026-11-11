import { crc32 } from '@exodus/bytes/crc.js'
import { EMPTY, sameBytes } from '../bytes.js'
import { DEFAULT_MODE } from '../entry.js'
import { ArchiveError, located } from '../error.js'
import { Names, cleanNames } from '../names.js'
import { decodeUtf8, quote } from '../text.js'
import { CENTRAL, END, LOCAL, TYPE_BITS, TYPE_MASK, fromDos, inflate, view } from './format.js'

// Strict: the end record ends the archive, the central directory ends at it, and the entries tile
// everything before it from byte 0. Each local header agrees with the central directory, each entry
// inflates to exactly its declared size and CRC-32; zip64, encryption and other methods are refused.

const DESCRIPTOR = 0x08074b50
const ZIP64_LOCATOR = 0x07064b50
const ZIP64_EXTRA = 0x0001
const TIMESTAMP_EXTRA = 0x5455
const UNICODE_PATH_EXTRA = 0x7075 // a second name, which Info-ZIP's unzip takes over the header's

const ENCRYPTED = 1
const DESCRIBED = 8 // sizes and CRC follow the data, and may be 0 in the local header
const DOS_DIRECTORY = 0x10

// Bounds-checked reads of `bytes`, which sit at `base` in the archive, by the archive's own offsets
function reader(bytes, base = 0) {
  const data = view(bytes)
  const check = (at, width) => {
    if (at < base || at + width > base + bytes.length) throw new ArchiveError('the archive is truncated', at)
  }
  return {
    u16: (at) => (check(at, 2), data.getUint16(at - base, true)),
    u32: (at) => (check(at, 4), data.getUint32(at - base, true)),
    range: (at, width) => (check(at, width), bytes.subarray(at - base, at - base + width)),
  }
}

// The archive a range at a time: views of it in memory, reads of just that range from a Blob
function sourceOf(archive) {
  if (archive instanceof Uint8Array) {
    const whole = reader(archive)
    return { size: archive.length, read: (from, to) => archive.subarray(from, to), window: () => whole }
  }
  if (archive instanceof Blob) {
    const read = async (from, to) => new Uint8Array(await archive.slice(from, to).arrayBuffer())
    return { size: archive.size, read, window: async (from, to) => reader(await read(from, Math.min(to, archive.size)), from) }
  }
  throw new ArchiveError('the archive is not a Uint8Array or a Blob')
}

// Reads for a walk forward through small records: each window reads ahead up to CHUNK bytes,
// short of `stop`, so the records after come in the same read and data past them is not read
const CHUNK = 1 << 16

function walk(source) {
  let r
  let from = 0
  let to = 0
  return async (at, width, stop = Infinity) => {
    const need = Math.min(at + width, source.size)
    if (r === undefined || at < from || need > to) {
      from = at
      to = Math.max(need, Math.min(at + CHUNK, stop, source.size))
      r = await source.window(from, to)
    }
    return r
  }
}

// The last 22 bytes and the comment they count, read with the 20 before, where a zip64 locator would be
async function findEnd(source) {
  const { size } = source
  const r = await source.window(Math.max(0, size - 22 - 0xffff - 20), size)
  for (let at = size - 22; at >= Math.max(0, size - 22 - 0xffff); at--) {
    if (r.u32(at) === END && at + 22 + r.u16(at + 20) === size) {
      if (at >= 20 && r.u32(at - 20) === ZIP64_LOCATOR) throw new ArchiveError('zip64 is not supported', at - 20)
      return { end: at, r }
    }
  }
  throw new ArchiveError('no end of central directory record')
}

// Each a copy, holding on to no chunk
function extras(raw, at) {
  const fields = []
  const r = reader(raw)
  for (let pos = 0; pos < raw.length;) {
    const id = r.u16(pos)
    const size = r.u16(pos + 2)
    if (pos + 4 + size > raw.length) throw new ArchiveError('an extra field runs past its room', at)
    if (id === ZIP64_EXTRA) throw new ArchiveError('zip64 is not supported', at)
    if (id === UNICODE_PATH_EXTRA) throw new ArchiveError('an entry carries a second name in a Unicode path extra field', at)
    fields.push({ id, data: raw.slice(pos + 4, pos + 4 + size) })
    pos += 4 + size
  }
  return fields
}

async function readCentral(read, at) {
  let r = await read(at, 46)
  if (r.u32(at) !== CENTRAL) throw new ArchiveError('no central directory entry where one is counted', at)
  const nameLength = r.u16(at + 28)
  const extraLength = r.u16(at + 30)
  r = await read(at, 46 + nameLength + extraLength)
  const entry = {
    at,
    madeBy: r.u16(at + 4),
    version: r.u16(at + 6),
    flags: r.u16(at + 8),
    method: r.u16(at + 10),
    time: r.u16(at + 12),
    date: r.u16(at + 14),
    crc: r.u32(at + 16),
    csize: r.u32(at + 20),
    usize: r.u32(at + 24),
    internal: r.u16(at + 36),
    attributes: r.u32(at + 38),
    offset: r.u32(at + 42),
    name: r.range(at + 46, nameLength).slice(), // a copy, holding on to no chunk
    next: at + 46 + nameLength + extraLength + r.u16(at + 32),
  }
  if (r.u16(at + 34) !== 0) throw new ArchiveError('the archive spans several disks', at)
  if (entry.flags & ENCRYPTED) throw new ArchiveError('an entry is encrypted', at)
  if (entry.method !== 0 && entry.method !== 8) throw new ArchiveError(`compression method ${entry.method} is not stored or deflate`, at)
  if (entry.csize === 0xffffffff || entry.usize === 0xffffffff || entry.offset === 0xffffffff) throw new ArchiveError('zip64 is not supported', at)
  entry.mtime = fromDos(entry.date, entry.time, at) // a valid DOS time even where the extended one is kept
  entry.extra = extras(r.range(at + 46 + nameLength, extraLength), at)
  const stamp = entry.extra.find((field) => field.id === TIMESTAMP_EXTRA)?.data
  if (stamp !== undefined && stamp[0] & 1) {
    if (stamp.length < 5) throw new ArchiveError('an extended timestamp is cut short', at)
    entry.mtime = view(stamp).getInt32(1, true)
  }
  return entry
}

// Checks the local header against the central one, flags included, as readers differ on a descriptor bit
// set in one alone. Returns where the entry ends, which must be `boundary`; `stop` bounds the read-ahead.
async function readLocal(read, entry, boundary, stop) {
  const at = entry.offset
  let r = await read(at, 30, stop)
  if (r.u32(at) !== LOCAL) throw new ArchiveError('no local header where the central directory points', at)
  const nameLength = r.u16(at + 26)
  const extraLength = r.u16(at + 28)
  r = await read(at, 30 + nameLength + extraLength, stop)
  if (!sameBytes(r.range(at + 30, nameLength), entry.name)) throw new ArchiveError('the local header names a different entry', at)
  const shared = [[4, 'version', 'a different version'], [6, 'flags', 'different flags'], [8, 'method', 'a different compression method'], [10, 'time', 'a different time'], [12, 'date', 'a different date']]
  for (const [field, key, what] of shared) {
    if (r.u16(at + field) !== entry[key]) throw new ArchiveError(`the local header has ${what}`, at)
  }
  extras(r.range(at + 30 + nameLength, extraLength), at)
  const described = entry.flags & DESCRIBED
  const agrees = (field, value) => r.u32(at + field) === value || (described && r.u32(at + field) === 0)
  if (!agrees(14, entry.crc) || !agrees(18, entry.csize) || !agrees(22, entry.usize)) throw new ArchiveError('the local header disagrees with the central directory', at)
  entry.dataAt = at + 30 + nameLength + extraLength
  let end = entry.dataAt + entry.csize
  if (described) {
    // With or without its signature, which a CRC can equal: where both fit, the one reaching `boundary`
    const d = await read(end, 16, boundary)
    const matches = (from) => d.u32(from) === entry.crc && d.u32(from + 4) === entry.csize && d.u32(from + 8) === entry.usize
    const signed = d.u32(end) === DESCRIPTOR && matches(end + 4)
    if (matches(end) && !(signed && end + 16 === boundary)) end += 12
    else if (signed) end += 16
    else throw new ArchiveError('the data descriptor disagrees with the central directory', end)
  }
  return end
}

// A directory marker needs the slash; the slash needs no marker, as Java writes no attributes
function typeOf(entry, rawName, mode) {
  const format = mode & TYPE_MASK
  if (rawName.endsWith('/')) {
    if (format !== 0 && format !== TYPE_BITS.directory) throw new ArchiveError(`${quote(rawName)} is a directory by its name but not by its mode`, entry.at)
    return 'directory'
  }
  if (format === TYPE_BITS.directory) throw new ArchiveError(`${quote(rawName)} is a directory by its mode but not by its name`, entry.at)
  if (entry.attributes & DOS_DIRECTORY) throw new ArchiveError(`${quote(rawName)} is a directory by its attributes but not by its name`, entry.at)
  if (format === TYPE_BITS.symlink) return 'symlink'
  if (format === 0 || format === TYPE_BITS.file) return 'file'
  throw new ArchiveError(`the mode of ${quote(rawName)} (${mode.toString(8)}) is not one this package reads`, entry.at)
}

async function entryOf(source, entry, names) {
  const { at, method, csize, usize } = entry
  const rawName = decodeUtf8(entry.name, 'entry name', at)
  const mode = entry.madeBy >> 8 === 3 ? entry.attributes >>> 16 : 0 // only a Unix maker's carry one
  const type = typeOf(entry, rawName, mode)
  if (type === 'directory' && usize !== 0) throw new ArchiveError(`directory ${quote(rawName)} has data`, at)
  if (method === 0 && csize !== usize) throw new ArchiveError('a stored entry has two sizes', at)
  // A Blob changed since the layout was checked can come back short
  const raw = await source.read(entry.dataAt, entry.dataAt + csize)
  if (raw.length !== csize) throw new ArchiveError('the archive is truncated', entry.dataAt)
  const body = method === 8 ? await inflate(raw, usize, at) : raw
  if (crc32(body) !== entry.crc) throw new ArchiveError('the data does not match its CRC-32', at)
  const target = type === 'symlink' ? decodeUtf8(body, 'symlink target', at) : ''
  const out = {
    ...located(() => cleanNames(rawName, type, target, names.above), at),
    type, mode: mode === 0 ? DEFAULT_MODE[type] : mode & 0o7777, mtime: entry.mtime, data: type === 'file' ? body : EMPTY, storedName: rawName,
    system: entry.madeBy >> 8, version: entry.version, flags: entry.flags, internalAttributes: entry.internal, attributes: entry.attributes, extra: entry.extra,
  }
  located(() => names.add(out), at)
  return out
}

// The layout is checked whole before the first entry is read
async function* entries(source, { limit = Infinity, symlinksAbove } = {}, keep = false) {
  if (limit !== Infinity && !(Number.isSafeInteger(limit) && limit >= 0)) throw new ArchiveError(`limit ${String(limit)} is not a whole number of bytes`)
  const names = new Names(keep, symlinksAbove)
  const { end, r } = await findEnd(source)
  const count = r.u16(end + 8)
  if (r.u16(end + 4) !== 0 || r.u16(end + 6) !== 0 || count !== r.u16(end + 10)) throw new ArchiveError('the archive spans several disks', end)
  const size = r.u32(end + 12)
  const start = r.u32(end + 16)
  if (count === 0xffff || size === 0xffffffff || start === 0xffffffff) throw new ArchiveError('zip64 is not supported', end)
  if (start + size !== end) throw new ArchiveError('the central directory does not end at the end record', end)
  // A window at a time, cut only at the archive's end, so a record counted past the directory meets the end record
  const directory = walk(source)
  const list = []
  let pos = start
  let total = 0
  for (let i = 0; i < count; i++) {
    const entry = await readCentral(directory, pos)
    total += entry.usize
    if (total > limit) throw new ArchiveError(`the entries come to more than ${limit} bytes`, pos, { limited: true })
    list.push(entry)
    pos = entry.next
  }
  if (pos !== end) throw new ArchiveError('the central directory does not hold what the end record counts', pos)
  // Each entry ends where the next starts, the last at the directory. Headers are read ahead through,
  // but not the data between: each `stop` is the next data's start, or past it while it is empty.
  const sorted = list.toSorted((a, b) => a.offset - b.offset)
  const boundaries = []
  const stops = []
  for (let i = sorted.length - 1; i >= 0; i--) {
    boundaries[i] = sorted[i + 1]?.offset ?? start
    stops[i] = sorted[i].csize === 0 && i + 1 < sorted.length ? stops[i + 1] : boundaries[i] - sorted[i].csize
  }
  const locals = walk(source)
  let expected = 0
  for (const [i, entry] of sorted.entries()) {
    if (entry.offset !== expected) throw new ArchiveError(entry.offset > expected ? 'bytes belong to no entry' : 'two entries overlap', expected)
    expected = await readLocal(locals, entry, boundaries[i], stops[i])
  }
  if (expected !== start) throw new ArchiveError('bytes belong to no entry', expected)
  for (const entry of list) yield await entryOf(source, entry, names)
}

export async function unzip(bytes, options) {
  if (!(bytes instanceof Uint8Array)) throw new ArchiveError('the archive is not a Uint8Array')
  return await Array.fromAsync(entries(sourceOf(bytes), options, true))
}

export async function* unzipStream(archive, options) {
  yield* entries(sourceOf(archive), options)
}
