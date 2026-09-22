// A push parser: chunks go in, entries come out as each completes, so the
// in-memory call and the streams share one reader. Extended headers are
// the kinds GNU writes: pax `x` and `g`, and the `L`/`K` long-name blocks.
// An entry's data views the chunk it arrived in where one chunk held it
// whole, and is a copy otherwise.

import { utf8toString } from '@exodus/bytes/utf8.js'
import { TarError } from './error.js'
import { BLOCK, EMPTY, decodeHeader, isZeroBlock, untilNul } from './header.js'
import { Names, admit, hasUnsafe } from './names.js'
import { decodePax } from './pax.js'

// NUL is the pre-POSIX regular file.
const TYPES = new Map([
  [0x30, 'file'], [0, 'file'], [0x31, 'link'], [0x32, 'symlink'], [0x33, 'character-device'],
  [0x34, 'block-device'], [0x35, 'directory'], [0x36, 'fifo'], [0x37, 'contiguous-file'],
])
const EXTENDED = new Map([[0x78, 'pax'], [0x67, 'global'], [0x4c, 'longname'], [0x4b, 'longlink']])
const MAX_EXTENDED = 1 << 20

const quote = (value) => JSON.stringify(value)
const isFile = (type) => type === 'file' || type === 'contiguous-file'
const isDevice = (type) => type === 'character-device' || type === 'block-device'

function text(raw, what, at) {
  try {
    return utf8toString(raw)
  } catch {
    throw new TarError(`${what} is not valid UTF-8`, at)
  }
}

function paxNumber(value, what, at) {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value) || !Number.isSafeInteger(Number(value))) throw new TarError(`pax ${what}=${value} is not a whole number this package can hold`, at)
  return Number(value)
}

// Whole seconds, a fraction floored as GNU does for a format without one.
function paxTime(value, what, at) {
  if (!/^-?[0-9]+(?:\.[0-9]+)?$/u.test(value)) throw new TarError(`pax mtime=${value} is not a time`, at)
  const seconds = Math.floor(Number(value))
  if (!Number.isSafeInteger(seconds)) throw new TarError(`pax mtime=${value} is out of range`, at)
  return seconds
}

class Unpacker {
  #chunks = []
  #offset = 0
  #buffered = 0
  #position = 0
  #names = new Names()
  #pending = { pax: null, longname: null, longlink: null }
  #global = null
  // The header whose body is due: { extended, size, at, entry }.
  #awaiting = null
  #zeros = 0
  #done = false

