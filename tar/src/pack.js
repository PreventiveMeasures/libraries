// Entries in, the bytes of an archive out — the same bytes GNU tar 1.35
// writes for the same entries under `--owner=0 --group=0 --numeric-owner`
// (owners are whatever an entry says, and nothing is looked up) and, for
// pax, `--pax-option=delete=atime,delete=ctime` (the two times this
// package does not model). Where GNU would write something lossy — a name
// too long for ustar, cut and not split; a number out of a field's range,
// substituted — this refuses instead, since a caller who asked for a
// format asked for an archive that says what they gave it.
//
// The three formats are GNU's own names for them. `gnu` is what plain `tar`
// writes: a name over 100 bytes goes in a ././@LongLink block ahead of the
// entry, a number too big for its field goes in base 256. `ustar` is POSIX
// 1988: a long name is split across the prefix and name fields, at the
// last slash GNU would pick, and what cannot be split or held is refused.
// `pax` is POSIX 2001: whatever the ustar header cannot hold — a long or
// non-ASCII name, a big number, an owner name over 31 bytes — goes in an
// extended header ahead of the entry, in the order GNU stores them.
//
// An archive is blocks of 512 bytes: a header, then the data padded out to
// whole blocks, then two zero blocks after the last entry, and zero bytes
// after those up to a multiple of the record size — 20 blocks unless said
// otherwise, which is tar's default and why a one-file archive is 10240
// bytes long.

import { utf8fromString } from '@exodus/bytes/utf8.js'
import { TarError } from './error.js'
import { BLOCK, EMPTY, NAME_SIZE, OWNER_SIZE, PREFIX_SIZE, ZEROS, concat, encodeHeader, fitsOctal, octalMax } from './header.js'
import { Names, admit, hasUnsafe } from './names.js'
import { encodePax } from './pax.js'

const TYPEFLAG = {
  file: 0x30,
  link: 0x31,
  symlink: 0x32,
  'character-device': 0x33,
  'block-device': 0x34,
  directory: 0x35,
  fifo: 0x36,
  'contiguous-file': 0x37,
}
const LONGNAME = 0x4c
const LONGLINK = 0x4b
const PAX = 0x78

// What stat() reports on Linux for a symlink, and what GNU tar records.
const DEFAULT_MODE = { directory: 0o755, symlink: 0o777 }
const FORMATS = new Set(['gnu', 'ustar', 'pax'])
const SLASH = 0x2f

const quote = (text) => JSON.stringify(text)
const isFile = (type) => type === 'file' || type === 'contiguous-file'
const isDevice = (type) => type === 'character-device' || type === 'block-device'
const isAscii = (raw) => raw.every((byte) => byte < 0x80)

// Strict: a lone surrogate has no UTF-8, and a name with one in it has no
// bytes an archive could carry.
function bytes(text, what) {
  try {
    return utf8fromString(text)
  } catch {
    throw new TarError(`${what} is not well-formed Unicode`)
  }
}

function integer(value, what, signed = false) {
  if (!Number.isSafeInteger(value) || (!signed && value < 0)) throw new TarError(`${what} ${String(value)} is not ${signed ? 'an integer' : 'a non-negative integer'}`)
  return value
}

function ownerName(value, what) {
  if (typeof value !== 'string') throw new TarError(`${what} is not a string`)
  if (hasUnsafe(value, false)) throw new TarError(`${what} ${quote(value)} holds a control character`)
  return value
}

