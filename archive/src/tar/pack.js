// Writes what GNU tar 1.35 writes for the same entries under `--owner=0
// --group=0 --numeric-owner` and, for pax, `--pax-option=delete=atime,
// delete=ctime`. Where GNU would cut or substitute — a name too long for
// ustar, a number out of range — this refuses instead.

import { ArchiveError } from '../error.js'
import { BLOCK, EMPTY, NAME_SIZE, OWNER_SIZE, PREFIX_SIZE, concat, encodeHeader, fitsOctal, octalMax } from './header.js'
import { Names, cleanNames } from '../names.js'
import { encodePax } from './pax.js'
import { encodeUtf8, hasUnsafe, quote } from '../text.js'

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

const DEFAULT_MODE = { directory: 0o755, symlink: 0o777 }
const FORMATS = new Set(['gnu', 'ustar', 'pax'])
const SLASH = 0x2f

const isFile = (type) => type === 'file' || type === 'contiguous-file'
const isDevice = (type) => type === 'character-device' || type === 'block-device'
const isAscii = (raw) => raw.every((byte) => byte < 0x80)

function integer(value, what, signed = false) {
  if (!Number.isSafeInteger(value) || (!signed && value < 0)) throw new ArchiveError(`${what} ${String(value)} is not ${signed ? 'an integer' : 'a non-negative integer'}`)
  return value
}

function ownerName(value, what) {
  if (typeof value !== 'string') throw new ArchiveError(`${what} is not a string`)
  if (hasUnsafe(value, false)) throw new ArchiveError(`${what} ${quote(value)} holds a control character`)
  return value
}

