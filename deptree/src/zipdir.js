// A zip's entries as the archive reader reads them, each beside what its
// central directory records of it that the reader does not hand out: the
// system that made it, its flags, its external attributes and its name's
// bytes; and of its extra fields what `extra` reads, given a view, where
// they start and their length.

import { ArchiveError, unzip } from '@preventive/archive/zip.js'
import { DeptreeError } from './error.js'
import { MAX_BYTES } from './tarball.js'

const END = 0x06054b50
const CENTRAL = 0x02014b50
const UTF8 = 0x0800
const UNIX = 3
const [S_IFMT, S_IFREG, S_IFLNK] = [0o170000, 0o100000, 0o120000]

// As the archive reader decodes a name: a leading U+FEFF is part of it.
const decoder = new TextDecoder('utf-8', { ignoreBOM: true })

// Once the reader has checked the layout whole, each record is where it
// says; before, a layout it would refuse may throw here.
function centralRecords(bytes, extra) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let end = bytes.length - 22
  while (view.getUint32(end, true) !== END || end + 22 + view.getUint16(end + 20, true) !== bytes.length) end--
  const records = []
  let at = view.getUint32(end + 16, true)
  for (let i = 0; i < view.getUint16(end + 10, true); i++) {
    if (view.getUint32(at, true) !== CENTRAL) throw new Error('unreachable: a central record where unzip found none')
    const [nameLength, extraLength, commentLength] = [at + 28, at + 30, at + 32].map((field) => view.getUint16(field, true))
    records.push({
      at,
      size: view.getUint32(at + 24, true),
      system: view.getUint8(at + 5),
      flags: view.getUint16(at + 8, true),
      attributes: view.getUint32(at + 38, true),
      name: bytes.subarray(at + 46, at + 46 + nameLength),
      extra: extra(view, at + 46 + nameLength, extraLength),
    })
    at += 46 + nameLength + extraLength + commentLength
  }
  return records
}

// Each entry as { entry, record }, in the central directory's order; what
// the reader refuses, refused.
export async function unzipEntries(bytes, where, extra = () => undefined) {
  let entries
  try {
    entries = await unzip(bytes, { limit: MAX_BYTES })
  } catch (error) {
    if (error instanceof ArchiveError) throw new DeptreeError(`its zip cannot be read: ${error.message}`, where, { cause: error })
    throw error
  }
  const records = centralRecords(bytes, extra)
  return entries.map((entry, index) => {
    if (decoder.decode(records[index].name) !== entry.storedName) throw new Error('unreachable: unzip lists entries out of the central directory\'s order')
    return { entry, record: records[index] }
  })
}

// unzip writes a link made on Unix with no target, which no link can have,
// as an empty file of the link's permissions, where the reader refuses
// it. A copy of the zip with each such entry a file by its mode; or the zip
// itself where there is none, or where it is not one the reader reads.
export function emptyLinksAsFiles(bytes) {
  let records
  try {
    records = centralRecords(bytes, () => undefined)
  } catch {
    return bytes
  }
  const empty = records.filter(({ system, attributes, size }) => system === UNIX && ((attributes >>> 16) & S_IFMT) === S_IFLNK && size === 0)
  if (empty.length === 0) return bytes
  const copy = new Uint8Array(bytes)
  const view = new DataView(copy.buffer)
  for (const { at, attributes } of empty) view.setUint32(at + 38, ((((attributes >>> 16) & ~S_IFMT) | S_IFREG) * 0x10000) + (attributes & 0xffff), true)
  return copy
}

// A name with a byte past ASCII, not flagged UTF-8, which each extractor
// reads its own way.
export const isUnflagged = ({ flags, name }) => !(flags & UTF8) && name.some((byte) => byte >= 0x80)
