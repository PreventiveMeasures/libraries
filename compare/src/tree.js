// A tree as git sees one: files and links by path, read from tar-shaped entries
// (archive's unpack, Vfs.entries), or by names taken as keys. Directories add
// nothing, and a hard link is a copy of its target.

import { utf8fromString } from '@exodus/bytes/utf8.js'
import { sameBytes } from '#same-bytes'
import { CompareError } from './error.js'

const FILE = new Set(['file', 'contiguous-file'])
const OTHER = new Set(['fifo', 'character-device', 'block-device'])
const BAD_SEGMENT = /(?:^|\/)\.{0,2}(?:\/|$)/u

function checkMode(mode) {
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) throw new RangeError(`a mode must be an integer from 0 to 0o7777, not ${mode}`)
}

// `.` is the root, which only a directory may name. A lone surrogate has no
// UTF-8, so no name git could hold. A key may be any non-empty name, `.` too.
function checkName(name, type, tree, keys) {
  if (typeof name !== 'string') throw new TypeError(`an entry's name must be a string, not ${typeof name}`)
  if (name === '.' && type === 'directory') return
  if (keys ? name === '' : BAD_SEGMENT.test(name)) throw new CompareError(keys ? 'a name must not be empty' : 'a name must be a relative path with no empty, `.` or `..` segment', name, tree)
  if (!name.isWellFormed()) throw new CompareError('a name must be well-formed Unicode', name, tree)
}

function checkLinkname(linkname, name, tree) {
  if (typeof linkname !== 'string' || linkname === '') throw new CompareError('a link must name its target', name, tree)
  if (!linkname.isWellFormed()) throw new CompareError('a link target must be well-formed Unicode', name, tree)
  return linkname
}

// Text is kept as text, to be compared as it is; it must have UTF-8 to stand for.
function dataOf(data) {
  if (data === undefined) return new Uint8Array(0)
  if (data instanceof Uint8Array) return data
  if (typeof data !== 'string') throw new TypeError(`a file's data must be a string or a Uint8Array, not ${typeof data}`)
  if (!data.isWellFormed()) throw new TypeError("a file's text must be well-formed Unicode")
  return data
}

// The bytes a file's data stands for: its text as UTF-8.
export const bytesOf = (data) => (typeof data === 'string' ? utf8fromString(data) : data)

function readEntry(entry, tree, keys) {
  if (typeof entry !== 'object' || entry === null) throw new TypeError(`an entry must be an object, not ${entry === null ? 'null' : typeof entry}`)
  const { name, type = 'file', mode, linkname, data } = entry
  checkName(name, type, tree, keys)
  if (mode !== undefined) checkMode(mode)
  if (FILE.has(type)) return { path: name, type: 'file', mode: mode ?? 0o644, data: dataOf(data) }
  if (type === 'symlink' || type === 'hardlink') return { path: name, type, target: checkLinkname(linkname, name, tree) }
  if (type === 'directory') return { path: name, type }
  if (OTHER.has(type)) throw new CompareError(`a ${type} is neither a file nor a link`, name, tree)
  throw new TypeError(`${JSON.stringify(type)} is not an entry type`)
}

// A mode is not content.
export function sameContent(a, b) {
  if (a.type !== b.type) return false
  if (a.type === 'symlink') return a.target === b.target
  if (a.data === b.data) return true
  if (typeof a.data === 'string' && typeof b.data === 'string') return false
  return sameBytes(bytesOf(a.data), bytesOf(b.data))
}

// Through any chain of hard links, to a file or a link of the tree.
function resolveLink(link, held, tree) {
  const seen = new Set([link.path])
  let target = held.get(link.target)
  while (target?.type === 'hardlink') {
    if (seen.has(target.path)) throw new CompareError('a hard link leads back to itself', link.path, tree)
    seen.add(target.path)
    target = held.get(target.target)
  }
  if (target === undefined || target.type === 'directory') throw new CompareError('a hard link must name a file or a link in the tree', link.path, tree)
  return { ...target, path: link.path }
}

// Nothing may lie under a file or a link, where a tar extracting it would
// write through the link -- unless names are keys, and no tree's paths.
export function readTree(entries, tree, keys) {
  const held = new Map()
  for (const entry of entries) {
    const read = readEntry(entry, tree, keys)
    if (read.type === 'directory' && read.path === '.') continue
    if (held.has(read.path)) throw new CompareError('a name is given twice', read.path, tree)
    held.set(read.path, read)
  }
  const files = new Map()
  for (const [path, read] of held) {
    for (let at = keys ? -1 : path.lastIndexOf('/'); at > 0; at = path.lastIndexOf('/', at - 1)) {
      const above = held.get(path.slice(0, at))
      if (above !== undefined && above.type !== 'directory') throw new CompareError(`a path lies under a ${above.type === 'symlink' ? 'link' : 'file'}`, path, tree)
    }
    if (read.type === 'hardlink') files.set(path, resolveLink(read, held, tree))
    else if (read.type !== 'directory') files.set(path, read)
  }
  return files
}
