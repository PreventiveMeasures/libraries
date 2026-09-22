// Entries in, a zip archive out, laid out the way Info-ZIP lays one out: a
// Unix maker, the mode in the external attributes, a symlink as a stored
// entry whose data is its target, an extended-timestamp extra field for an
// exact UTC mtime, and each file deflated only where that made it smaller.

import { crc32 } from '@exodus/bytes/crc.js'
import { concat, isAscii } from '../bytes.js'
import { DEFAULT_MODE, checkEntry, wireName } from '../entry.js'
import { ArchiveError } from '../error.js'
import { CENTRAL, END, LOCAL, TYPE_BITS, deflate, record, toDos } from './format.js'
import { Names, cleanNames } from '../names.js'
import { encodeUtf8, quote } from '../text.js'

const METHODS = new Set(['deflate', 'store'])

const MADE_BY = (3 << 8) | 20 // Unix, spec 2.0
const UTF8_NAME = 0x800
const DOS_EPOCH = 315532800 // 1980-01-01T00:00:00Z, the earliest DOS time
const LAST_STAMP = 0x7fffffff // the extended timestamp is a signed 32-bit time
// A count of 0xffff or a size or offset of 0xffffffff sends a reader to
// zip64, so the last value short of each is the most this writes.
const MAX_ENTRIES = 0xfffe
const MAX_SIZE = 0xfffffffe

function integer(value, what, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new ArchiveError(`${what} ${String(value)} is not an integer from ${min} to ${max}`)
  return value
}

function normalize(entry) {
  const checked = checkEntry(entry, TYPE_BITS)
  return {
    ...checked,
    mode: integer(entry.mode ?? DEFAULT_MODE[checked.type], 'mode', 0, 0o7777),
    mtime: integer(entry.mtime ?? DOS_EPOCH, 'mtime', DOS_EPOCH, LAST_STAMP),
  }
}

// 0x5455: flag bit 0 and the mtime, as Info-ZIP writes in the central copy.
const timestamp = (mtime) => record([[2, 0x5455], [2, 5], [1, 1], [4, mtime]])

export async function zip(entries, { method = 'deflate' } = {}) {
  if (!METHODS.has(method)) throw new ArchiveError(`method ${quote(String(method))} is not deflate or store`)
  const names = new Names(true)
  const locals = []
  const centrals = []
  let offset = 0
  let count = 0
  for (const given of entries) {
    const entry = normalize(given)
    const e = { ...entry, ...cleanNames(entry.name, entry.type, entry.linkname) }
    names.add(e)
    if (++count > MAX_ENTRIES) throw new ArchiveError(`more than ${MAX_ENTRIES} entries would need zip64`)
    const name = encodeUtf8(wireName(e), 'entry name')
    const body = e.type === 'symlink' ? encodeUtf8(e.linkname, 'symlink target') : e.data
    let stored = body
    let compression = 0
    if (method === 'deflate' && e.type === 'file' && body.length) {
      const packed = await deflate(body)
      if (packed.length < body.length) {
        stored = packed
        compression = 8
      }
    }
    if (body.length > MAX_SIZE || offset > MAX_SIZE) throw new ArchiveError(`${quote(e.name)} would need zip64`)
    const { time, date } = toDos(e.mtime)
    const extra = timestamp(e.mtime)
    const common = [
      [2, compression === 8 ? 20 : 10], [2, isAscii(name) ? 0 : UTF8_NAME], [2, compression], [2, time], [2, date],
      [4, crc32(body)], [4, stored.length], [4, body.length], [2, name.length], [2, extra.length],
    ]
    locals.push(record([[4, LOCAL], ...common]), name, extra, stored)
    const attributes = (TYPE_BITS[e.type] | e.mode) * 0x10000 + (e.type === 'directory' ? 0x10 : 0)
    centrals.push(record([[4, CENTRAL], [2, MADE_BY], ...common, [2, 0], [2, 0], [2, 0], [4, attributes], [4, offset]]), name, extra)
    offset += 30 + name.length + extra.length + stored.length
  }
  const directory = concat(centrals)
  if (offset + directory.length > MAX_SIZE) throw new ArchiveError('the archive would need zip64')
  const end = record([[4, END], [2, 0], [2, 0], [2, count], [2, count], [4, directory.length], [4, offset], [2, 0]])
  return concat([...locals, directory, end])
}
