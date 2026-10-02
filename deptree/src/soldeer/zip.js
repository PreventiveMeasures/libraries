// A registry zip as Soldeer 0.12 extracts it (download.rs's
// extract_dependency_archive, zip crate 8.6); what the archive reader takes
// and the two would read otherwise is refused. As a 0o022 umask leaves them,
// every directory is 0o755, and a file's mode its Unix mode as the zip crate
// reads it, or 0o644 where it reads none; a symlink is a file of its target.

import { DeptreeError, quote } from '../error.js'
import { bytesSha256Hex } from '../hash.js'
import { isUnflagged, unzipEntries } from '../zipdir.js'

const S_IFLNK = 0o120000
const [NTFS, TIMESTAMP, UNICODE_COMMENT, AES] = [0x000a, 0x5455, 0x6375, 0x9901]

const encoder = new TextEncoder()

const ones = (byte) => [...byte.toString(2)].filter((bit) => bit === '1').length

// Why the zip crate would fail on an entry's extra fields, or undefined; an
// AES or a Unicode comment field is refused here.
function extraRefusal(view, at, length) {
  for (let pos = at; pos < at + length;) {
    const id = view.getUint16(pos, true)
    const size = view.getUint16(pos + 2, true)
    const body = pos + 4
    if (id === NTFS && (size !== 32 || view.getUint16(body + 4, true) !== 1 || view.getUint16(body + 6, true) !== 24)) return 'an NTFS extra field the zip crate does not read'
    if (id === TIMESTAMP && (size === 0 || (size !== 5 && size !== 1 + 4 * ones(view.getUint8(body))))) return 'an extended timestamp the zip crate does not read'
    if (id === AES) return 'an AES extra field, which has the zip crate decrypt the entry'
    if (id === UNICODE_COMMENT) return 'a Unicode comment extra field, which the zip crate checks'
    pos = body + size
  }
  return undefined
}

// The zip crate's ZipFileData::unix_mode; system 0 is MS-DOS, and 3 Unix.
function unixMode({ system, attributes }) {
  if (attributes === 0) return undefined
  const upper = attributes >>> 16
  if (upper !== 0) return upper
  if (system === 3) return 0
  if (system !== 0) return undefined
  const mode = attributes & 0x10 ? 0o040775 : 0o100664
  return attributes & 0x01 ? mode & ~0o222 : mode
}

// What str::trim_end_matches(['.', ' ']) and eq_ignore_ascii_case make of
// a component Soldeer holds to `.git`.
const isGit = (component) => component.replace(/[. ]+$/u, '').replace(/[A-Z]/gu, (char) => char.toLowerCase()) === '.git'

// getZip has held the zip to its checksum; it is held to it again where it
// is unpacked.
export async function extractZip(bytes, checksum, where) {
  if (await bytesSha256Hex(bytes) !== checksum) throw new DeptreeError(`its zip's sha256 is not ${checksum}`, where)
  const entries = await unzipEntries(bytes, where, extraRefusal)
  // The zip crate keys entries by their names' bytes, here the stored names:
  // of two of one name, the later is extracted where the first was.
  const last = new Map()
  for (const [index, { entry, record }] of entries.entries()) {
    const here = `${where}: ${quote(entry.storedName)}`
    if (record.extra !== undefined) throw new DeptreeError(`${record.extra}, which Soldeer fails on`, here)
    if (isUnflagged(record)) throw new DeptreeError('a name not flagged UTF-8, which Soldeer reads as CP437, is not supported', here)
    last.set(entry.storedName, index)
  }
  const dirs = new Set()
  const files = new Map()
  for (const index of last.values()) {
    const { entry, record } = entries[index]
    if (entry.name === '.') continue
    const components = entry.name.split('/')
    if (components.some((component) => component.includes(':'))) throw new DeptreeError('a name with a ":" in it, which Soldeer fails on', `${where}: ${quote(entry.storedName)}`)
    if (components.some(isGit)) continue
    for (let i = 1; i < components.length; i++) dirs.add(components.slice(0, i).join('/'))
    if (entry.type === 'directory') {
      dirs.add(entry.name)
      continue
    }
    const mode = unixMode(record)
    const data = entry.type === 'symlink' ? encoder.encode(entry.linkname) : entry.data
    // A file written again keeps its mode where the zip crate reads none.
    const kept = mode === undefined || (mode & S_IFLNK) === S_IFLNK ? files.get(entry.name)?.mode ?? 0o644 : mode & 0o777 & ~0o022
    files.set(entry.name, { data, mode: kept })
  }
  return { dirs, files }
}
