// A tree as git holds one: its files and its links, each by its path. A
// directory is only what lies between them, so its entry adds nothing to the
// tree, and one with nothing under it is not there at all -- git keeps no
// empty directory either.
//
// What it is read from is entries in the shape tar has them: what
// @preventive/archive unpacks, what Vfs.entries yields, or anything else
// spelled the same. A hard link is a second name for its target, and reads
// as a copy of it; git, holding content and not inodes, sees two files.
//
// A tree that does not hold together is refused rather than guessed at: a
// name given twice, a name that is not a plain relative path, anything
// under a file or a link (which, under a link, is a tar that would write
// through it when extracted), a hard link to nothing, and the entry types git
// has nothing for.

import { CompareError } from './error.js'

const encoder = new TextEncoder()

const FILE = new Set(['file', 'contiguous-file'])
const OTHER = new Set(['fifo', 'character-device', 'block-device'])

function checkMode(mode) {
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) throw new RangeError(`a mode must be an integer from 0 to 0o7777, not ${mode}`)
  return mode
}

// A relative path, each segment named: no empty, `.` or `..` segment, and
// no slash at either end. `.` alone is the root, which only a directory names.
function checkName(name, type, tree) {
  if (typeof name !== 'string') throw new TypeError(`an entry's name must be a string, not ${typeof name}`)
  if (name === '.' && type === 'directory') return
  if (name.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new CompareError('a name must be a relative path with no empty, `.` or `..` segment', name, tree)
  }
}

function checkLinkname(linkname, name, tree) {
  if (typeof linkname !== 'string' || linkname === '') throw new CompareError('a link must name its target', name, tree)
  return linkname
}

function bytesOf(data) {
  if (data === undefined) return new Uint8Array(0)
  if (typeof data === 'string') return encoder.encode(data)
  if (data instanceof Uint8Array) return data
  throw new TypeError(`a file's data must be a string or a Uint8Array, not ${typeof data}`)
}

// One entry, as what the tree holds under its name: a file, a link, a hard
// link still to be resolved, or a directory.
function readEntry(entry, tree) {
  if (typeof entry !== 'object' || entry === null) throw new TypeError(`an entry must be an object, not ${entry === null ? 'null' : typeof entry}`)
  const { name, type = 'file', mode, linkname, data } = entry
  if (typeof type !== 'string') throw new TypeError(`an entry's type must be a string, not ${typeof type}`)
  checkName(name, type, tree)
  if (mode !== undefined) checkMode(mode)
  if (FILE.has(type)) return { path: name, type: 'file', mode: mode ?? 0o644, data: bytesOf(data) }
  if (type === 'symlink') return { path: name, type: 'symlink', target: checkLinkname(linkname, name, tree) }
  if (type === 'hardlink') return { path: name, type: 'hardlink', target: checkLinkname(linkname, name, tree) }
  if (type === 'directory') return { path: name, type: 'directory' }
  if (OTHER.has(type)) throw new CompareError(`a ${type} is neither a file nor a link`, name, tree)
  throw new TypeError(`${JSON.stringify(type)} is not an entry type`)
}

// Whether two files or links hold the same thing: the same bytes, or the same
// target. A mode is not content.
export function sameContent(a, b) {
  if (a.type !== b.type) return false
  if (a.type === 'symlink') return a.target === b.target
  if (a.data.length !== b.data.length) return false
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) return false
  return true
}

// A hard link as what it names, followed through any hard link it names in
// turn. Its name is its own; its type, mode and content its target's.
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

// The files and links of a tree by path, from its entries; `tree` names it
// in what is thrown, 'old' or 'new'.
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
