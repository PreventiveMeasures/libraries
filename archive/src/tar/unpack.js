import { EMPTY } from '../bytes.js'
import { isFile } from '../entry.js'
import { ArchiveError, located } from '../error.js'
import { Names, cleanNames } from '../names.js'
import { decodeUtf8, hasUnsafe, quote } from '../text.js'
import { BLOCK, EXTENDED_TYPEFLAGS, TYPEFLAGS, decodeHeader, isDevice, isZeroBlock, untilNul } from './header.js'
import { Records, decodePax } from './pax.js'

const byFlag = (flags) => Object.entries(flags).map(([name, flag]) => [flag, name])
const TYPES = new Map([...byFlag(TYPEFLAGS), [0, 'file']]) // NUL is the pre-POSIX file
const EXTENDED = new Map(byFlag(EXTENDED_TYPEFLAGS))
const MAX_EXTENDED = 1 << 20

const NO_RECORDS = new Records()
const NO_EXTENDED = Object.freeze([])
const magicOf = (header) => (header.gnu ? 'gnu' : 'ustar')
const blocks = (size) => Math.ceil(size / BLOCK) * BLOCK

// A sparse entry's body is not the file; libarchive also takes star's and Solaris' keys for one
const SPARSE_KEYS = new Set(['SCHILY.realsize', 'SUN.holesdata'])
function refuseSparse(keys, at) {
  if (keys.some((key) => key.startsWith('GNU.sparse.') || SPARSE_KEYS.has(key))) throw new ArchiveError('sparse entries are not supported', at)
}

function paxNumber(value, what, at) {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value) || !Number.isSafeInteger(Number(value))) throw new ArchiveError(`pax ${what}=${quote(value)} is not a whole number this package can hold`, at)
  return Number(value)
}

// Whole seconds, floored as GNU does. From the digits, as a double would round .9999999 up to the next second.
function paxTime(value, what, at) {
  const match = /^(-?)([0-9]+)(?:\.([0-9]+))?$/u.exec(value)
  if (!match) throw new ArchiveError(`pax ${what}=${quote(value)} is not a time`, at)
  const [, sign, whole, fraction = ''] = match
  const seconds = Number(sign + whole) - (sign && /[1-9]/u.test(fraction) ? 1 : 0)
  if (!Number.isSafeInteger(seconds)) throw new ArchiveError(`pax ${what}=${quote(value)} is out of range`, at)
  return seconds
}

function headerName(header, at) {
  const name = decodeUtf8(header.name, 'entry name', at)
  return header.prefix.length ? `${decodeUtf8(header.prefix, 'name prefix', at)}/${name}` : name
}

// Chunks in, entries out as each completes; the in-memory call and the stream share it
class Unpacker {
  #chunks = [] // unread input, from #offset in the first
  #offset = 0
  #buffered = 0
  #position = 0 // in the archive, of the first byte unread
  #names
  #pending = { pax: null, longname: null, longlink: null } // extended headers awaiting their entry
  #extended = [] // each extended header since the last entry, as entries list them
  #global = null
  #awaiting = null // the header whose body is next: { at, size, entry } or { at, size, extended }
  #zeros = 0
  #done = false
  #count = 0
  #maxEntries
  #trailingGlobal

  constructor(keep, { symlinksAbove, maxEntries = Infinity, trailingGlobal = false } = {}) {
    if (maxEntries !== Infinity && !(Number.isSafeInteger(maxEntries) && maxEntries >= 0)) throw new ArchiveError(`maxEntries ${String(maxEntries)} is not a whole number of entries`)
    if (typeof trailingGlobal !== 'boolean') throw new ArchiveError(`trailingGlobal ${String(trailingGlobal)} is not a boolean`)
    this.#names = new Names(keep, symlinksAbove)
    this.#maxEntries = maxEntries
    this.#trailingGlobal = trailingGlobal
  }