// An entry as given, checked and with every field filled in. A directory's
// name may carry the slash the archive will give it; nothing else may.
function normalize(entry) {
  if (entry === null || typeof entry !== 'object') throw new TarError('an entry is not an object')
  const type = entry.type ?? 'file'
  if (!Object.hasOwn(TYPEFLAG, type)) throw new TarError(`entry type ${quote(String(type))} is not one this package writes`)
  let { name } = entry
  if (typeof name !== 'string') throw new TarError('entry name is not a string')
  if (name.endsWith('/')) {
    if (type !== 'directory') throw new TarError(`${quote(name)} ends in a slash but is a ${type}`)
    name = name.slice(0, -1)
  }
  const data = entry.data ?? EMPTY
  if (!(data instanceof Uint8Array)) throw new TarError(`data of ${quote(name)} is not a Uint8Array`)
  if (data.length !== 0 && !isFile(type)) throw new TarError(`a ${type} cannot carry data (${quote(name)})`)
  const linkname = entry.linkname ?? ''
  if (typeof linkname !== 'string') throw new TarError(`link target of ${quote(name)} is not a string`)
  if (linkname !== '' && type !== 'link' && type !== 'symlink') throw new TarError(`a ${type} cannot have a link target (${quote(name)})`)
  const devmajor = integer(entry.devmajor ?? 0, 'devmajor')
  const devminor = integer(entry.devminor ?? 0, 'devminor')
  if ((devmajor !== 0 || devminor !== 0) && !isDevice(type)) throw new TarError(`a ${type} cannot have device numbers (${quote(name)})`)
  const mode = integer(entry.mode ?? DEFAULT_MODE[type] ?? 0o644, 'mode')
  if (mode > 0o7777) throw new TarError(`mode ${mode.toString(8)} has bits beyond the permission bits`)
  return {
    name,
    type,
    data,
    linkname,
    mode,
    uid: integer(entry.uid ?? 0, 'uid'),
    gid: integer(entry.gid ?? 0, 'gid'),
    mtime: integer(entry.mtime ?? 0, 'mtime', true),
    uname: ownerName(entry.uname ?? '', 'uname'),
    gname: ownerName(entry.gname ?? '', 'gname'),
    devmajor,
    devminor,
  }
}

// A copy in whole blocks, zero to the end. `length` may reach past the
// bytes: a long name is followed by the NUL GNU counts in its size.
function padded(raw, length = raw.length) {
  const out = new Uint8Array(Math.ceil(length / BLOCK) * BLOCK)
  out.set(raw)
  return out
}

// A ././@LongLink block, as GNU writes one: 0644, owned by 0, dated 0, and
// sized for the name and the NUL after it.
function longLink(raw, typeflag) {
  const header = encodeHeader({
    gnu: true, name: utf8fromString('././@LongLink'), prefix: EMPTY, linkname: EMPTY, uname: EMPTY, gname: EMPTY,
    typeflag, mode: 0o644, uid: 0, gid: 0, size: raw.length + 1, mtime: 0, devmajor: null, devminor: null,
  })
  return [header, padded(raw, raw.length + 1)]
}

// The pax header ahead of an entry: named `%d/PaxHeaders/%f` after the
// entry (cut at 100 bytes like any name), 0644 and owned by 0, dated with
// the entry's own time clamped into the field.
function paxHeader(e, records) {
  const body = encodePax(records)
  const slash = e.name.lastIndexOf('/')
  const label = slash === -1 ? `./PaxHeaders/${e.name}` : `${e.name.slice(0, slash)}/PaxHeaders/${e.name.slice(slash + 1)}`
  const header = encodeHeader({
    gnu: false, name: utf8fromString(label).subarray(0, NAME_SIZE), prefix: EMPTY, linkname: EMPTY, uname: EMPTY, gname: EMPTY,
    typeflag: PAX, mode: 0o644, uid: 0, gid: 0, size: body.length, mtime: e.mtime < 0 ? 0 : Math.min(e.mtime, octalMax(12)), devmajor: null, devminor: null,
  })
  return [header, padded(body)]
}

// GNU's split_long_name: the prefix is everything up to the last slash that
// leaves it within 155 bytes, and what follows has to fit the name field
// and be something — a trailing slash does not count as a place to split.
function splitName(raw, display) {
  const { length } = raw
  if (length > PREFIX_SIZE + NAME_SIZE + 1) throw new TarError(`name ${quote(display)} is longer than 256 bytes, which ustar cannot hold`)
  let limit = length
  if (limit > PREFIX_SIZE + 1) limit = PREFIX_SIZE + 1
  else if (raw[limit - 1] === SLASH) limit--
  let i = limit - 1
  while (i > 0 && raw[i] !== SLASH) i--
  const rest = length - i - 1
  if (i === 0 || rest > NAME_SIZE || rest === 0) throw new TarError(`name ${quote(display)} cannot be split into ustar's prefix and name fields`)
  return { prefix: raw.subarray(0, i), name: raw.subarray(i + 1) }
}

