// A Vfs from a description of its tree, in either of two shapes: a flat map
// of paths to contents, or tar entries — the shape `Vfs.entries()` yields,
// so an archive unpacks into a Vfs and a Vfs packs into one.
//
// A description is untrusted, and is read by tar's rules for a name: a
// relative path with `.` segments and a directory's trailing slash dropped,
// and no empty or `..` segment, no control, line separator or bidirectional
// character, no backslash, no drive letter in front, and at most PATH_MAX
// bytes of UTF-8 in all, as spelled and as stored with a directory's slash
// — what a tar entry may carry, so the names of a tree
// built here pack back as they are. A symlink's target is any spelling the
// Vfs takes, and tar's to judge when packing. `.` names the
// root, which only a directory may. Every spelling of one path is one name,
// and a name may repeat only as the same entry again, field for field with
// the type as declared, and byte for byte: `d/f` and `d/./f` both is what some packagers write, while
// two different entries under one name would leave the winner to
// declaration order. A link declared earlier is never followed on the way
// to a later entry, and a hard link names an entry declared before it, for
// the same reason tar defers making its links until the end; it has no mode
// or mtime of its own, so those it declares must be its target's. An entry
// carries only what its type can, data for a file and a target for a link
// of either kind: anything else given is refused rather than dropped, so a
// tree holds every field it was declared with. A flat map's key is a path,
// and may start from `/`.

import { VfsError } from './error.js'
import { dirname } from './path.js'
import { MODE, Vfs } from './vfs.js'

const PATH_MAX = 4096
const encoder = new TextEncoder()

export function createVfs(sources = {}) {
  if (sources === null || typeof sources !== 'object' || Array.isArray(sources)) {
    throw new TypeError('sources must be an object or a Map of paths to contents; a list of entries goes to vfsFromEntries')
  }
  return vfsFromEntries(Array.from(sources instanceof Map ? sources : Object.entries(sources), sourceEntry))
}

function sourceEntry([key, value]) {
  const name = typeof key === 'string' && key.startsWith('/') ? key.slice(1) || '.' : key
  if (typeof value === 'string' || value instanceof Uint8Array) return { name, type: 'file', data: value }
  if (value === null || typeof value !== 'object' || typeof value.type !== 'string') {
    throw new TypeError(`source ${JSON.stringify(name)} must be a string, a Uint8Array, or an object with a type`)
  }
  return { name, type: value.type, data: value.data, mode: value.mode, mtime: value.mtime, linkname: value.target }
}

// Entries are placed in order, each under the directories it needs, which
// are made when missing; a directory an earlier entry implied takes the mode
// and mtime a later entry declares for it. `declared` holds the type each
// name was declared with, which the tree alone cannot tell: a hard link's
// name and its target's name are one inode there.
export function vfsFromEntries(entries) {
  const vfs = new Vfs()
  const declared = new Map()
  for (const entry of entries) place(vfs, declared, entry)
  return vfs
}

function place(vfs, declared, { name, type = 'file', data, mode, mtime, linkname = '' }) {
  const path = `/${checkName(name, type === 'directory')}`
  const file = type === 'file' || type === 'contiguous-file'
  if ((!file && !noData(data)) || (linkname !== '' && type !== 'link' && type !== 'symlink')) throw new VfsError('EINVAL', name)
  const source = type === 'link' ? `/${checkName(linkname, false)}` : linkname
  if (type === 'link' && !declared.has(source)) throw new VfsError('ENOENT', linkname)
  const before = declared.get(path)
  if (before !== undefined) {
    if (before === type && same(vfs, path, type, data, mode, mtime, source)) return
    throw new VfsError('EEXIST', name)
  }
  declared.set(path, type)
  const parent = dirname(path)
  vfs.mkdir(parent, { recursive: true })
  if (vfs.realpath(parent) !== parent) throw new VfsError('ENOTDIR', name)
  switch (type) {
    case 'file':
    case 'contiguous-file':
      vfs.writeFile(path, data ?? '', { mode, mtime })
      break
    case 'directory':
      vfs.mkdir(path, { recursive: true })
      if (mode !== undefined) vfs.chmod(path, mode)
      if (mtime !== undefined) vfs.utimes(path, mtime)
      break
    case 'symlink':
      vfs.symlink(source, path, { mode, mtime })
      break
    case 'link':
      if (!fits(vfs.lstat(source), mode, mtime)) throw new VfsError('EINVAL', name)
      vfs.link(source, path)
      break
    default:
      throw new VfsError('EINVAL', name)
  }
}

// What no name may hold: a control, a line separator or a bidirectional
// control, which break or reorder a name as shown; a backslash, a separator
// on Windows; and, in front, a drive letter, which Windows resolves from.
const UNSAFE = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}\\]/u
const DRIVE = /^[a-zA-Z]:/u

// Whether `data` says nothing: left out, or empty text or bytes, as tar
// and `Vfs.entries()` give it for anything but a file.
const noData = (data) => data == null || ((typeof data === 'string' || data instanceof Uint8Array) && data.length === 0)

// A name by tar's rules, as the one spelling of its path: the root is ''.
function checkName(name, directory) {
  if (typeof name !== 'string') throw new TypeError(`a name must be a string, not ${typeof name}`)
  // Bounded as spelled before it is read, as archive bounds it too, so a
  // spelling costs no more than its length allows.
  if (encoder.encode(name).length > PATH_MAX) throw new VfsError('ENAMETOOLONG', name)
  const parts = name.split('/')
  if (directory && parts.length > 1 && parts.at(-1) === '') parts.pop()
  const kept = parts.filter((part) => part !== '.')
  const invalid = name.startsWith('/') || UNSAFE.test(name) || DRIVE.test(kept[0] ?? '')
    || kept.some((part) => part === '' || part === '..') || (!directory && kept.length === 0)
  if (invalid) throw new VfsError('EINVAL', name)
  const clean = kept.join('/')
  // Bounded as an archive stores the name: a directory's with its slash.
  if (encoder.encode(directory ? `${clean}/` : clean).length > PATH_MAX) throw new VfsError('ENAMETOOLONG', name)
  return clean
}

// Whether a hard link's declared mode and mtime, if any, are its target's.
const fits = (target, mode, mtime) => (mode ?? target.mode) === target.mode && (mtime ?? target.mtime) === target.mtime

// Whether a repeated name declares what is already there, field for field
// and byte for byte; a hard link has no mode or mtime but its target's.
function same(vfs, path, type, data, mode, mtime, source) {
  const stat = vfs.lstat(path)
  const kind = type === 'contiguous-file' ? 'file' : type
  if (kind === 'link') return stat.ino === vfs.lstat(source).ino && fits(stat, mode, mtime)
  if (stat.type !== kind || stat.mode !== (mode ?? MODE[kind]) || stat.mtime !== (mtime ?? 0)) return false
  if (kind === 'symlink') return vfs.readlink(path) === source
  if (kind === 'directory') return true
  const bytes = typeof data === 'string' ? encoder.encode(data) : data ?? new Uint8Array()
  const held = vfs.readFile(path)
  return held.length === bytes.length && held.every((byte, i) => byte === bytes[i])
}
