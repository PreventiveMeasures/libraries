// A zip archive in, its entries out, in the order of the central directory,
// which is what a zip is read from. Strict throughout: the end record has to
// sit at the very end, the central directory right before it, and the
// entries have to tile everything before that from byte 0 — no bytes belong
// to nothing, no two entries share any. Each local header has to agree with
// the central directory, the data has to inflate to exactly the declared
// size and match its CRC-32, and what this package does not model — zip64,
// encryption, any method but stored and deflate, several disks — is refused.
// Given a limit, the sizes the entries declare may not add up to more than
// it; since each has to come out at exactly its own, that bounds everything
// unzip() puts out, and it is known from the central directory alone,
// before a single byte is inflated.
//
// One reader serves both calls. It asks for the archive a range at a time:
// views of it when it is in memory, and reads of just those bytes when it
// is a Blob — a File, or a file opened with fs.openAsBlob — so a stream
// over one holds no more of it than the entries' names and the entry it is
// on. Everything about the layout is checked before the first entry is
// handed over; what an entry's own data holds is checked as it is reached.

import { crc32 } from '@exodus/bytes/crc.js'
import { EMPTY, sameBytes } from '../bytes.js'
import { DEFAULT_MODE } from '../entry.js'
import { ArchiveError, located } from '../error.js'
import { CENTRAL, END, LOCAL, TYPE_BITS, TYPE_MASK, fromDos, inflate, view } from './format.js'
import { Names, cleanNames } from '../names.js'
import { decodeUtf8, quote } from '../text.js'

const DESCRIPTOR = 0x08074b50
const ZIP64_LOCATOR = 0x07064b50
const ZIP64_EXTRA = 0x0001
const TIMESTAMP_EXTRA = 0x5455
// Info-ZIP's Unicode Path field: a second, UTF-8 name that unzip takes over
// the one in the header when its CRC-32 matches that header name.
const UNICODE_PATH_EXTRA = 0x7075

const ENCRYPTED = 1
const DESCRIBED = 8 // sizes and CRC follow the data, and may be 0 in the local header
const DOS_DIRECTORY = 0x10

// Bounds-checked little-endian reads over `bytes`, which sit at `base` in
// the archive: offsets are the archive's own, and one past what was read,
// which stops short only at the archive's end, is past its end.
function reader(bytes, base = 0) {
  const data = view(bytes)
  const check = (at, width) => {
    if (at < base || at + width > base + bytes.length) throw new ArchiveError('the archive is truncated', at)
  }
  return {
    u16: (at) => (check(at, 2), data.getUint16(at - base, true)),
    u32: (at) => (check(at, 4), data.getUint32(at - base, true)),
    slice: (at, width) => (check(at, width), bytes.subarray(at - base, at - base + width)),
  }
}

// Where the archive's bytes come from, a range at a time: `read` for the
// bytes themselves, `window` for a reader over them, cut short where the
// archive ends. In memory, a range is a view and every window is the one
// reader over the whole; a Blob reads each range as it is asked for.
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

// A walk forward through records too small to be worth a read each: a
// window over [at, at + width), cut short only where the archive ends,
// and over what else the read it came from holds — up to CHUNK bytes past
// `at`, and short of `stop`, so that the records after it come in the same
// read and nothing past them is read to no purpose.
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

// The end record is the last 22 bytes plus its comment, and nothing after.
// Read with the 20 bytes ahead of the furthest back it can start, where a
// zip64 locator would sit.
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

