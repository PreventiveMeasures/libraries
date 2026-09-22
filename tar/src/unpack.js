// The bytes of an archive in, its entries out, in order. A push parser
// underneath — bytes go in as they arrive, in whatever pieces, and entries
// come out as each one completes — so reading a whole buffer and reading a
// stream are the same code, and so is the in-memory call.
//
// Strict throughout. Every header has to check out; a type this package
// does not model — sparse files, volume labels, whatever else a tar has
// added — is refused rather than skipped; a name is admitted under the
// same rules as on the way in (names.js), and duplicates and paths that
// climb out of the archive are refused there; anything but a file or a
// contiguous file carrying a size is refused, and a link without a target
// is; a pax or long-name header has to be followed by the entry it
// describes, and cannot be doubled up; an archive ends with two zero blocks
// and nothing but zeros after them, and one that stops short — or never
// ends — is an error, not a shorter archive.
//
// Extended headers are the three kinds GNU writes: pax (`x`, and `g` for
// the records that apply to every entry after it), and the two long-name
// blocks (`L` for the name, `K` for the link target). A pax record wins
// over the ustar field it stands in for; a keyword this package does not
// model is ignored, except the ones that would change what the data means.
// An entry's data is a view over the bytes it arrived in wherever it
// arrived whole, and a copy only where it had to be stitched together.

import { utf8toString } from '@exodus/bytes/utf8.js'
import { TarError } from './error.js'
import { BLOCK, EMPTY, decodeHeader, isZeroBlock } from './header.js'
import { Names, admit } from './names.js'
import { decodePax } from './pax.js'

// NUL is the pre-POSIX regular file, which GNU reads as one.
const TYPES = new Map([
  [0x30, 'file'], [0, 'file'], [0x31, 'link'], [0x32, 'symlink'], [0x33, 'character-device'],
  [0x34, 'block-device'], [0x35, 'directory'], [0x36, 'fifo'], [0x37, 'contiguous-file'],
])
const EXTENDED = new Map([[0x78, 'pax'], [0x67, 'global'], [0x4c, 'longname'], [0x4b, 'longlink']])

// A name or a set of records longer than this is not one a tar wrote.
const MAX_EXTENDED = 1 << 20

const DECIMAL = /^(?:0|[1-9][0-9]*)$/u
const TIME = /^-?[0-9]+(?:\.[0-9]+)?$/u

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

// A long-name block holds the name and a NUL, which GNU counts in the size.
function longText(raw, what, at) {
  const end = raw.indexOf(0)
  return text(end === -1 ? raw : raw.subarray(0, end), what, at)
}

function paxNumber(value, what, at) {
  if (!DECIMAL.test(value) || !Number.isSafeInteger(Number(value))) throw new TarError(`pax ${what}=${value} is not a whole number this package can hold`, at)
  return Number(value)
}

