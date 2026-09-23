// A Vfs from a description of its tree, in either of two shapes: a flat map
// of paths to contents, or tar entries — the shape `Vfs.entries()` yields,
// so an archive unpacks into a Vfs and a Vfs packs into one.
//
// A description is untrusted, and is read by tar's rules for a name: a
// relative path with `.` segments and a directory's trailing slash dropped,
// and no empty or `..` segment, no control, line separator or bidirectional
// character, no backslash, no drive letter in front, and at most PATH_MAX
// bytes of UTF-8 in all, as spelled and as stored with a directory's slash
// — what a tar entry may carry, so the names of a tree built here pack back
// as they are. A symlink's target is any spelling the Vfs takes, and tar's
// to judge when packing. `.` names the root, which only a directory may.
// Every spelling of one path is one name, and a name may repeat only as the
// same entry again, field for field with the type as declared, and byte for
// byte: `d/f` and `d/./f` both is what some packagers write, while two
// different entries under one name would leave the winner to declaration
// order. A link declared earlier is never followed on the way to a later
// entry, and a hard link names an entry declared before it, for the same
// reason tar defers making its links until the end; it has no mode or mtime
// of its own, so those it declares must be its target's. An entry carries
// only what its type can, data for a file and a target for a link of either
// kind: anything else given is refused rather than dropped, so a tree holds
// every field it was declared with. A flat map's key is a path, and may
// start from `/`, as may the path a hard link in one names.

import { VfsError, wrongType } from './error.js'
import { dirname } from './path.js'
import { MODE, PATH_MAX, Vfs, checkMode, checkTime, encode, tooLong } from './vfs.js'

export function createVfs(sources = {}) {
  if (sources === null || typeof sources !== 'object' || Array.isArray(sources)) {
    throw new TypeError('sources must be an object or a Map of paths to contents; a list of entries goes to vfsFromEntries')
  }
  return vfsFromEntries(Array.from(sources instanceof Map ? sources : Object.entries(sources), sourceEntry))
}

// A flat map's path as an entry's name: `/` in front is the root's.
const unrooted = (path) => (typeof path === 'string' && path.startsWith('/') ? path.slice(1) || '.' : path)

function sourceEntry([key, value]) {
  const name = unrooted(key)
  if (typeof value === 'string' || value instanceof Uint8Array) return { name, type: 'file', data: value }
  if (value === null || typeof value !== 'object' || typeof value.type !== 'string') {
    throw new TypeError(`source ${JSON.stringify(name)} must be a string, a Uint8Array, or an object with a type`)
  }
  const linkname = value.type === 'hardlink' ? unrooted(value.target) : value.target
  return { name, type: value.type, data: value.data, mode: value.mode, mtime: value.mtime, linkname }
}

// Entries are placed in order, each under the directories it needs, which
// are made when missing; a directory an earlier entry implied takes the mode
// and mtime a later entry declares for it. `declared` holds the type each
// name was declared with, which the tree alone cannot tell: a hard link's
// name and its target's name are one inode there. A mode or mtime given is
// checked as given, whatever it is then compared with, so null is no more
// "not given" for a repeat or a hard link than for a first declaration.
export function vfsFromEntries(entries) {
  const vfs = new Vfs()
  const declared = new Map()
  for (const entry of entries) place(vfs, declared, entry)
  return vfs
}

function place(vfs, declared, { name, type = 'file', data, mode, mtime, linkname = '' }) {
  const path = `/${checkName(name, type === 'directory')}`
  const file = type === 'file' || type === 'contiguous-file'
  if ((!file && !noData(data)) || (linkname !== '' && type !== 'hardlink' && type !== 'symlink')) throw new VfsError('EINVAL', name)
  if (mode !== undefined) checkMode(mode)
  if (mtime !== undefined) checkTime(mtime)
  const source = type === 'hardlink' ? `/${checkName(linkname, false)}` : linkname
  if (type === 'hardlink' && !declared.has(source)) throw new VfsError('ENOENT', linkname)
  const before = declared.get(path)
  if (before !== undefined) {
    if (before === type && same(vfs, path, type, data, mode, mtime, source)) return
    throw new VfsError('EEXIST', name)
  }
  declared.set(path, type)
  const parent = dirname(path)
  vfs.mkdir(parent, { recursive: true })
  if (vfs.realpath(parent) !== parent) throw new VfsError('ENOTDIR', name)
  if (file) vfs.writeFile(path, data ?? '', { mode, mtime })
  else if (type === 'symlink') vfs.symlink(source, path, { mode, mtime })
  else if (type === 'directory') {
    vfs.mkdir(path, { recursive: true })
    if (mode !== undefined) vfs.chmod(path, mode)
    if (mtime !== undefined) vfs.utimes(path, mtime)
  } else if (type === 'hardlink' && fits(vfs.lstat(source), mode, mtime)) vfs.hardlink(source, path)
  else throw new VfsError('EINVAL', name)
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
  if (typeof name !== 'string') throw wrongType('a name', name)
  // Bounded as spelled before it is read, as archive bounds it too, and
  // counted rather than encoded, so a spelling costs no more than itself.
  if (tooLong(name, PATH_MAX)) throw new VfsError('ENAMETOOLONG', name)
  const parts = name.split('/')
  if (directory && parts.length > 1 && parts.at(-1) === '') parts.pop()
  const kept = parts.filter((part) => part !== '.')
  const invalid = name.startsWith('/') || UNSAFE.test(name) || DRIVE.test(kept[0] ?? '')
    || kept.some((part) => part === '' || part === '..') || (!directory && kept.length === 0)
  if (invalid) throw new VfsError('EINVAL', name)
  const clean = kept.join('/')
  // Bounded as an archive stores the name: a directory's with its slash.
  if (tooLong(clean, directory ? PATH_MAX - 1 : PATH_MAX)) throw new VfsError('ENAMETOOLONG', name)
  return clean
}

// Whether a hard link's declared mode and mtime, if any, are its target's.
const fits = (target, mode, mtime) => (mode ?? target.mode) === target.mode && (mtime ?? target.mtime) === target.mtime

// Whether a repeated name declares what is already there, field for field
// and byte for byte; a hard link has no mode or mtime but its target's. The
// name was declared with this type before, so what is there is of its kind.
// A file's data is read as writing it would, so what the first declaration
// would refuse is refused again, not taken for bytes that look the same.
function same(vfs, path, type, data, mode, mtime, source) {
  const stat = vfs.lstat(path)
  if (type === 'hardlink') return stat.ino === vfs.lstat(source).ino && fits(stat, mode, mtime)
  if (stat.mode !== (mode ?? MODE[stat.type]) || stat.mtime !== (mtime ?? 0)) return false
  if (type === 'symlink') return vfs.readlink(path) === source
  if (type === 'directory') return true
  const bytes = data instanceof Uint8Array ? data : encode(data ?? '', path)
  const held = vfs.readFile(path)
  return held.length === bytes.length && held.every((byte, i) => byte === bytes[i])
}