function normalize(entry) {
  if (entry === null || typeof entry !== 'object') throw new ArchiveError('an entry is not an object')
  const type = entry.type ?? 'file'
  if (!Object.hasOwn(TYPEFLAG, type)) throw new ArchiveError(`entry type ${quote(String(type))} is not one this package writes`)
  const { name } = entry
  if (typeof name !== 'string') throw new ArchiveError('entry name is not a string')
  const data = entry.data ?? EMPTY
  if (!(data instanceof Uint8Array)) throw new ArchiveError(`data of ${quote(name)} is not a Uint8Array`)
  if (data.length !== 0 && !isFile(type)) throw new ArchiveError(`a ${type} cannot carry data (${quote(name)})`)
  const linkname = entry.linkname ?? ''
  if (typeof linkname !== 'string') throw new ArchiveError(`link target of ${quote(name)} is not a string`)
  if (linkname !== '' && type !== 'link' && type !== 'symlink') throw new ArchiveError(`a ${type} cannot have a link target (${quote(name)})`)
  const devmajor = integer(entry.devmajor ?? 0, 'devmajor')
  const devminor = integer(entry.devminor ?? 0, 'devminor')
  if ((devmajor !== 0 || devminor !== 0) && !isDevice(type)) throw new ArchiveError(`a ${type} cannot have device numbers (${quote(name)})`)
  const mode = integer(entry.mode ?? DEFAULT_MODE[type] ?? 0o644, 'mode')
  if (mode > 0o7777) throw new ArchiveError(`mode ${mode.toString(8)} has bits beyond the permission bits`)
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

// A copy in whole blocks; `length` may reach past `raw` to count a NUL.
function padded(raw, length = raw.length) {
  const out = new Uint8Array(Math.ceil(length / BLOCK) * BLOCK)
  out.set(raw)
  return out
}

// GNU's start_private_header: 0644, owned by 0, no owner names.
const privateHeader = (name, size, mtime, typeflag, gnu) => encodeHeader({
  gnu, name: encodeUtf8(name, 'header name').subarray(0, NAME_SIZE), prefix: EMPTY, linkname: EMPTY, uname: EMPTY, gname: EMPTY,
  typeflag, mode: 0o644, uid: 0, gid: 0, size, mtime, devmajor: null, devminor: null,
})

// The size counts the NUL after the name.
const longLink = (raw, typeflag) => [privateHeader('././@LongLink', raw.length + 1, 0, typeflag, true), padded(raw, raw.length + 1)]

// Named `%d/PaxHeaders/%f` after the entry, dated with the entry's mtime
// clamped into the field.
function paxHeader(e, records) {
  const body = encodePax(records)
  const slash = e.name.lastIndexOf('/')
  const label = slash === -1 ? `./PaxHeaders/${e.name}` : `${e.name.slice(0, slash)}/PaxHeaders/${e.name.slice(slash + 1)}`
  return [privateHeader(label, body.length, Math.max(0, Math.min(e.mtime, octalMax(12))), PAX, false), padded(body)]
}

// GNU's split_long_name: the last slash within 155 bytes of prefix (a
// trailing slash does not count), leaving 1 to 100 bytes of name.
function splitName(raw, display) {
  const { length } = raw
  if (length > PREFIX_SIZE + NAME_SIZE + 1) throw new ArchiveError(`name ${quote(display)} is longer than 256 bytes, which ustar cannot hold`)
  let limit = length
  if (limit > PREFIX_SIZE + 1) limit = PREFIX_SIZE + 1
  else if (raw[limit - 1] === SLASH) limit--
  let i = limit - 1
  while (i > 0 && raw[i] !== SLASH) i--
  const rest = length - i - 1
  if (i === 0 || rest > NAME_SIZE || rest === 0) throw new ArchiveError(`name ${quote(display)} cannot be split into ustar's prefix and name fields`)
  return { prefix: raw.subarray(0, i), name: raw.subarray(i + 1) }
}

// The chunks of one entry: long-name blocks or a pax header, the header,
// the data and its padding. Pax records go in the order GNU stores them:
// linkpath, path, uid, gid, size, mtime, devmajor, devminor, uname, gname.
function encodeEntry(e, format) {
  const gnu = format === 'gnu'
  const pax = []
  const chunks = []
  const wire = e.type === 'directory' ? `${e.name}/` : e.name
  let name = encodeUtf8(wire, 'entry name')
  let prefix = EMPTY
  let link = encodeUtf8(e.linkname, `link target of ${quote(e.name)}`)
  if (link.length > NAME_SIZE) {
    if (gnu) chunks.push(...longLink(link, LONGLINK))
    else if (format === 'pax') pax.push(['linkpath', e.linkname])
    else throw new ArchiveError(`link target of ${quote(e.name)} is longer than 100 bytes, which ustar cannot hold`)
    link = link.subarray(0, NAME_SIZE)
  }
  if (format === 'pax' && (name.length > NAME_SIZE || !isAscii(name))) pax.push(['path', wire])
  if (name.length > NAME_SIZE) {
    if (gnu) chunks.push(...longLink(name, LONGNAME))
    else if (format === 'ustar') ({ prefix, name } = splitName(name, e.name))
    if (name.length > NAME_SIZE) name = name.subarray(0, NAME_SIZE)
  }
  const number = (what, value, size) => {
    if (gnu || fitsOctal(value, size)) return value
    if (format === 'pax') {
      pax.push([what, String(value)])
      return 0
    }
    throw new ArchiveError(`${what} ${value} of ${quote(e.name)} does not fit the ustar format`)
  }
  // GNU writes the pax record only past 32 bytes and cuts a 32-byte name to
  // 31 without one; that loss is the one place this does not follow it.
  const owner = (what, text) => {
    const raw = encodeUtf8(text, what)
    if (raw.length < OWNER_SIZE && (format !== 'pax' || isAscii(raw))) return raw
    if (format !== 'pax') throw new ArchiveError(`${what} of ${quote(e.name)} is longer than 31 bytes, which the ${format} format cannot hold`)
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
  if (pax.length) chunks.push(...paxHeader(e, pax))
  chunks.push(encodeHeader(fields))
  const rest = e.data.length % BLOCK
  if (e.data.length) chunks.push(e.data)
  if (rest) chunks.push(new Uint8Array(BLOCK - rest))
  return chunks
}

// `keep` holds entries for a repeat to be compared with, which only the
// in-memory call can afford.
function packer({ format = 'gnu', blocking = 20 } = {}, keep = false) {
  if (!FORMATS.has(format)) throw new ArchiveError(`format ${quote(String(format))} is not gnu, ustar or pax`)
  if (!Number.isSafeInteger(blocking) || blocking < 1) throw new ArchiveError('blocking is not a positive integer')
  const names = new Names(keep)
  let total = 0
  const emit = (chunks) => {
    for (const chunk of chunks) total += chunk.length
    return chunks
  }
  return {
    add(entry) {
      const e = normalize(entry)
      const cleaned = { ...e, ...cleanNames(e.name, e.type, e.linkname) }
      names.add(cleaned)
      return emit(encodeEntry(cleaned, format))
    },
    // Two zero blocks, then zeros to a multiple of the record size.
    end() {
      const record = blocking * BLOCK
      const rest = (total + 2 * BLOCK) % record
      return [new Uint8Array(2 * BLOCK + (rest ? record - rest : 0))]
    },
  }
}

export function* packStream(entries, options) {
  const p = packer(options)
  for (const entry of entries) yield* p.add(entry)
  yield* p.end()
}

export async function* packStreamAsync(entries, options) {
  const p = packer(options)
  for await (const entry of entries) yield* p.add(entry)
  yield* p.end()
}

export function pack(entries, options) {
  const p = packer(options, true)
  const chunks = []
  for (const entry of entries) chunks.push(...p.add(entry))
  return concat([...chunks, ...p.end()])
}