// Extra fields, each an id, a length and that many bytes, tiling the room.
function extras(raw, at) {
  const fields = new Map()
  const r = reader(raw)
  for (let pos = 0; pos < raw.length;) {
    const id = r.u16(pos)
    const size = r.u16(pos + 2)
    if (pos + 4 + size > raw.length) throw new ArchiveError('an extra field runs past its room', at)
    if (id === ZIP64_EXTRA) throw new ArchiveError('zip64 is not supported', at)
    // Every name here is UTF-8 already, so this field can only disagree with
    // the name checked above — and unzip would extract the name it carries.
    if (id === UNICODE_PATH_EXTRA) throw new ArchiveError('an entry carries a second name in a Unicode path extra field', at)
    if (!fields.has(id)) fields.set(id, raw.subarray(pos + 4, pos + 4 + size))
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
    attributes: r.u32(at + 38),
    offset: r.u32(at + 42),
    // A copy, so that no entry holds on to the chunk it was read from.
    name: r.slice(at + 46, nameLength).slice(),
    next: at + 46 + nameLength + extraLength + r.u16(at + 32),
  }
  if (r.u16(at + 34) !== 0) throw new ArchiveError('the archive spans several disks', at)
  if (entry.flags & ENCRYPTED) throw new ArchiveError('an entry is encrypted', at)
  if (entry.method !== 0 && entry.method !== 8) throw new ArchiveError(`compression method ${entry.method} is not stored or deflate`, at)
  if (entry.csize === 0xffffffff || entry.usize === 0xffffffff || entry.offset === 0xffffffff) throw new ArchiveError('zip64 is not supported', at)
  // The DOS fields have to be a time even where the extended timestamp,
  // an exact one, is the time kept.
  entry.mtime = fromDos(entry.date, entry.time, at)
  const stamp = extras(r.slice(at + 46 + nameLength, extraLength), at).get(TIMESTAMP_EXTRA)
  if (stamp !== undefined && stamp[0] & 1) {
    if (stamp.length < 5) throw new ArchiveError('an extended timestamp is cut short', at)
    entry.mtime = view(stamp).getInt32(1, true)
  }
  return entry
}

// The local header checked against the central entry; returns where the
// entry's bytes end, which has to be `boundary`, the next record's start,
// and notes where its data starts. The two records have to agree on
// everything both carry — flags included, since a descriptor bit set in
// one and not the other is read two ways by two readers — and the local
// sizes and CRC may be 0 only where a descriptor carries them. `stop` is
// as far as the header is read ahead of itself.
async function readLocal(read, entry, boundary, stop) {
  const at = entry.offset
  let r = await read(at, 30, stop)
  if (r.u32(at) !== LOCAL) throw new ArchiveError('no local header where the central directory points', at)
  const nameLength = r.u16(at + 26)
  const extraLength = r.u16(at + 28)
  r = await read(at, 30 + nameLength + extraLength, stop)
  if (!sameBytes(r.slice(at + 30, nameLength), entry.name)) throw new ArchiveError('the local header names a different entry', at)
  const shared = [[4, 'version', 'a different version'], [6, 'flags', 'different flags'], [8, 'method', 'a different compression method'], [10, 'time', 'a different time'], [12, 'date', 'a different date']]
  for (const [field, key, what] of shared) {
    if (r.u16(at + field) !== entry[key]) throw new ArchiveError(`the local header has ${what}`, at)
  }
  extras(r.slice(at + 30 + nameLength, extraLength), at)
  const described = entry.flags & DESCRIBED
  const agrees = (field, value) => r.u32(at + field) === value || (described && r.u32(at + field) === 0)
  if (!agrees(14, entry.crc) || !agrees(18, entry.csize) || !agrees(22, entry.usize)) throw new ArchiveError('the local header disagrees with the central directory', at)
  entry.dataAt = at + 30 + nameLength + extraLength
  let end = entry.dataAt + entry.csize
  if (described) {
    // The descriptor may start with its signature or not, and a CRC can be
    // that very value, so both layouts are tried against the record; where
    // both fit (every word the signature), the one reaching the boundary is it.
    const d = await read(end, 16, boundary)
    const matches = (from) => d.u32(from) === entry.crc && d.u32(from + 4) === entry.csize && d.u32(from + 8) === entry.usize
    const signed = d.u32(end) === DESCRIPTOR && matches(end + 4)
    if (matches(end) && !(signed && end + 16 === boundary)) end += 12
    else if (signed) end += 16
    else throw new ArchiveError('the data descriptor disagrees with the central directory', end)
  }
  return end
}

