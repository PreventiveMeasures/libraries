// An in-memory filesystem: a tree of inodes under one root — files holding
// bytes, directories holding named entries, symbolic links holding a target
// — reached by POSIX's rules. A path is resolved from the root, component by
// component: a link on the way is replaced by its target as read from the
// directory the link sits in, `..` steps up the real path, and forty links
// in one resolution is a loop. A relative path is resolved from `/`; a caller
// with a working directory puts it in front, `${cwd}/${path}`, and never
// folds the two, so every component is checked where it stands. Nothing here
// reads a clock: `mtime` is what a caller set, in whole seconds, and 0 until
// then. A file's bytes are returned as they are stored, never copied, and
// stored as a copy of what was written: hold them, do not write into them.
// A name is what a filesystem holds: text with an encoding, of at most 255
// bytes of UTF-8, with no `/` and no NUL.

import { VfsError } from './error.js'
import { basename, compareNames, segments } from './path.js'

const LINK_LIMIT = 40
const NAME_MAX = 255
const NONE = new Uint8Array()
export const MODE = { file: 0o644, directory: 0o755, symlink: 0o777 }
const fresh = (type) => ({ mode: MODE[type], mtime: 0 })
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

// A trailing slash asks for the directory a link leads to, even of a call
// that would otherwise stop at the link.
const slashed = (path) => typeof path === 'string' && path.endsWith('/')

export class Vfs {
  #root
  #inodes = 0

  constructor() {
    this.#root = this.#directory()
  }

  #file(bytes, mode, mtime) { return { ino: ++this.#inodes, type: 'file', ...meta(mode, mtime, fresh('file')), bytes } }
  #directory(mode, mtime) { return { ino: ++this.#inodes, type: 'directory', ...meta(mode, mtime, fresh('directory')), entries: new Map() } }
  #symlink(target, mtime) { return { ino: ++this.#inodes, type: 'symlink', ...meta(undefined, mtime, fresh('symlink')), target } }

  // Where `path` leads: `dir`, the directory its last name is in; `name`; and
  // `node`, the inode there — undefined when the name is not taken, so a
  // creation knows where to go. A spelling that ends on `.` or `..` names a
  // place and no entry, so `dir` is undefined for it as for the root. The
  // last link is followed unless `follow` is false, as lstat does not; a
  // trailing slash asserts a directory. `chain` is every directory from the
  // root down to `dir`, `path` the canonical spelling of the result, and
  // `mkdirs` makes the directories missing on the way, as mkdir -p does.
  #locate(path, { follow = true, mkdirs = false } = {}) {
    if (typeof path !== 'string') throw new TypeError(`a path must be a string, not ${typeof path}`)
    if (path.includes('\0')) throw new VfsError('EINVAL', path)
    if (path === '') throw new VfsError('ENOENT', path)
    const trailing = path.endsWith('/')
    const rest = segments(path).toReversed()
    const chain = [{ name: '', node: this.#root }]
    let budget = LINK_LIMIT
    let dir, name, node
    for (;;) {
      if (rest.length === 0) {
        // `/` itself, or a spelling that ended on `.`, `..` or a link to one.
        ({ name, node } = chain.pop())
        dir = undefined
        break
      }
      name = rest.pop()
      if (name === '.') continue
      if (name === '..') { if (chain.length > 1) chain.pop(); continue }
      dir = chain.at(-1).node
      const last = rest.length === 0
      node = dir.entries.get(name)
      if (node === undefined) {
        if (last) break
        if (!mkdirs) throw new VfsError('ENOENT', path)
        checkName(name, path)
        node = this.#directory()
        dir.entries.set(name, node)
      }
      if (node.type === 'symlink' && (!last || follow)) {
        if (budget-- === 0) throw new VfsError('ELOOP', path)
        if (node.target.startsWith('/')) chain.length = 1
        const parts = segments(node.target)
        if (node.target.endsWith('/')) parts.push('.')
        for (let i = parts.length - 1; i >= 0; i--) rest.push(parts[i])
        continue
      }
      if (last) {
        if (trailing && node.type !== 'directory') throw new VfsError('ENOTDIR', path)
        break
      }
      if (node.type !== 'directory') throw new VfsError('ENOTDIR', path)
      chain.push({ name, node })
    }
    return { dir, name, node, trailing, chain, path: pathOf(chain, name) }
  }

  // What is at `path`, which has to be there; `follow` false takes the name
  // itself, never what a link there leads to.
  #found(path, follow = true) {
    const found = this.#locate(path, { follow })
    if (found.node === undefined) throw new VfsError('ENOENT', path)
    return found
  }

