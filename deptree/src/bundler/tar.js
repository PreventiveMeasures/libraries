// A tar as Gem::Package::TarReader reads it, headers alone, held to read
// alike by @preventive/archive's reader, which refuses what it refuses.

import { utf8toString } from '@exodus/bytes/utf8.js'
import { ArchiveError, unpack } from '@preventive/archive/tar.js'
import { DeptreeError, quote } from '../error.js'

const TYPES = { 0: 'file', 2: 'symlink', 5: 'directory' }

// Ruby's unpack('A'): the field less its trailing NULs and spaces.
function unpackA(block, offset, size) {
  let end = offset + size
  while (end > offset && (block[end - 1] === 0 || block[end - 1] === 0x20)) end--
  return block.subarray(offset, end)
}

const latin1 = (raw) => String.fromCodePoint(...raw)

// TarHeader.strict_oct: String#strip, then octal digits or nothing, which
// is 0; undefined where it raises.
function strictOct(block, offset, size) {
  const text = latin1(unpackA(block, offset, size)).replace(/^[\0\t\n\v\f\r ]+|[\0\t\n\v\f\r ]+$/gu, '')
  return /^[0-7]*$/u.test(text) ? (text === '' ? 0 : Number.parseInt(text, 8)) : undefined
}

// TarHeader.from's numbers, of which a uid or gid may be base 256.
const OCTAL = [['mode', 100, 8], ['size', 124, 12], ['mtime', 136, 12], ['checksum', 148, 8], ['version', 263, 2], ['devmajor', 329, 8], ['devminor', 337, 8]]
function numbers(block, here) {
  const read = {}
  for (const [key, offset, size] of OCTAL) {
    read[key] = strictOct(block, offset, size)
    if (read[key] === undefined) throw new DeptreeError(`its ${key} is no octal string, which RubyGems refuses`, here)
  }
  for (const offset of [108, 116]) {
    if ((block[offset] === 0x80 || block[offset] === 0xff) || strictOct(block, offset, 8) !== undefined) continue
    throw new DeptreeError('its uid or gid is no octal string, which RubyGems refuses', here)
  }
  return read
}

function nameOf(raw, here) {
  if (raw.includes(0)) throw new DeptreeError('a name with a NUL in it, which RubyGems refuses', here)
  try {
    return utf8toString(raw)
  } catch {
    throw new DeptreeError('a name that is not UTF-8', here)
  }
}

// TarReader::Entry#full_name: the prefix, a `/`, the name.
function fullName(block, here) {
  const [name, prefix] = [nameOf(unpackA(block, 0, 100), here), nameOf(unpackA(block, 345, 155), here)]
  if (prefix === '') return name
  if (prefix.endsWith('/') || name.startsWith('/')) throw new DeptreeError('a prefix and a name File.join joins otherwise than tar', here)
  return `${prefix}/${name}`
}

// Each entry, { name, type, mode, linkname, data }, `name` as RubyGems
// reads it; `what` is the tar, for a refusal.
export function readTar(tar, what, where, options) {
  let entries
  try {
    entries = unpack(tar, options)
  } catch (error) {
    if (error instanceof ArchiveError) throw new DeptreeError(`${what} cannot be read: ${error.message}`, where, { cause: error })
    throw error
  }
  let offset = 0
  return entries.map((entry) => {
    const here = `${where}: ${quote(entry.storedName)}`
    if (entry.extended.length > 0) throw new DeptreeError('an extended header, which RubyGems reads as an entry of its own', here)
    const block = tar.subarray(offset, offset + 512)
    const { mode, size } = numbers(block, here)
    const typeflag = latin1(unpackA(block, 156, 1)) || '0'
    const type = TYPES[typeflag]
    if (type === undefined) throw new DeptreeError(`a ${entry.type}, which RubyGems makes nothing of but its directory`, here)
    const name = fullName(block, here)
    const linkname = nameOf(unpackA(block, 157, 100), here)
    if (name !== entry.storedName || type !== entry.type || mode !== entry.storedMode || size !== entry.data.length || linkname !== entry.storedLinkname) {
      throw new DeptreeError('a header RubyGems reads otherwise than tar', here)
    }
    offset += 512 + Math.ceil(size / 512) * 512
    return { name, type, mode, linkname, data: entry.data }
  })
}
