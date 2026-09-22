// An in-memory filesystem: a tree of inodes under one root — files holding
// bytes, directories holding named entries, symbolic links holding a target
// — reached by POSIX's rules. A path is resolved from the root, component by
// component: a link on the way is replaced by its target as read from the
// directory the link sits in, `..` steps up the real path, and forty links
// in one resolution is a loop. A relative path is resolved from `/`; a caller
// with a working directory joins it on first (see path.js). Nothing here
// reads a clock: `mtime` is what a caller set, in whole seconds, and 0 until
// then. A file's bytes are returned as they are stored, never copied, and
// stored as a copy of what was written: hold them, do not write into them.

import { VfsError } from './error.js'
import { compareNames, join } from './path.js'

const LINK_LIMIT = 40
const NONE = new Uint8Array()
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export class Vfs {
  #root
  #inodes = 0

  constructor() {
    this.#root = this.#directory()
  }

  #file(bytes, mode = 0o644, mtime = 0) { return { ino: ++this.#inodes, type: 'file', mode, mtime, bytes } }
  #directory(mode = 0o755, mtime = 0) { return { ino: ++this.#inodes, type: 'directory', mode, mtime, entries: new Map() } }
  #symlink(target, mtime = 0) { return { ino: ++this.#inodes, type: 'symlink', mode: 0o777, mtime, target } }

  // Where `path` leads: `dir`, the directory its last name is in; `name`; and
  // `node`, the inode there — undefined when the name is not taken, so a
  // creation knows where to go. The last link is followed unless `follow` is
  // false, as lstat does not; a trailing slash asserts a directory. `chain`
  // is every directory from the root down to `dir`, `path` the canonical
  // spelling of the result, and `mkdirs` makes the directories missing on
  // the way, as mkdir -p does.
  #locate(path, { follow = true, mkdirs = false } = {}) {
    if (typeof path !== 'string') throw new TypeError(`a path must be a string, not ${typeof path}`)
    if (path.includes('\0')) throw new VfsError('EINVAL', path)
    if (path === '') throw new VfsError('ENOENT', path)
    const trailing = path.endsWith('/')
    const rest = path.split('/').filter(Boolean).toReversed()
    const chain = [{ name: '', node: this.#root }]
    let budget = LINK_LIMIT
    while (rest.length > 0) {
      const name = rest.pop()
      if (name === '.') continue
      if (name === '..') { if (chain.length > 1) chain.pop(); continue }
      const here = chain.at(-1).node
      const last = rest.length === 0
      let node = here.entries.get(name)
      if (node === undefined) {
        if (last) return { dir: here, name, node, trailing, chain, path: pathOf(chain, name) }
        if (!mkdirs) throw new VfsError('ENOENT', path)
        node = this.#directory()
        here.entries.set(name, node)
      }
      if (node.type === 'symlink' && (!last || follow)) {
        if (budget-- === 0) throw new VfsError('ELOOP', path)
        if (node.target.startsWith('/')) chain.length = 1
        const parts = node.target.split('/').filter(Boolean)
        if (node.target.endsWith('/')) parts.push('.')
        for (let i = parts.length - 1; i >= 0; i--) rest.push(parts[i])
        continue
      }
      if (last) {
        if (trailing && node.type !== 'directory') throw new VfsError('ENOTDIR', path)
        return { dir: here, name, node, trailing, chain, path: pathOf(chain, name) }
      }
      if (node.type !== 'directory') throw new VfsError('ENOTDIR', path)
      chain.push({ name, node })
    }
    // `/` itself, or a spelling that ended on `.`, `..` or a link to a directory.
    const top = chain.pop()
    return { dir: chain.at(-1)?.node, name: top.name, node: top.node, trailing, chain, path: pathOf(chain, top.name) }
  }

  #node(path, follow) {
    const { node } = this.#locate(path, { follow })
    if (node === undefined) throw new VfsError('ENOENT', path)
    return node
  }

  #is(path, type, follow) {
    try { return this.#node(path, follow).type === type } catch (error) {
      if (error instanceof VfsError) return false
      throw error
    }
  }

  stat(path) { return statOf(this.#node(path, true)) }
  // The name itself, unless a trailing slash asks for the directory behind it.
  lstat(path) { return statOf(this.#node(path, path.endsWith('/'))) }
  isFile(path) { return this.#is(path, 'file', true) }
  isDirectory(path) { return this.#is(path, 'directory', true) }
  isSymlink(path) { return this.#is(path, 'symlink', false) }

  realpath(path) {
    const found = this.#locate(path)
    if (found.node === undefined) throw new VfsError('ENOENT', path)
    return found.path
  }

  readFile(path) {
    const node = this.#node(path, true)
    if (node.type === 'directory') throw new VfsError('EISDIR', path)
    return node.bytes
  }

  readText(path) {
    try { return decoder.decode(this.readFile(path)) } catch (error) {
      if (error instanceof TypeError) throw new VfsError('EILSEQ', path)
      throw error
    }
  }

  readlink(path) {
    const node = this.#node(path, false)
    if (node.type !== 'symlink') throw new VfsError('EINVAL', path)
    return node.target
  }

  readdir(path) {
    const node = this.#node(path, true)
    if (node.type !== 'directory') throw new VfsError('ENOTDIR', path)
    return [...node.entries.keys()].sort(compareNames)
  }

  // Creates the file or truncates it; through a link, the file the link names.
  writeFile(path, data, { mode, mtime } = {}) {
    const bytes = encode(data, path)
    const found = this.#locate(path)
    if (found.trailing || found.node?.type === 'directory') throw new VfsError('EISDIR', path)
    if (found.node === undefined) found.dir.entries.set(found.name, this.#file(bytes, checkMode(mode), checkTime(mtime)))
    else setFile(found.node, bytes, mode, mtime)
  }

  appendFile(path, data) {
    const bytes = encode(data, path)
    const found = this.#locate(path)
    if (found.trailing || found.node?.type === 'directory') throw new VfsError('EISDIR', path)
    if (found.node === undefined) found.dir.entries.set(found.name, this.#file(bytes))
    else found.node.bytes = concat(found.node.bytes, bytes)
  }

  mkdir(path, { recursive = false, mode, mtime } = {}) {
    const found = this.#locate(path, { mkdirs: recursive })
    if (found.node === undefined) found.dir.entries.set(found.name, this.#directory(checkMode(mode), checkTime(mtime)))
    else if (!recursive || found.node.type !== 'directory') throw new VfsError('EEXIST', path)
  }

  symlink(target, path, { mtime } = {}) {
    if (typeof target !== 'string' || target === '' || target.includes('\0')) throw new VfsError('EINVAL', path)
    const found = this.#newName(path)
    found.dir.entries.set(found.name, this.#symlink(target, checkTime(mtime)))
  }

  // A hard link: the same inode under a second name.
  link(existing, path) {
    const node = this.#node(existing, false)
    if (node.type === 'directory') throw new VfsError('EPERM', existing)
    const found = this.#newName(path)
    found.dir.entries.set(found.name, node)
  }

  #newName(path) {
    const found = this.#locate(path, { follow: false })
    if (found.node !== undefined) throw new VfsError('EEXIST', path)
    if (found.trailing) throw new VfsError('ENOENT', path)
    return found
  }

  unlink(path) {
    const found = this.#taken(path)
    if (found.node.type === 'directory') throw new VfsError('EISDIR', path)
    found.dir.entries.delete(found.name)
  }

  rmdir(path) {
    const found = this.#taken(path)
    if (found.node.type !== 'directory') throw new VfsError('ENOTDIR', path)
    if (found.dir === undefined) throw new VfsError('EBUSY', path)
    if (found.node.entries.size > 0) throw new VfsError('ENOTEMPTY', path)
    found.dir.entries.delete(found.name)
  }

  // Removes the name, and with `recursive` everything under a directory.
  rm(path, { recursive = false } = {}) {
    const found = this.#taken(path)
    if (found.node.type === 'directory') {
      if (!recursive) throw new VfsError('EISDIR', path)
      if (found.dir === undefined) throw new VfsError('EBUSY', path)
    }
    found.dir.entries.delete(found.name)
  }

  // The name itself, never what a link there leads to.
  #taken(path) {
    const found = this.#locate(path, { follow: false })
    if (found.node === undefined) throw new VfsError('ENOENT', path)
    return found
  }

  // rename(2): the name moves, replacing a file with a file or an empty
  // directory with a directory; two names of one inode leave both as they are.
  rename(from, to) {
    const source = this.#taken(from)
    if (source.dir === undefined) throw new VfsError('EBUSY', from)
    const target = this.#locate(to, { follow: false })
    if (target.dir === undefined || target.chain.some((step) => step.node === source.node)) throw new VfsError('EINVAL', to)
    if (target.trailing && source.node.type !== 'directory') throw new VfsError('ENOTDIR', to)
    if (target.node === source.node) return
    if (target.node !== undefined) {
      if (target.node.type === 'directory') {
        if (source.node.type !== 'directory') throw new VfsError('EISDIR', to)
        if (target.node.entries.size > 0) throw new VfsError('ENOTEMPTY', to)
      } else if (source.node.type === 'directory') throw new VfsError('ENOTDIR', to)
    }
    source.dir.entries.delete(source.name)
    target.dir.entries.set(target.name, source.node)
  }

  chmod(path, mode) { this.#node(path, true).mode = checkMode(mode) }
  utimes(path, mtime) { this.#node(path, true).mtime = checkTime(mtime) }

  // Every inode at or under `path`, depth first, siblings in name order, a
  // link named but not crossed.
  *#walk(path) {
    const found = this.#locate(path)
    if (found.node === undefined) throw new VfsError('ENOENT', path)
    const stack = [{ path: found.path, node: found.node, depth: 0 }]
    while (stack.length > 0) {
      const entry = stack.pop()
      yield entry
      if (entry.node.type !== 'directory') continue
      const names = [...entry.node.entries.keys()].sort(compareNames)
      for (let i = names.length - 1; i >= 0; i--) {
        stack.push({ path: join(entry.path, names[i]), node: entry.node.entries.get(names[i]), depth: entry.depth + 1 })
      }
    }
  }

  *walk(path = '/') {
    for (const { path: at, node, depth } of this.#walk(path)) yield { path: at, type: node.type, depth }
  }

  // The tree as tar entries: names relative to `path` (`.` for it), a file
  // seen under a second name as a hard link to the first.
  *entries(path = '/') {
    const named = new Map()
    let base
    for (const { path: at, node } of this.#walk(path)) {
      base ??= at
      const name = at === base ? (node.type === 'directory' ? '.' : at.slice(at.lastIndexOf('/') + 1)) : at.slice(base === '/' ? 1 : base.length + 1)
      const entry = { name, type: node.type, mode: node.mode, mtime: node.mtime, linkname: '', data: NONE }
      if (node.type === 'symlink') entry.linkname = node.target
      else if (node.type === 'file') {
        const first = named.get(node)
        if (first === undefined) { named.set(node, name); entry.data = node.bytes } else { entry.type = 'link'; entry.linkname = first }
      }
      yield entry
    }
  }
}

const pathOf = (chain, name) => `/${[...chain.slice(1).map((step) => step.name), name].filter(Boolean).join('/')}`

const statOf = (node) => ({
  type: node.type,
  ino: node.ino,
  mode: node.mode,
  mtime: node.mtime,
  size: node.type === 'file' ? node.bytes.length : node.type === 'symlink' ? encoder.encode(node.target).length : 0,
})

function setFile(node, bytes, mode, mtime) {
  node.bytes = bytes
  if (mode !== undefined) node.mode = checkMode(mode)
  if (mtime !== undefined) node.mtime = checkTime(mtime)
}

function checkMode(mode) {
  if (mode === undefined) return undefined
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) throw new RangeError(`a mode must be an integer from 0 to 0o7777, not ${mode}`)
  return mode
}

function checkTime(mtime) {
  if (mtime === undefined) return undefined
  if (!Number.isSafeInteger(mtime)) throw new RangeError(`an mtime must be an integer of whole seconds, not ${mtime}`)
  return mtime
}

// Text is stored as its UTF-8, and only text that has one; bytes are copied.
function encode(data, path) {
  if (typeof data === 'string') {
    if (!data.isWellFormed()) throw new VfsError('EILSEQ', path)
    return encoder.encode(data)
  }
  if (data instanceof Uint8Array) return new Uint8Array(data)
  throw new TypeError(`file contents must be a string or a Uint8Array, not ${data === null ? 'null' : typeof data}`)
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}