  #node(path, follow) { return this.#found(path, follow).node }

  // Puts `node` under the name a lookup of `path` found, where a name is made.
  #set(found, node, path) {
    checkName(found.name, path)
    found.dir.entries.set(found.name, node)
  }

  // The directory an entry is taken from, for a spelling that names one.
  #dirOf(found, path) {
    if (found.dir !== undefined) return found.dir
    throw new VfsError(found.node === this.#root ? 'EBUSY' : 'EINVAL', path)
  }

  #is(path, type, follow) {
    try { return this.#node(path, follow).type === type } catch (error) {
      if (error instanceof VfsError) return false
      throw error
    }
  }

  stat(path) { return statOf(this.#node(path, true)) }
  lstat(path) { return statOf(this.#node(path, slashed(path))) }
  isFile(path) { return this.#is(path, 'file', true) }
  isDirectory(path) { return this.#is(path, 'directory', true) }
  isSymlink(path) { return this.#is(path, 'symlink', false) }
  realpath(path) { return this.#found(path).path }

  readFile(path) {
    const node = this.#node(path, true)
    if (node.type === 'directory') throw new VfsError('EISDIR', path)
    return node.bytes
  }

  readText(path) {
    const bytes = this.readFile(path)
    try { return decoder.decode(bytes) } catch { throw new VfsError('EILSEQ', path) }
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

  // Where a write lands: through a link, the file the link names.
  #fileAt(path) {
    const found = this.#locate(path)
    if (found.trailing || found.node?.type === 'directory') throw new VfsError('EISDIR', path)
    return found
  }

  // Creates the file or truncates it; the inode stays, so a hard link sees it.
  writeFile(path, data, { mode, mtime } = {}) {
    const bytes = encode(data, path)
    const found = this.#fileAt(path)
    if (found.node === undefined) this.#set(found, this.#file(bytes, mode, mtime), path)
    else Object.assign(found.node, { bytes }, meta(mode, mtime, found.node))
  }

  appendFile(path, data) {
    const bytes = encode(data, path)
    const found = this.#fileAt(path)
    if (found.node === undefined) this.#set(found, this.#file(bytes), path)
    else found.node.bytes = append(found.node.bytes, bytes)
  }

  // mkdir(2) never follows the last link, so a link there is a name taken;
  // `recursive` is content with what a link leads to being a directory.
  mkdir(path, { recursive = false, mode, mtime } = {}) {
    const found = this.#locate(path, { follow: slashed(path), mkdirs: recursive })
    if (found.node === undefined) this.#set(found, this.#directory(mode, mtime), path)
    else if (!recursive || !this.isDirectory(path)) throw new VfsError('EEXIST', path)
  }

  symlink(target, path, { mtime } = {}) {
    if (typeof target !== 'string' || target === '' || target.includes('\0')) throw new VfsError('EINVAL', path)
    if (!target.isWellFormed()) throw new VfsError('EILSEQ', path)
    this.#set(this.#newName(path), this.#symlink(target, mtime), path)
  }

  // A hard link: the same inode under a second name.
  link(existing, path) {
    const node = this.#node(existing, false)
    if (node.type === 'directory') throw new VfsError('EPERM', existing)
    this.#set(this.#newName(path), node, path)
  }

  #newName(path) {
    const found = this.#locate(path, { follow: false })
    if (found.node !== undefined) throw new VfsError('EEXIST', path)
    if (found.trailing) throw new VfsError('ENOENT', path)
    return found
  }

  unlink(path) { this.rm(path) }

  rmdir(path) {
    const found = this.#found(path, false)
    if (found.node.type !== 'directory') throw new VfsError('ENOTDIR', path)
    const dir = this.#dirOf(found, path)
    if (found.node.entries.size > 0) throw new VfsError('ENOTEMPTY', path)
    dir.entries.delete(found.name)
  }

  // Removes the name, and with `recursive` everything under a directory.
  rm(path, { recursive = false } = {}) {
    const found = this.#found(path, false)
    if (found.node.type === 'directory' && !recursive) throw new VfsError('EISDIR', path)
    this.#dirOf(found, path).entries.delete(found.name)
  }

  // rename(2): the name moves, replacing a file with a file or an empty
  // directory with a directory; two names of one inode leave both as they are.
  rename(from, to) {
    const source = this.#found(from, false)
    const sourceDir = this.#dirOf(source, from)
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
    checkName(target.name, to)
    sourceDir.entries.delete(source.name)
    target.dir.entries.set(target.name, source.node)
  }

  chmod(path, mode) { this.#node(path, true).mode = checkMode(mode) }
  utimes(path, mtime) { this.#node(path, true).mtime = checkTime(mtime) }

  // Every inode at or under `path`, depth first, siblings in name order, a
  // link named but not crossed.
  *#walk(path) {
    const found = this.#found(path)
    const stack = [{ path: found.path, node: found.node, depth: 0 }]
    while (stack.length > 0) {
      const entry = stack.pop()
      yield entry
      if (entry.node.type !== 'directory') continue
      const names = [...entry.node.entries.keys()].sort(compareNames)
      for (let i = names.length - 1; i >= 0; i--) {
        stack.push({ path: child(entry.path, names[i]), node: entry.node.entries.get(names[i]), depth: entry.depth + 1 })
      }
    }
  }

  *walk(path = '/') {
    for (const { path: at, node, depth } of this.#walk(path)) yield { path: at, type: node.type, depth }
  }

  // The tree as tar entries: names relative to `path` (`.` for it), a file
  // seen under a second name as a hard link to the first.
  *entries(path = '/') {
    const base = this.realpath(path)
    const named = new Map()
    for (const { path: at, node } of this.#walk(base)) {
      const name = at === base ? (node.type === 'directory' ? '.' : basename(at)) : at.slice(base === '/' ? 1 : base.length + 1)
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

const child = (dir, name) => (dir === '/' ? `/${name}` : `${dir}/${name}`)
const pathOf = (chain, name) => `/${[...chain.slice(1).map((step) => step.name), name].filter(Boolean).join('/')}`

const statOf = (node) => ({
  type: node.type,
  ino: node.ino,
  mode: node.mode,
  mtime: node.mtime,
  size: node.type === 'file' ? node.bytes.length : node.type === 'symlink' ? encoder.encode(node.target).length : 0,
})

// Metadata as given and checked, or as it stands in `current`.
const meta = (mode, mtime, current) => ({
  mode: mode === undefined ? current.mode : checkMode(mode),
  mtime: mtime === undefined ? current.mtime : checkTime(mtime),
})

// What a name may be when it is made: text with an encoding, and at most
// NAME_MAX bytes of it, as every filesystem bounds a name.
function checkName(name, path) {
  if (!name.isWellFormed()) throw new VfsError('EILSEQ', path)
  if (encoder.encode(name).length > NAME_MAX) throw new VfsError('ENAMETOOLONG', path)
}

function checkMode(mode) {
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) throw new RangeError(`a mode must be an integer from 0 to 0o7777, not ${mode}`)
  return mode
}

function checkTime(mtime) {
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

// Appends in amortized linear time: a file that grows gets a buffer with
// room to spare and a view over the part in use. A view handed out earlier
// covers only its own length, which an append past its end leaves as it was.
function append(current, more) {
  const length = current.length + more.length
  let bytes
  if (current.byteOffset + length <= current.buffer.byteLength) {
    bytes = new Uint8Array(current.buffer, current.byteOffset, length)
  } else {
    bytes = new Uint8Array(new ArrayBuffer(Math.max(length, current.length * 2)), 0, length)
    bytes.set(current)
  }
  bytes.set(more, current.length)
  return bytes
}
