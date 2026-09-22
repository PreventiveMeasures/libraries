// A push parser: chunks go in, entries come out as each completes, so the
// in-memory call and the streams share one reader. Extended headers are
// the kinds GNU writes: pax `x` and `g`, and the `L`/`K` long-name blocks.
// An entry's data views the chunk it arrived in where one chunk held it
// whole, and is a copy otherwise.

import { EMPTY, concat } from '../bytes.js'
import { isFile } from '../entry.js'
import { ArchiveError, located } from '../error.js'
import { BLOCK, decodeHeader, isDevice, isZeroBlock, untilNul } from './header.js'
import { Names, cleanNames } from '../names.js'
import { decodePax } from './pax.js'
import { decodeUtf8, hasUnsafe, quote } from '../text.js'

// NUL is the pre-POSIX regular file.
const TYPES = new Map([
  [0x30, 'file'], [0, 'file'], [0x31, 'link'], [0x32, 'symlink'], [0x33, 'character-device'],
  [0x34, 'block-device'], [0x35, 'directory'], [0x36, 'fifo'], [0x37, 'contiguous-file'],
])
const EXTENDED = new Map([[0x78, 'pax'], [0x67, 'global'], [0x4c, 'longname'], [0x4b, 'longlink']])
const MAX_EXTENDED = 1 << 20

function paxNumber(value, what, at) {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value) || !Number.isSafeInteger(Number(value))) throw new ArchiveError(`pax ${what}=${quote(value)} is not a whole number this package can hold`, at)
  return Number(value)
}

// Whole seconds, a fraction floored as GNU does for a format without one.
function paxTime(value, what, at) {
  if (!/^-?[0-9]+(?:\.[0-9]+)?$/u.test(value)) throw new ArchiveError(`pax mtime=${quote(value)} is not a time`, at)
  const seconds = Math.floor(Number(value))
  if (!Number.isSafeInteger(seconds)) throw new ArchiveError(`pax mtime=${quote(value)} is out of range`, at)
  return seconds
}

class Unpacker {
  #chunks = []
  #offset = 0
  #buffered = 0
  #position = 0
  #names
  #pending = { pax: null, longname: null, longlink: null }
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
  // when one chunk holds them, else the chunks are joined first.
  #take(size) {
    if (this.#buffered < size) return null
    if (size === 0) return EMPTY
    if (this.#chunks.length > 1) {
      this.#chunks = [concat([this.#chunks[0].subarray(this.#offset), ...this.#chunks.slice(1)])]
      this.#offset = 0
    }
    const out = this.#chunks[0].subarray(this.#offset, this.#offset + size)
    this.#offset += size
    if (this.#offset === this.#chunks[0].length) {
      this.#chunks = []
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
    this.#pending = { pax: null, longname: null, longlink: null }
    const record = (key) => pax?.get(key) ?? this.#global?.get(key)
    const keys = [...(pax?.keys() ?? []), ...(this.#global?.keys() ?? [])]
    if (keys.some((key) => key.startsWith('GNU.sparse.'))) throw new ArchiveError('sparse entries are not supported', at)
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
    if (linkname !== '' && type !== 'link' && type !== 'symlink') throw new ArchiveError(`a ${type} entry has a link target`, at)
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