// A directory marker anywhere — the Unix type bits, the DOS bit — needs
// the slash; the slash needs no marker, since Java writes no attributes at
// all and every JAR has directories.
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
  // Only a Unix maker's attributes carry a mode.
  const mode = entry.madeBy >> 8 === 3 ? entry.attributes >>> 16 : 0
  const type = typeOf(entry, rawName, mode)
  if (type === 'directory' && usize !== 0) throw new ArchiveError(`directory ${quote(rawName)} has data`, at)
  if (method === 0 && csize !== usize) throw new ArchiveError('a stored entry has two sizes', at)
  // A Blob can come back short if what is behind it changed since the
  // layout was checked; the bytes checked are the bytes read, or nothing.
  const raw = await source.read(entry.dataAt, entry.dataAt + csize)
  if (raw.length !== csize) throw new ArchiveError('the archive is truncated', entry.dataAt)
  const body = method === 8 ? await inflate(raw, usize, at) : raw
  if (crc32(body) !== entry.crc) throw new ArchiveError('the data does not match its CRC-32', at)
  const target = type === 'symlink' ? decodeUtf8(body, 'symlink target', at) : ''
  const named = located(() => cleanNames(rawName, type, target), at)
  const out = { ...named, type, mode: mode === 0 ? DEFAULT_MODE[type] : mode & 0o7777, mtime: entry.mtime, data: type === 'file' ? body : EMPTY }
  located(() => names.add(out), at)
  return out
}

// The entries one at a time, the layout all checked before the first.
// `keep` holds entries for a repeat to be compared with, which only the
// in-memory call can afford.
async function* entries(source, { limit = Infinity } = {}, keep = false) {
  if (limit !== Infinity && !(Number.isSafeInteger(limit) && limit >= 0)) throw new ArchiveError(`limit ${String(limit)} is not a whole number of bytes`)
  const { end, r } = await findEnd(source)
  const count = r.u16(end + 8)
  if (r.u16(end + 4) !== 0 || r.u16(end + 6) !== 0 || count !== r.u16(end + 10)) throw new ArchiveError('the archive spans several disks', end)
  const size = r.u32(end + 12)
  const start = r.u32(end + 16)
  if (count === 0xffff || size === 0xffffffff || start === 0xffffffff) throw new ArchiveError('zip64 is not supported', end)
  if (start + size !== end) throw new ArchiveError('the central directory does not end at the end record', end)
  // A chunk at a time, not the whole of a directory that can near 4 GiB,
  // and cut only at the archive's end, so a record counted past the
  // directory meets the end record, as it would in the archive.
  const directory = walk(source)
  const list = []
  let pos = start
  let total = 0
  for (let i = 0; i < count; i++) {
    const entry = await readCentral(directory, pos)
    total += entry.usize
    if (total > limit) throw new ArchiveError(`the entries come to more than ${limit} bytes`, pos)
    list.push(entry)
    pos = entry.next
  }
  if (pos !== end) throw new ArchiveError('the central directory does not hold what the end record counts', pos)
  let expected = 0
  const sorted = list.toSorted((a, b) => a.offset - b.offset)
  const boundaries = sorted.map((_, i) => sorted[i + 1]?.offset ?? start)
  // The headers are read ahead through, but never the data between them,
  // which is read again when its entry is reached: from each header to its
  // own data, give or take a descriptor, by the directory's sizes, or on
  // through the next header where it has none.
  const stops = []
  for (let i = sorted.length - 1; i >= 0; i--) {
    stops[i] = sorted[i].csize === 0 && i + 1 < sorted.length ? stops[i + 1] : boundaries[i] - sorted[i].csize
  }
  const locals = walk(source)
  for (const [i, entry] of sorted.entries()) {
    if (entry.offset !== expected) throw new ArchiveError(entry.offset > expected ? 'bytes belong to no entry' : 'two entries overlap', expected)
    expected = await readLocal(locals, entry, boundaries[i], stops[i])
  }
  if (expected !== start) throw new ArchiveError('bytes belong to no entry', expected)
  const names = new Names(keep)
  for (const entry of list) yield await entryOf(source, entry, names)
}

export async function unzip(bytes, options) {
  if (!(bytes instanceof Uint8Array)) throw new ArchiveError('the archive is not a Uint8Array')
  const out = await Array.fromAsync(entries(sourceOf(bytes), options, true))
  return out
}

export async function* unzipStream(archive, options) {
  yield* entries(sourceOf(archive), options)
}