// Whole seconds; a fraction, which pax can carry and this does not model,
// is dropped toward minus infinity, as GNU tar does for a format without it.
function paxTime(value, at) {
  if (!TIME.test(value)) throw new TarError(`pax mtime=${value} is not a time`, at)
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
  // The header whose body is awaited: its size, where it was, and either
  // the kind of extended header it is or the entry it resolved to.
  #awaiting = null
  #zeros = 0
  #done = false

  // The entries completed by this chunk, in order.
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
    const entries = []
    for (let step = this.#step(); step !== undefined; step = this.#step()) {
      if (step !== null) entries.push(step)
    }
    return entries
  }

  end() {
    if (this.#done) return
    if (this.#position === 0 && this.#buffered === 0) throw new TarError('the archive is empty')
    if (this.#awaiting === null && this.#buffered === 0) throw new TarError(this.#zeros ? 'the archive ends with a lone zero block' : 'the archive has no end marker', this.#position)
    throw new TarError('the archive is truncated', this.#position)
  }

  // The next `size` bytes, or null until they have all arrived. A view when
  // one chunk holds them all, a copy otherwise.
  #take(size) {
    if (this.#buffered < size) return null
    if (size === 0) return EMPTY
    let out
    const first = this.#chunks[0]
    if (first.length - this.#offset >= size) {
      out = first.subarray(this.#offset, this.#offset + size)
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

  // One header or one body, whichever is due: the entry it completed, null
  // for progress that completed no entry, undefined when it needs bytes.
  #step() {
    if (this.#done) return undefined
    return this.#awaiting === null ? this.#header() : this.#body()
  }

  #header() {
    const block = this.#take(BLOCK)
    if (block === null) return undefined
    const at = this.#position - BLOCK
    if (isZeroBlock(block)) {
      if (this.#pending.pax !== null || this.#pending.longname !== null || this.#pending.longlink !== null) throw new TarError('an extended header is not followed by an entry', at)
      if (++this.#zeros === 2) {
        this.#done = true
        const after = this.#position
        this.#trailing(this.#take(this.#buffered), after)
      }
      return null
    }
    if (this.#zeros) throw new TarError('a lone zero block where a header should be', at)
    const header = decodeHeader(block, at)
    const extended = EXTENDED.get(header.typeflag)
    if (extended !== undefined) {
      if (header.size > MAX_EXTENDED) throw new TarError(`a ${extended} header of ${header.size} bytes is longer than any tar writes`, at)
      this.#awaiting = { extended, size: header.size, at, entry: null }
      return null
    }
    const { entry, size } = this.#resolve(header, at)
    this.#awaiting = { extended: null, size, at, entry }
    return null
  }

  #body() {
    const { extended, size, at, entry } = this.#awaiting
    const whole = Math.ceil(size / BLOCK) * BLOCK
    const body = this.#take(whole)
    if (body === null) return undefined
    for (let i = size; i < whole; i++) {
      if (body[i] !== 0) throw new TarError('the padding after an entry is not zero', at)
    }
    this.#awaiting = null
    const raw = body.subarray(0, size)
    if (extended === null) {
      entry.data = raw
      return entry
    }
    this.#extend(extended, raw, at)
    return null
  }

  #extend(kind, raw, at) {
    if (kind === 'global') {
      this.#global = decodePax(raw, at)
      return
    }
    if (this.#pending[kind] !== null) throw new TarError(`two ${kind} headers ahead of one entry`, at)
    this.#pending[kind] = kind === 'pax' ? decodePax(raw, at) : longText(raw, `a ${kind} header`, at)
  }

  #headerName(header, at) {
    const name = text(header.name, 'entry name', at)
    return header.prefix.length ? `${text(header.prefix, 'name prefix', at)}/${name}` : name
  }

  // The entry a header stands for, with everything ahead of it applied.
  #resolve(header, at) {
    const type = TYPES.get(header.typeflag)
    if (type === undefined) throw new TarError(`entry type ${quote(String.fromCodePoint(header.typeflag))} is not one this package reads`, at)
    const { pax, longname, longlink } = this.#pending
    this.#pending = { pax: null, longname: null, longlink: null }
    const record = (key) => pax?.get(key) ?? this.#global?.get(key)
    for (const records of [pax, this.#global]) {
      for (const key of records?.keys() ?? []) {
        if (key.startsWith('GNU.sparse.')) throw new TarError('sparse entries are not supported', at)
      }
    }
    if (longname !== null && record('path') !== undefined) throw new TarError('both a long name header and a pax path name one entry', at)
    if (longlink !== null && record('linkpath') !== undefined) throw new TarError('both a long link header and a pax linkpath name one entry', at)
    let name = longname ?? record('path') ?? this.#headerName(header, at)
    const linkname = longlink ?? record('linkpath') ?? text(header.linkname, 'link target', at)
    // The pre-POSIX convention, which GNU honours: a regular file whose name
    // ends in a slash is a directory.
    const kind = type === 'file' && name.endsWith('/') ? 'directory' : type
    if (kind === 'directory') {
      if (name.endsWith('/')) name = name.slice(0, -1)
    } else if (name.endsWith('/')) {
      throw new TarError(`${quote(name)} ends in a slash but is a ${kind}`, at)
    }
    const sized = record('size')
    const size = sized === undefined ? header.size : paxNumber(sized, 'size', at)
    if (size !== 0 && !isFile(kind)) throw new TarError(`a ${kind} entry has a size`, at)
    if (linkname !== '' && kind !== 'link' && kind !== 'symlink') throw new TarError(`a ${kind} entry has a link target`, at)
    const timed = record('mtime')
    const number = (key) => (record(key) === undefined ? header[key] : paxNumber(record(key), key, at))
    const owner = (key) => record(key) ?? text(header[key], key, at)
    const entry = {
      name,
      type: kind,
      mode: header.mode & 0o7777,
      uid: number('uid'),
      gid: number('gid'),
      mtime: timed === undefined ? header.mtime : paxTime(timed, at),
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