  // Each entry as it is read, so a chunk holding many holds no more of them than the one being read
  *push(chunk) {
    if (!(chunk instanceof Uint8Array)) throw new ArchiveError('a chunk is not a Uint8Array')
    if (chunk.length) {
      this.#chunks.push(chunk)
      this.#buffered += chunk.length
    }
    while (!this.#done) {
      const bytes = this.#take(this.#awaiting ? blocks(this.#awaiting.size) : BLOCK)
      if (bytes === null) return
      if (!this.#awaiting) this.#header(bytes)
      else if (this.#awaiting.entry) yield this.#entry(bytes)
      else this.#extendedHeader(bytes)
    }
    const at = this.#position
    if (!isZeroBlock(this.#take(this.#buffered))) throw new ArchiveError('data after the end of the archive', at)
  }

  end() {
    if (this.#done) return
    if (this.#position === 0 && this.#buffered === 0) throw new ArchiveError('the archive is empty')
    if (this.#awaiting === null && this.#buffered === 0) throw new ArchiveError(this.#zeros ? 'the archive ends with a lone zero block' : 'the archive has no end marker', this.#position)
    throw new ArchiveError('the archive is truncated', this.#position)
  }

  // The next `size` bytes once all have arrived: a view where one chunk holds them, else a copy
  #take(size) {
    if (this.#buffered < size) return null
    if (size === 0) return EMPTY
    let out
    if (this.#offset + size <= this.#chunks[0].length) {
      out = this.#chunks[0].subarray(this.#offset, this.#offset + size)
      this.#offset += size
    } else {
      out = new Uint8Array(size)
      let i = 0
      for (let at = 0, from = this.#offset; at < size; i++, from = 0) {
        const piece = this.#chunks[i].subarray(from, from + size - at)
        out.set(piece, at)
        at += piece.length
        this.#offset = from + piece.length
      }
      this.#chunks.splice(0, i - 1)
    }
    if (this.#offset === this.#chunks[0].length) {
      this.#chunks.shift()
      this.#offset = 0
    }
    this.#buffered -= size
    this.#position += size
    return out
  }

  #header(block) {
    const at = this.#position - BLOCK
    if (isZeroBlock(block)) {
      // A global header may trail if the caller takes it so, as GNU tar does
      if (this.#extended.some(({ kind }) => kind !== 'global' || !this.#trailingGlobal)) throw new ArchiveError('an extended header is not followed by an entry', at)
      this.#done = ++this.#zeros === 2
      return
    }
    if (this.#zeros) throw new ArchiveError('a lone zero block where a header should be', at)
    const header = decodeHeader(block, at)
    const kind = EXTENDED.get(header.typeflag)
    if (kind === undefined) {
      // Counted before anything is made of it
      if (++this.#count > this.#maxEntries) throw new ArchiveError(`the archive holds more than ${this.#maxEntries} entries`, at, { limited: true })
      this.#awaiting = { at, ...this.#resolve(header, at) }
    } else {
      if (header.size > MAX_EXTENDED) throw new ArchiveError(`a ${kind} header of ${header.size} bytes is longer than any tar writes`, at)
      this.#awaiting = { at, size: header.size, extended: Object.freeze({ kind, magic: magicOf(header), octal: header.octal }) }
    }
  }

  #body(bytes) {
    const { at, size } = this.#awaiting
    if (!isZeroBlock(bytes.subarray(size))) throw new ArchiveError('the padding after an entry is not zero', at)
    return bytes.subarray(0, size)
  }

  #entry(bytes) {
    const { at, entry } = this.#awaiting
    entry.data = this.#body(bytes)
    this.#awaiting = null
    located(() => this.#names.add(entry), at)
    return entry
  }

  #extendedHeader(bytes) {
    const { at, extended } = this.#awaiting
    const raw = this.#body(bytes)
    this.#awaiting = null
    const { kind } = extended
    if (kind === 'global') {
      this.#global = decodePax(raw, at)
      const set = ['path', 'linkpath', 'size'].find((key) => this.#global.has(key))
      if (set !== undefined) throw new ArchiveError(`a global header sets ${set}`, at)
      refuseSparse(this.#global.keys(), at) // once here, not under every entry it stands for
    } else {
      if (this.#pending[kind] !== null) throw new ArchiveError(`two ${kind} headers ahead of one entry`, at)
      this.#pending[kind] = kind === 'pax' ? decodePax(raw, at) : decodeUtf8(untilNul(raw), `a ${kind} header`, at)
    }
    this.#extended.push(extended)
  }

  // The entry a header stands for, a pax record winning over the field it stands in for
  #resolve(header, at) {
    const type = TYPES.get(header.typeflag)
    if (type === undefined) throw new ArchiveError(`entry type ${quote(String.fromCodePoint(header.typeflag))} is not one this package reads`, at)
    const { pax, longname, longlink } = this.#pending
    this.#pending = { pax: null, longname: null, longlink: null }
    const record = (key) => pax?.get(key) ?? this.#global?.get(key)
    if (pax !== null) refuseSparse(pax.keys(), at)
    if (longname !== null && record('path') !== undefined) throw new ArchiveError('both a long name header and a pax path name one entry', at)
    if (longlink !== null && record('linkpath') !== undefined) throw new ArchiveError('both a long link header and a pax linkpath name one entry', at)
    const rawName = longname ?? record('path') ?? headerName(header, at)
    const rawTarget = longlink ?? record('linkpath') ?? decodeUtf8(header.linkname, 'link target', at)
    const { name, linkname } = located(() => cleanNames(rawName, type, rawTarget, this.#names.above), at)
    const number = (key, parse = paxNumber) => {
      const value = record(key)
      return value === undefined ? header[key] : parse(value, key, at)
    }
    const size = number('size')
    if (size !== 0 && !isFile(type)) throw new ArchiveError(`a ${type} entry has a size`, at)
    if (linkname !== '' && type !== 'hardlink' && type !== 'symlink') throw new ArchiveError(`a ${type} entry has a link target`, at)
    const owner = (key) => {
      const value = record(key) ?? decodeUtf8(header[key], key, at)
      if (hasUnsafe(value, false)) throw new ArchiveError(`${key} ${quote(value)} holds a control or formatting character`, at)
      return value
    }
    const device = isDevice(type)
    const entry = {
      name,
      type,
      mode: header.mode & 0o7777,
      uid: number('uid'),
      gid: number('gid'),
      mtime: number('mtime', paxTime),
      uname: owner('uname'),
      gname: owner('gname'),
      linkname,
      devmajor: device ? number('devmajor') : 0,
      devminor: device ? number('devminor') : 0,
      data: EMPTY,
      storedName: rawName,
      storedLinkname: rawTarget,
      pax: pax ?? NO_RECORDS,
      globalPax: this.#global ?? NO_RECORDS,
      extended: this.#extended.length ? Object.freeze(this.#extended) : NO_EXTENDED,
      magic: magicOf(header),
      typeflag: String.fromCodePoint(header.typeflag),
      storedMode: header.mode,
      octal: header.octal,
    }
    this.#extended = []
    return { entry, size }
  }
}

export function unpack(bytes, options) {
  const unpacker = new Unpacker(true, options)
  const entries = [...unpacker.push(bytes)]
  unpacker.end()
  return entries
}

export async function* unpackStream(chunks, options) {
  const unpacker = new Unpacker(false, options)
  for await (const chunk of chunks) yield* unpacker.push(chunk)
  unpacker.end()
}
