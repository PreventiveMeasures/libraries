// A registry zip as Soldeer 0.12 extracts it (download.rs's
// extract_dependency_archive, zip crate 8.6); what the archive reader takes
// and the two would read otherwise is refused. As a 0o022 umask leaves them,
// every directory is 0o755, and a file's mode its Unix mode as the zip crate
// reads it, or 0o644 where it reads none; a symlink is a file of its target.

import { utf8fromStringLoose } from '@exodus/bytes/utf8.js'
import { ArchiveError, unzip } from '@preventive/archive/zip.js'
import { DeptreeError, quote } from '../error.js'
import { bytesSha256Hex } from '../hash.js'
import { MAX_BYTES } from '../tarball.js'

const UTF8 = 0x0800
const NON_ASCII = /[^\u0020-\u007E]/u
const S_IFLNK = 0o120000
const [NTFS, TIMESTAMP, UNICODE_COMMENT, AES] = [0x000a, 0x5455, 0x6375, 0x9901]

const ones = (byte) => [...byte.toString(2)].filter((bit) => bit === '1').length

// Why the zip crate would fail on an entry's extra fields, or undefined; an
// AES or a Unicode comment field is refused here.
function extraRefusal(extra) {
  for (const { id, data } of extra) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    if (id === NTFS && (data.length !== 32 || view.getUint16(4, true) !== 1 || view.getUint16(6, true) !== 24)) return 'an NTFS extra field the zip crate does not read'
    if (id === TIMESTAMP && (data.length === 0 || (data.length !== 5 && data.length !== 1 + 4 * ones(data[0])))) return 'an extended timestamp the zip crate does not read'
    if (id === AES) return 'an AES extra field, which has the zip crate decrypt the entry'
    if (id === UNICODE_COMMENT) return 'a Unicode comment extra field, which the zip crate checks'
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
// a component Soldeer holds to `.git`; git's verify_path refuses to check
// one out, with core.protectNTFS, on by default.
export const isGit = (component) => component.replace(/[. ]+$/u, '').replace(/[A-Z]/gu, (char) => char.toLowerCase()) === '.git'

// getZip has held the zip to its checksum; it is held to it again where it
// is unpacked.
export async function extractZip(bytes, checksum, where) {
  if (await bytesSha256Hex(bytes) !== checksum) throw new DeptreeError(`its zip's sha256 is not ${checksum}`, where)
  let entries
  try {
    entries = await unzip(bytes, { limit: MAX_BYTES })
  } catch (error) {
    if (error instanceof ArchiveError) throw new DeptreeError(`its zip cannot be read: ${error.message}`, where, { cause: error })
    throw error
  }
  // The zip crate keys entries by their names' bytes, here the stored names:
  // of two of one name, the later is extracted where the first was.
  const last = new Map()
  for (const [index, entry] of entries.entries()) {
    const here = `${where}: ${quote(entry.storedName)}`
    const refusal = extraRefusal(entry.extra)
    if (refusal !== undefined) throw new DeptreeError(`${refusal}, which Soldeer fails on`, here)
    if (!(entry.flags & UTF8) && NON_ASCII.test(entry.storedName)) throw new DeptreeError('a name not flagged UTF-8, which Soldeer reads as CP437, is not supported', here)
    last.set(entry.storedName, index)
  }
  const dirs = new Set()
  const files = new Map()
  for (const index of last.values()) {
    const entry = entries[index]
    if (entry.name === '.') continue
    const components = entry.name.split('/')
    if (components.some((component) => component.includes(':'))) throw new DeptreeError('a name with a ":" in it, which Soldeer fails on', `${where}: ${quote(entry.storedName)}`)
    if (components.some(isGit)) continue
    for (let i = 1; i < components.length; i++) dirs.add(components.slice(0, i).join('/'))
    if (entry.type === 'directory') {
      dirs.add(entry.name)
      continue
    }
    const mode = unixMode(entry)
    const data = entry.type === 'symlink' ? utf8fromStringLoose(entry.linkname) : entry.data
    // A file written again keeps its mode where the zip crate reads none.
    const kept = mode === undefined || (mode & S_IFLNK) === S_IFLNK ? files.get(entry.name)?.mode ?? 0o644 : mode & 0o777 & ~0o022
    files.set(entry.name, { data, mode: kept })
  }
  return { dirs, files }
}
