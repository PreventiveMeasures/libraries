// A push parser: chunks go in, entries come out as each completes, so the
// in-memory call and the streams share one reader. Extended headers are
// the kinds GNU writes: pax `x` and `g`, and the `L`/`K` long-name blocks.
// An entry's data views the chunk it arrived in where one chunk held it
// whole, and is a copy otherwise.

import { EMPTY } from '../bytes.js'
import { isFile } from '../entry.js'
import { ArchiveError, located } from '../error.js'
import { BLOCK, decodeHeader, isDevice, isZeroBlock, untilNul } from './header.js'
import { Names, cleanNames } from '../names.js'
import { Records, decodePax } from './pax.js'
import { decodeUtf8, hasUnsafe, quote } from '../text.js'

// NUL is the pre-POSIX regular file.
const TYPES = new Map([
  [0x30, 'file'], [0, 'file'], [0x31, 'hardlink'], [0x32, 'symlink'], [0x33, 'character-device'],
  [0x34, 'block-device'], [0x35, 'directory'], [0x36, 'fifo'], [0x37, 'contiguous-file'],
])
const EXTENDED = new Map([[0x78, 'pax'], [0x67, 'global'], [0x4c, 'longname'], [0x4b, 'longlink']])
const MAX_EXTENDED = 1 << 20

// A sparse file is stored as a map and a body that is not the file, so
// handing back that body under the file's name and size would be a lie.
// libarchive reads one from star's real size and Solaris' map of holes as
// it does from GNU's keys, so those are refused alike.
const SPARSE_KEYS = new Set(['SCHILY.realsize', 'SUN.holesdata'])

function sparse(keys, at) {
  for (const key of keys) {
    if (key.startsWith('GNU.sparse.') || SPARSE_KEYS.has(key)) throw new ArchiveError('sparse entries are not supported', at)
  }
}

function paxNumber(value, what, at) {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value) || !Number.isSafeInteger(Number(value))) throw new ArchiveError(`pax ${what}=${quote(value)} is not a whole number this package can hold`, at)
  return Number(value)
}

// Whole seconds, a fraction floored as GNU does for a format without one.
// Read from the digits, not through a double: near today a double steps by
// a quarter of a microsecond, so .9999999 of a second would round up to the
// next one before any floor saw it. Flooring moves a negative time with any
// fraction a second earlier, and nothing else.
function paxTime(value, what, at) {
  const match = /^(-?)([0-9]+)(?:\.([0-9]+))?$/u.exec(value)
  if (!match) throw new ArchiveError(`pax ${what}=${quote(value)} is not a time`, at)
  const [, sign, whole, fraction = ''] = match
  const seconds = Number(sign + whole) - (sign && /[1-9]/u.test(fraction) ? 1 : 0)
  if (!Number.isSafeInteger(seconds)) throw new ArchiveError(`pax ${what}=${quote(value)} is out of range`, at)
  return seconds
}

// The extended headers waiting on the entry they describe: none, to start
// with and once each entry has taken them.
const nonePending = () => ({ pax: null, longname: null, longlink: null })

// The records of every entry with no pax header of its own, or under no
// global one.
const NO_RECORDS = new Records()

class Unpacker {
  #chunks = []
  #offset = 0
  #buffered = 0
  #position = 0
  #names
  #pending = nonePending()
  #global = null
  // The header whose body is due: { extended, size, at, entry }.
  #awaiting = null
  #zeros = 0
  #done = false

  // `keep` holds entries for a repeat to be compared with, which only the
  // in-memory call can afford.
  constructor(keep = false) {
    this.#names = new Names(keep)
  }

