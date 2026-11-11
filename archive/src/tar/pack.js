import { utf8fromString } from '@exodus/bytes/utf8.js'
import { EMPTY, concat, isAscii } from '../bytes.js'
import { DEFAULT_MODE, checkEntry, wireName } from '../entry.js'
import { ArchiveError } from '../error.js'
import { Names, cleanNames } from '../names.js'
import { checkString, hasUnsafe, quote } from '../text.js'
import { BLOCK, EXTENDED_TYPEFLAGS, NAME_SIZE, OWNER_SIZE, PREFIX_SIZE, TYPEFLAGS, encodeHeader, fitsOctal, isDevice, octalMax } from './header.js'
import { encodePax } from './pax.js'

// What GNU tar 1.35 writes with `--owner=0 --group=0 --numeric-owner` (and for pax,
// `--pax-option=delete=atime,delete=ctime`), but refusing what GNU would cut or substitute

const FORMATS = new Set(['gnu', 'ustar', 'pax'])
const SLASH = 0x2f

function integer(value, what, signed = false) {
  if (!Number.isSafeInteger(value) || (!signed && value < 0)) throw new ArchiveError(`${what} ${String(value)} is not ${signed ? 'an integer' : 'a non-negative integer'}`)
  return value
}

function ownerName(value, what) {
  checkString(value, what)
  if (hasUnsafe(value, false)) throw new ArchiveError(`${what} ${quote(value)} holds a control or formatting character`)
  return value
}

function normalize(entry, above) {
  const checked = checkEntry(entry, TYPEFLAGS)
  const { name, type, linkname } = checked
  const devmajor = integer(entry.devmajor ?? 0, 'devmajor')
  const devminor = integer(entry.devminor ?? 0, 'devminor')
  if ((devmajor !== 0 || devminor !== 0) && !isDevice(type)) throw new ArchiveError(`a ${type} cannot have device numbers (${quote(name)})`)
  const mode = integer(entry.mode ?? DEFAULT_MODE[type] ?? 0o644, 'mode')
  if (mode > 0o7777) throw new ArchiveError(`mode ${mode.toString(8)} has bits beyond the permission bits`)
  return {
    ...checked,
    mode,
    uid: integer(entry.uid ?? 0, 'uid'),
    gid: integer(entry.gid ?? 0, 'gid'),
    mtime: integer(entry.mtime ?? 0, 'mtime', true),
    uname: ownerName(entry.uname ?? '', 'uname'),
    gname: ownerName(entry.gname ?? '', 'gname'),
    devmajor,
    devminor,
    ...cleanNames(name, type, linkname, above),
  }
}

// A copy in whole blocks; `length` may reach past `raw` to count a NUL
function padded(raw, length = raw.length) {
  const out = new Uint8Array(Math.ceil(length / BLOCK) * BLOCK)
  out.set(raw)
  return out
}

// GNU's start_private_header
const privateHeader = (name, size, mtime, typeflag, gnu) => encodeHeader({
  gnu, name: utf8fromString(name).subarray(0, NAME_SIZE), prefix: EMPTY, linkname: EMPTY, uname: EMPTY, gname: EMPTY,
  typeflag, mode: 0o644, uid: 0, gid: 0, size, mtime, devmajor: null, devminor: null,
})

const longLink = (raw, typeflag) => [privateHeader('././@LongLink', raw.length + 1, 0, typeflag, true), padded(raw, raw.length + 1)]

// Named `%d/PaxHeaders/%f` after the entry, its mtime clamped into the field
function paxHeader(e, records) {
  const body = encodePax(records)
  const slash = e.name.lastIndexOf('/')
  const label = slash === -1 ? `./PaxHeaders/${e.name}` : `${e.name.slice(0, slash)}/PaxHeaders/${e.name.slice(slash + 1)}`
  return [privateHeader(label, body.length, Math.max(0, Math.min(e.mtime, octalMax(12))), EXTENDED_TYPEFLAGS.pax, false), padded(body)]
}

