// A tree as git sees one: files and links by path, read from tar-shaped entries
// (archive's unpack, Vfs.entries). Directories add nothing, and a hard link is
// a copy of its target. A tree that cannot be one is refused, not guessed at.

import { utf8fromString } from '@exodus/bytes/utf8.js'
import { CompareError } from './error.js'

const FILE = new Set(['file', 'contiguous-file'])
const OTHER = new Set(['fifo', 'character-device', 'block-device'])
const BAD_SEGMENT = /(?:^|\/)\.{0,2}(?:\/|$)/u

function checkMode(mode) {
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) throw new RangeError(`a mode must be an integer from 0 to 0o7777, not ${mode}`)
}

// `.` is the root, which only a directory may name. A lone surrogate has no
// UTF-8, so no name git could hold.
function checkName(name, type, tree) {
  if (typeof name !== 'string') throw new TypeError(`an entry's name must be a string, not ${typeof name}`)
  if (name === '.' && type === 'directory') return
  if (BAD_SEGMENT.test(name)) throw new CompareError('a name must be a relative path with no empty, `.` or `..` segment', name, tree)
  if (!name.isWellFormed()) throw new CompareError('a name must be well-formed Unicode', name, tree)
}

function checkLinkname(linkname, name, tree) {
  if (typeof linkname !== 'string' || linkname === '') throw new CompareError('a link must name its target', name, tree)
  if (!linkname.isWellFormed()) throw new CompareError('a link target must be well-formed Unicode', name, tree)
  return linkname
}

function bytesOf(data) {
  if (data === undefined) return new Uint8Array(0)
  if (typeof data === 'string') return utf8fromString(data)
  if (data instanceof Uint8Array) return data
  throw new TypeError(`a file's data must be a string or a Uint8Array, not ${typeof data}`)
}

function readEntry(entry, tree) {
  if (typeof entry !== 'object' || entry === null) throw new TypeError(`an entry must be an object, not ${entry === null ? 'null' : typeof entry}`)
  const { name, type = 'file', mode, linkname, data } = entry
  checkName(name, type, tree)
  if (mode !== undefined) checkMode(mode)
  if (FILE.has(type)) return { path: name, type: 'file', mode: mode ?? 0o644, data: bytesOf(data) }
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
  if (a.data.length !== b.data.length) return false
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) return false
  return true
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

// Nothing may lie under a file or a link: under a link, a tar extracting it
// would write through the link.
export function readTree(entries, tree) {
  const held = new Map()
  for (const entry of entries) {
    const read = readEntry(entry, tree)
    if (read.path === '.') continue
    if (held.has(read.path)) throw new CompareError('a name is given twice', read.path, tree)
    held.set(read.path, read)
  }
  const files = new Map()
  for (const [path, read] of held) {
    for (let at = path.lastIndexOf('/'); at > 0; at = path.lastIndexOf('/', at - 1)) {
      const above = held.get(path.slice(0, at))
      if (above !== undefined && above.type !== 'directory') throw new CompareError(`a path lies under a ${above.type === 'symlink' ? 'link' : 'file'}`, path, tree)
    }
    if (read.type === 'hardlink') files.set(path, resolveLink(read, held, tree))
    else if (read.type !== 'directory') files.set(path, read)
  }
  return files
}
