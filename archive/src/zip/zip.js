import { crc32 } from '@exodus/bytes/crc.js'
import { utf8fromString } from '@exodus/bytes/utf8.js'
import { concat, isAscii } from '../bytes.js'
import { DEFAULT_MODE, checkEntry, wireName } from '../entry.js'
import { ArchiveError } from '../error.js'
import { Names, cleanNames } from '../names.js'
import { quote } from '../text.js'
import { CENTRAL, END, LOCAL, TYPE_BITS, deflate, record, toDos } from './format.js'

// Laid out as Info-ZIP does: a Unix maker with the mode in the external attributes, a symlink stored
// with its target as data, an extended timestamp, and each file deflated only where that is smaller

const METHODS = new Set(['deflate', 'store'])

const MADE_BY = (3 << 8) | 20 // Unix, spec 2.0
const UTF8_NAME = 0x800
const DOS_EPOCH = 315532800 // 1980-01-01T00:00:00Z
const LAST_STAMP = 0x7fffffff // the extended timestamp is signed 32-bit
// 0xffff entries or 0xffffffff bytes send a reader to zip64
const MAX_ENTRIES = 0xfffe
const MAX_SIZE = 0xfffffffe

function integer(value, what, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new ArchiveError(`${what} ${String(value)} is not an integer from ${min} to ${max}`)
  return value
}

function normalize(entry, above) {
  const checked = checkEntry(entry, TYPE_BITS)
  const { name, type, linkname } = checked
  return {
    ...checked,
    mode: integer(entry.mode ?? DEFAULT_MODE[type], 'mode', 0, 0o7777),
    mtime: integer(entry.mtime ?? DOS_EPOCH, 'mtime', DOS_EPOCH, LAST_STAMP),
    ...cleanNames(name, type, linkname, above),
  }
}

// 0x5455 with flag bit 0 and the mtime, as Info-ZIP writes it in the central directory
const timestamp = (mtime) => record([[2, 0x5455], [2, 5], [1, 1], [4, mtime]])

export async function zip(entries, { method = 'deflate', symlinksAbove } = {}) {
  if (!METHODS.has(method)) throw new ArchiveError(`method ${quote(String(method))} is not deflate or store`)
  const names = new Names(true, symlinksAbove)
  const locals = []
  const centrals = []
  let offset = 0
  let count = 0
  for (const entry of entries) {
    const e = normalize(entry, names.above)
    names.add(e)
    if (++count > MAX_ENTRIES) throw new ArchiveError(`more than ${MAX_ENTRIES} entries would need zip64`)
    const name = utf8fromString(wireName(e))
    const body = e.type === 'symlink' ? utf8fromString(e.linkname) : e.data
    // Before deflating, which may not make it smaller
    if (body.length > MAX_SIZE || offset > MAX_SIZE) throw new ArchiveError(`${quote(e.name)} would need zip64`)
    const packed = method === 'deflate' && e.type === 'file' && body.length ? await deflate(body) : body
    const stored = packed.length < body.length ? packed : body
    const compression = stored === body ? 0 : 8
    const { time, date } = toDos(e.mtime) // within DOS time, as normalize holds mtime to 1980-2038
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