  push(chunk) {
    if (!(chunk instanceof Uint8Array)) throw new TarError('a chunk is not a Uint8Array')
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
    if (this.#position === 0 && this.#buffered === 0) throw new TarError('the archive is empty')
    if (this.#awaiting === null && this.#buffered === 0) throw new TarError(this.#zeros ? 'the archive ends with a lone zero block' : 'the archive has no end marker', this.#position)
    throw new TarError('the archive is truncated', this.#position)
  }

  // The next `size` bytes, or null until they have all arrived.
  #take(size) {
    if (this.#buffered < size) return null
    if (size === 0) return EMPTY
    let out
    if (this.#chunks[0].length - this.#offset >= size) {
      out = this.#chunks[0].subarray(this.#offset, this.#offset + size)
      this.#advance(size)
    } else {
      out = new Uint8Array(size)
      for (let filled = 0; filled < size;) {
        const chunk = this.#chunks[0]
        const count = Math.min(chunk.length - this.#offset, size - filled)
        out.set(chunk.subarray(this.#offset, this.#offset + count), filled)
        filled += count
        this.#advance(count)
      }
    }
    this.#buffered -= size
    this.#position += size
    return out
  }

  #advance(count) {
    this.#offset += count
    if (this.#offset === this.#chunks[0].length) {
      this.#chunks.shift()
      this.#offset = 0
    }
  }

  #trailing(bytes, at) {
    if (!isZeroBlock(bytes)) throw new TarError('data after the end of the archive', at)
  }

  // False when more bytes are needed.
  #header() {
    const block = this.#take(BLOCK)
    if (block === null) return false
    const at = this.#position - BLOCK
    if (isZeroBlock(block)) {
      if (Object.values(this.#pending).some((value) => value !== null)) throw new TarError('an extended header is not followed by an entry', at)
      if (++this.#zeros === 2) {
        this.#done = true
        const after = this.#position
        this.#trailing(this.#take(this.#buffered), after)
      }
      return true
    }
    if (this.#zeros) throw new TarError('a lone zero block where a header should be', at)
    const header = decodeHeader(block, at)
    const extended = EXTENDED.get(header.typeflag)
    if (extended === undefined) {
      this.#awaiting = { extended: null, at, ...this.#resolve(header, at) }
    } else {
      if (header.size > MAX_EXTENDED) throw new TarError(`a ${extended} header of ${header.size} bytes is longer than any tar writes`, at)
      this.#awaiting = { extended, size: header.size, at, entry: null }
    }
    return true
  }

  #body(out) {
    const { extended, size, at, entry } = this.#awaiting
    const whole = Math.ceil(size / BLOCK) * BLOCK
    const body = this.#take(whole)
    if (body === null) return false
    if (!isZeroBlock(body.subarray(size))) throw new TarError('the padding after an entry is not zero', at)
    this.#awaiting = null
    const raw = body.subarray(0, size)
    if (extended === null) {
      entry.data = raw
      out.push(entry)
    } else if (extended === 'global') {
      this.#global = decodePax(raw, at)
      for (const key of ['path', 'linkpath', 'size']) {
        if (this.#global.has(key)) throw new TarError(`a global header sets ${key}`, at)
      }
    } else {
      if (this.#pending[extended] !== null) throw new TarError(`two ${extended} headers ahead of one entry`, at)
      this.#pending[extended] = extended === 'pax' ? decodePax(raw, at) : text(untilNul(raw), `a ${extended} header`, at)
    }
    return true
  }

  // The entry a header stands for, with the extended headers ahead of it
  // applied: a pax record wins over the field it stands in for.
  #resolve(header, at) {
    const type = TYPES.get(header.typeflag)
    if (type === undefined) throw new TarError(`entry type ${quote(String.fromCodePoint(header.typeflag))} is not one this package reads`, at)
    const { pax, longname, longlink } = this.#pending
    this.#pending = { pax: null, longname: null, longlink: null }
    const record = (key) => pax?.get(key) ?? this.#global?.get(key)
    const keys = [...(pax?.keys() ?? []), ...(this.#global?.keys() ?? [])]
    if (keys.some((key) => key.startsWith('GNU.sparse.'))) throw new TarError('sparse entries are not supported', at)
    if (longname !== null && record('path') !== undefined) throw new TarError('both a long name header and a pax path name one entry', at)
    if (longlink !== null && record('linkpath') !== undefined) throw new TarError('both a long link header and a pax linkpath name one entry', at)
    let name = longname ?? record('path') ?? this.#headerName(header, at)
    const linkname = longlink ?? record('linkpath') ?? text(header.linkname, 'link target', at)
    // Pre-POSIX convention, which GNU honours: a file named with a trailing
    // slash is a directory.
    const kind = type === 'file' && name.endsWith('/') ? 'directory' : type
    if (kind === 'directory') {
      if (name.endsWith('/')) name = name.slice(0, -1)
    } else if (name.endsWith('/')) {
      throw new TarError(`${quote(name)} ends in a slash but is a ${kind}`, at)
    }
    const number = (key, parse = paxNumber) => (record(key) === undefined ? header[key] : parse(record(key), key, at))
    const size = number('size')
    if (size !== 0 && !isFile(kind)) throw new TarError(`a ${kind} entry has a size`, at)
    if (linkname !== '' && kind !== 'link' && kind !== 'symlink') throw new TarError(`a ${kind} entry has a link target`, at)
    const owner = (key) => {
      const value = record(key) ?? text(header[key], key, at)
      if (hasUnsafe(value, false)) throw new TarError(`${key} ${quote(value)} holds a control character`, at)
      return value
    }
    const entry = {
      name,
      type: kind,
      mode: header.mode & 0o7777,
      uid: number('uid'),
      gid: number('gid'),
      mtime: number('mtime', paxTime),
      uname: owner('uname'),
      gname: owner('gname'),
      linkname,
      devmajor: isDevice(kind) ? number('devmajor') : 0,
      devminor: isDevice(kind) ? number('devminor') : 0,
      data: EMPTY,
    }
    try {
      admit(this.#names, name, kind, linkname)
    } catch (error) {
      throw new TarError(error.message, at)
    }
    return { entry, size }
  }

  #headerName(header, at) {
    const name = text(header.name, 'entry name', at)
    return header.prefix.length ? `${text(header.prefix, 'name prefix', at)}/${name}` : name
  }
}

export function unpack(bytes) {
  const unpacker = new Unpacker()
  const entries = unpacker.push(bytes)
  unpacker.end()
  return entries
}

export function* unpackStream(chunks) {
  const unpacker = new Unpacker()
  for (const chunk of chunks) yield* unpacker.push(chunk)
  unpacker.end()
}

export async function* unpackStreamAsync(chunks) {
  const unpacker = new Unpacker()
  for await (const chunk of chunks) yield* unpacker.push(chunk)
  unpacker.end()
}
