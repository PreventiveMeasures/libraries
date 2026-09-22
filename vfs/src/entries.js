// A Vfs from a description of its tree, in either of two shapes: a flat map
// of paths to contents, or tar entries — the shape `Vfs.entries()` yields,
// so an archive unpacks into a Vfs and a Vfs packs into one.

import { VfsError } from './error.js'
import { dirname, normalize } from './path.js'
import { Vfs } from './vfs.js'

export function createVfs(sources = {}) {
  if (sources === null || typeof sources !== 'object' || Array.isArray(sources)) {
    throw new TypeError('sources must be an object or a Map of paths to contents; a list of entries goes to vfsFromEntries')
  }
  return vfsFromEntries(Array.from(sources instanceof Map ? sources : Object.entries(sources), sourceEntry))
}

function sourceEntry([name, value]) {
  if (typeof value === 'string' || value instanceof Uint8Array) return { name, type: 'file', data: value }
  if (value === null || typeof value !== 'object' || typeof value.type !== 'string') {
    throw new TypeError(`source ${JSON.stringify(name)} must be a string, a Uint8Array, or an object with a type`)
  }
  return { name, type: value.type, data: value.data, mode: value.mode, mtime: value.mtime, linkname: value.target }
}

// Entries are placed in order, each under the directories it needs, which
// are made when missing; a directory listed again keeps its entries and
// takes the mode and mtime listed.
export function vfsFromEntries(entries) {
  const vfs = new Vfs()
  for (const entry of entries) place(vfs, entry)
  return vfs
}

function place(vfs, { name, type = 'file', data, mode, mtime, linkname = '' }) {
  if (typeof name !== 'string') throw new TypeError(`an entry's name must be a string, not ${typeof name}`)
  const path = normalize(`/${name}`)
  vfs.mkdir(dirname(path), { recursive: true })
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
      vfs.symlink(linkname, path, { mtime })
      break
    case 'link':
      vfs.link(`/${linkname}`, path)
      break
    default:
      throw new VfsError('EINVAL', name)
  }
}