// GNU's split_long_name: at the last slash within 155 bytes, a trailing one aside, leaving 1 to 100 bytes of name
function splitName(raw, display) {
  const { length } = raw
  if (length > PREFIX_SIZE + NAME_SIZE + 1) throw new ArchiveError(`name ${quote(display)} is longer than 256 bytes, which ustar cannot hold`)
  const limit = length > PREFIX_SIZE + 1 ? PREFIX_SIZE + 1 : raw[length - 1] === SLASH ? length - 1 : length
  const i = raw.lastIndexOf(SLASH, limit - 1)
  const rest = length - i - 1
  if (i <= 0 || rest > NAME_SIZE || rest === 0) throw new ArchiveError(`name ${quote(display)} cannot be split into ustar's prefix and name fields`)
  return { prefix: raw.subarray(0, i), name: raw.subarray(i + 1) }
}

// Long-name blocks or a pax header, the header, the data and its padding.
// Pax records go in GNU's order: linkpath, path, uid, gid, size, mtime, devmajor, devminor, uname, gname.
function encodeEntry(e, format) {
  const gnu = format === 'gnu'
  const pax = []
  const chunks = []
  const wire = wireName(e)
  let name = utf8fromString(wire)
  let prefix = EMPTY
  let link = utf8fromString(e.linkname)
  if (link.length > NAME_SIZE) {
    if (gnu) chunks.push(...longLink(link, EXTENDED_TYPEFLAGS.longlink))
    else if (format === 'pax') pax.push(['linkpath', e.linkname])
    else throw new ArchiveError(`link target of ${quote(e.name)} is longer than 100 bytes, which ustar cannot hold`)
    link = link.subarray(0, NAME_SIZE)
  }
  if (format === 'pax' && (name.length > NAME_SIZE || !isAscii(name))) pax.push(['path', wire])
  if (name.length > NAME_SIZE) {
    if (gnu) chunks.push(...longLink(name, EXTENDED_TYPEFLAGS.longname))
    else if (format === 'ustar') ({ prefix, name } = splitName(name, e.name))
    if (name.length > NAME_SIZE) name = name.subarray(0, NAME_SIZE)
  }
  const number = (what, value, size) => {
    if (gnu || fitsOctal(value, size)) return value
    if (format !== 'pax') throw new ArchiveError(`${what} ${value} of ${quote(e.name)} does not fit the ustar format`)
    pax.push([what, String(value)])
    return 0
  }
  // GNU cuts a 32-byte owner name to 31 with no pax record; this refuses instead
  const owner = (what, text) => {
    const raw = utf8fromString(text)
    if (raw.length < OWNER_SIZE && (format !== 'pax' || isAscii(raw))) return raw
    if (format !== 'pax') throw new ArchiveError(`${what} of ${quote(e.name)} is longer than 31 bytes, which the ${format} format cannot hold`)
    pax.push([what, text])
    return raw.subarray(0, OWNER_SIZE - 1)
  }
  const device = isDevice(e.type)
  const fields = {
    gnu, name, prefix, linkname: link, typeflag: TYPEFLAGS[e.type], mode: e.mode,
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
  if (e.data.length) chunks.push(e.data)
  if (e.data.length % BLOCK) chunks.push(new Uint8Array(BLOCK - (e.data.length % BLOCK)))
  return chunks
}

function packer({ format = 'gnu', blocking = 20, symlinksAbove } = {}, keep = false) {
  if (!FORMATS.has(format)) throw new ArchiveError(`format ${quote(String(format))} is not gnu, ustar or pax`)
  if (!Number.isSafeInteger(blocking) || blocking < 1) throw new ArchiveError('blocking is not a positive integer')
  const names = new Names(keep, symlinksAbove)
  let total = 0
  return {
    add(entry) {
      const e = normalize(entry, names.above)
      names.add(e)
      const chunks = encodeEntry(e, format)
      for (const chunk of chunks) total += chunk.length
      return chunks
    },
    // Two zero blocks, then zeros to a whole record
    end() {
      const record = blocking * BLOCK
      return [new Uint8Array(Math.ceil((total + 2 * BLOCK) / record) * record - total)]
    },
  }
}

export async function* packStream(entries, options) {
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