  push(chunk) {
    if (!(chunk instanceof Uint8Array)) throw new ArchiveError('a chunk is not a Uint8Array')
    if (this.#done) {
      this.#trailing(chunk, this.#position)
      this.#position += chunk.length
      return []
    }
    if (chunk.length) {
      this.#chunks.push(chunk)
      this.#buffered += chunk.length
    }
    const out = []
    let more = true
    while (more && !this.#done) more = this.#awaiting === null ? this.#header() : this.#body(out)
    return out
  }

  end() {
    if (this.#done) return
    if (this.#position === 0 && this.#buffered === 0) throw new ArchiveError('the archive is empty')
    if (this.#awaiting === null && this.#buffered === 0) throw new ArchiveError(this.#zeros ? 'the archive ends with a lone zero block' : 'the archive has no end marker', this.#position)
    throw new ArchiveError('the archive is truncated', this.#position)
  }

  // The next `size` bytes, or null until they have all arrived: a view
  // when one chunk holds them, else a copy of just that span out of the
  // chunks it crosses, however much more those chunks hold.
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
      this.#chunks = this.#chunks.slice(i - 1)
    }
    if (this.#offset === this.#chunks[0].length) {
      this.#chunks.shift()
      this.#offset = 0
    }
    this.#buffered -= size
    this.#position += size
    return out
  }

  #trailing(bytes, at) {
    if (!isZeroBlock(bytes)) throw new ArchiveError('data after the end of the archive', at)
  }

  // False when more bytes are needed.
  #header() {
    const block = this.#take(BLOCK)
    if (block === null) return false
    const at = this.#position - BLOCK
    if (isZeroBlock(block)) {
      if (Object.values(this.#pending).some((value) => value !== null)) throw new ArchiveError('an extended header is not followed by an entry', at)
      if (++this.#zeros === 2) {
        this.#done = true
        const after = this.#position
        this.#trailing(this.#take(this.#buffered), after)
      }
      return true
    }
    if (this.#zeros) throw new ArchiveError('a lone zero block where a header should be', at)
    const header = decodeHeader(block, at)
    const extended = EXTENDED.get(header.typeflag)
    if (extended === undefined) {
      this.#awaiting = { extended: null, at, ...this.#resolve(header, at) }
    } else {
      if (header.size > MAX_EXTENDED) throw new ArchiveError(`a ${extended} header of ${header.size} bytes is longer than any tar writes`, at)
      this.#awaiting = { extended, size: header.size, at, entry: null }
    }
    return true
  }

  #body(out) {
    const { extended, size, at, entry } = this.#awaiting
    const whole = Math.ceil(size / BLOCK) * BLOCK
    const body = this.#take(whole)
    if (body === null) return false
    if (!isZeroBlock(body.subarray(size))) throw new ArchiveError('the padding after an entry is not zero', at)
    this.#awaiting = null
    const raw = body.subarray(0, size)
    if (extended === null) {
      entry.data = raw
      located(() => this.#names.add(entry), at)
      out.push(entry)
    } else if (extended === 'global') {
      this.#global = decodePax(raw, at)
      for (const key of ['path', 'linkpath', 'size']) {
        if (this.#global.has(key)) throw new ArchiveError(`a global header sets ${key}`, at)
      }
      // Once, here: a global header stands until another replaces it, and
      // re-reading its keys under every entry is work an archive can ask for.
      sparse(this.#global.keys(), at)
    } else {
      if (this.#pending[extended] !== null) throw new ArchiveError(`two ${extended} headers ahead of one entry`, at)
      this.#pending[extended] = extended === 'pax' ? decodePax(raw, at) : decodeUtf8(untilNul(raw), `a ${extended} header`, at)
    }
    return true
  }

  // The entry a header stands for, with the extended headers ahead of it
  // applied: a pax record wins over the field it stands in for.
  #resolve(header, at) {
    const type = TYPES.get(header.typeflag)
    if (type === undefined) throw new ArchiveError(`entry type ${quote(String.fromCodePoint(header.typeflag))} is not one this package reads`, at)
    const { pax, longname, longlink } = this.#pending
    this.#pending = nonePending()
    const record = (key) => pax?.get(key) ?? this.#global?.get(key)
    if (pax !== null) sparse(pax.keys(), at)
    if (longname !== null && record('path') !== undefined) throw new ArchiveError('both a long name header and a pax path name one entry', at)
    if (longlink !== null && record('linkpath') !== undefined) throw new ArchiveError('both a long link header and a pax linkpath name one entry', at)
    const rawName = longname ?? record('path') ?? this.#headerName(header, at)
    const rawTarget = longlink ?? record('linkpath') ?? decodeUtf8(header.linkname, 'link target', at)
    const { name, linkname } = located(() => cleanNames(rawName, type, rawTarget), at)
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
      devmajor: isDevice(type) ? number('devmajor') : 0,
      devminor: isDevice(type) ? number('devminor') : 0,
      data: EMPTY,
      storedName: rawName,
      storedLinkname: rawTarget,
      pax: pax ?? NO_RECORDS,
      globalPax: this.#global ?? NO_RECORDS,
    }
    return { entry, size }
  }

  #headerName(header, at) {
    const name = decodeUtf8(header.name, 'entry name', at)
    return header.prefix.length ? `${decodeUtf8(header.prefix, 'name prefix', at)}/${name}` : name
  }
}

export function unpack(bytes) {
  const unpacker = new Unpacker(true)
  const entries = unpacker.push(bytes)
  unpacker.end()
  return entries
}

export async function* unpackStream(chunks) {
  const unpacker = new Unpacker()
  for await (const chunk of chunks) yield* unpacker.push(chunk)
  unpacker.end()
}