// Where each part of an entry goes under a format: what precedes the
// header (long-name blocks or a pax header), and the fields of the header
// itself. The pax records come out in the order GNU tar stores them —
// linkpath, path, uid, gid, size, mtime, devmajor, devminor, uname, gname.
function layout(e, format) {
  const gnu = format === 'gnu'
  const pax = []
  const before = []
  const wire = e.type === 'directory' ? `${e.name}/` : e.name
  let name = bytes(wire, 'entry name')
  let prefix = EMPTY
  let link = bytes(e.linkname, `link target of ${quote(e.name)}`)
  if (link.length > NAME_SIZE) {
    if (gnu) before.push(...longLink(link, LONGLINK))
    else if (format === 'pax') pax.push(['linkpath', e.linkname])
    else throw new TarError(`link target of ${quote(e.name)} is longer than 100 bytes, which ustar cannot hold`)
    link = link.subarray(0, NAME_SIZE)
  }
  if (format === 'pax' && (name.length > NAME_SIZE || !isAscii(name))) pax.push(['path', wire])
  if (name.length > NAME_SIZE) {
    if (gnu) before.push(...longLink(name, LONGNAME))
    else if (format === 'ustar') ({ prefix, name } = splitName(name, e.name))
    if (name.length > NAME_SIZE) name = name.subarray(0, NAME_SIZE)
  }
  // A number that fits its field in octal goes there; one that does not
  // goes in base 256 under gnu, in a pax record (with 0 in the field)
  // under pax, and nowhere under ustar.
  const number = (what, value, size) => {
    if (gnu || fitsOctal(value, size)) return value
    if (format === 'pax') {
      pax.push([what, String(value)])
      return 0
    }
    throw new TarError(`${what} ${value} of ${quote(e.name)} does not fit the ustar format`)
  }
  // The field holds 31 bytes and a NUL. Under pax a name that is longer, or
  // not ASCII, also goes in a record; GNU writes the record only past 32
  // bytes and cuts a 32-byte name to 31 without one, which is the one place
  // this deliberately does not follow it.
  const owner = (what, text) => {
    const raw = bytes(text, what)
    if (raw.length < OWNER_SIZE && (format !== 'pax' || isAscii(raw))) return raw
    if (format !== 'pax') throw new TarError(`${what} of ${quote(e.name)} is longer than 31 bytes, which the ${format} format cannot hold`)
    pax.push([what, text])
    return raw.subarray(0, OWNER_SIZE - 1)
  }
  const device = isDevice(e.type)
  const fields = {
    gnu, name, prefix, linkname: link, typeflag: TYPEFLAG[e.type], mode: e.mode,
    uid: number('uid', e.uid, 8),
    gid: number('gid', e.gid, 8),
    size: number('size', e.data.length, 12),
    mtime: number('mtime', e.mtime, 12),
    devmajor: device ? number('devmajor', e.devmajor, 8) : null,
    devminor: device ? number('devminor', e.devminor, 8) : null,
    uname: owner('uname', e.uname),
    gname: owner('gname', e.gname),
  }
  if (pax.length) before.push(...paxHeader(e, pax))
  return { before, fields }
}

function settings({ format = 'gnu', blocking = 20 } = {}) {
  if (!FORMATS.has(format)) throw new TarError(`format ${quote(String(format))} is not gnu, ustar or pax`)
  if (!Number.isSafeInteger(blocking) || blocking < 1) throw new TarError('blocking is not a positive integer')
  return { format, blocking }
}

// One archive being written: entries go in one at a time, each coming out
// as the chunks that carry it — its data as the very array it was given,
// not a copy — and the end comes out last.
function packer(options) {
  const { format, blocking } = settings(options)
  const names = new Names()
  let total = 0
  const emit = function* emit(chunks) {
    for (const chunk of chunks) {
      total += chunk.length
      yield chunk
    }
  }
  return {
    * add(entry) {
      const e = normalize(entry)
      admit(names, e.name, e.type, e.linkname)
      const { before, fields } = layout(e, format)
      yield* emit(before)
      yield* emit([encodeHeader(fields)])
      if (e.data.length === 0) return
      yield* emit([e.data])
      const rest = e.data.length % BLOCK
      if (rest) yield* emit([ZEROS.subarray(0, BLOCK - rest)])
    },
    * end() {
      yield* emit([ZEROS, ZEROS])
      const record = blocking * BLOCK
      const rest = total % record
      if (rest) yield new Uint8Array(record - rest)
    },
  }
}

const iterable = (value, asynchronous) => value != null && (typeof value[Symbol.iterator] === 'function' || (asynchronous && typeof value[Symbol.asyncIterator] === 'function'))

export function* packStream(entries, options) {
  if (!iterable(entries, false)) throw new TarError('entries are not iterable')
  const p = packer(options)
  for (const entry of entries) yield* p.add(entry)
  yield* p.end()
}

export async function* packStreamAsync(entries, options) {
  if (!iterable(entries, true)) throw new TarError('entries are not iterable')
  const p = packer(options)
  for await (const entry of entries) yield* p.add(entry)
  yield* p.end()
}

export const pack = (entries, options) => concat([...packStream(entries, options)])
