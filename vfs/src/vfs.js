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
// bytes of UTF-8, with no `/` and no NUL. A link's target is text with an
// encoding too, of at most PATH_MAX bytes, as a filesystem and an archive
// hold it: a lookup reads every target on its way, forty at most, so a
// target's length is what a lookup can be made to cost.

import { VfsError, wrongType } from './error.js'
import { compareNames } from './path.js'

const LINK_LIMIT = 40
const NAME_MAX = 255
export const PATH_MAX = 4096
const NONE = new Uint8Array()
export const MODE = { file: 0o644, directory: 0o755, symlink: 0o777 }
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

  #inode(type, contents, mode, mtime) { return { ino: ++this.#inodes, type, ...meta(mode, mtime, { mode: MODE[type], mtime: 0 }), ...contents } }
  #directory(mode, mtime) { return this.#inode('directory', { entries: new Map() }, mode, mtime) }

  // Where `path` leads: `dir`, the directory its last name is in; `name`; and
  // `node`, the inode there — undefined when the name is not taken, so a
  // creation knows where to go. A spelling that ends on `.` or `..` names a
  // place and no entry, so `dir` is undefined for it as for the root. The
  // last link is followed unless `follow` is false, as lstat does not; a
  // trailing slash asserts a directory. `chain` is every directory from the
  // root down to `dir`, and `linked` whether the last name was a link's
  // target's rather than the caller's. `mkdirs` makes the directories
  // missing on the way, as mkdir -p does, but only those the caller
  // spelled: a link leading to a missing one is a dangling link, and
  // ENOENT. `create` says the caller is about to make the last name and
  // judges what is there itself, so a trailing slash asserts nothing of it:
  // mkdir(2), symlink(2) and link(2) say EEXIST of any name taken, whatever
  // it is.
  #locate(path, { follow = true, mkdirs = false, create = false } = {}) {
    if (typeof path !== 'string') throw wrongType('a path', path)
    if (path.includes('\0')) throw new VfsError('EINVAL', path)
    if (path === '') throw new VfsError('ENOENT', path)
    let trailing = path.endsWith('/')
    // The spellings being read, the caller's under any link's target: a name
    // comes from the topmost with names left, and from a link's when there is
    // one, so a name is never the caller's own while a target is being read.
    const readers = [reader(path)]
    const chain = [{ name: '', node: this.#root }]
    let budget = LINK_LIMIT
    let dir, linked, name, node
    for (;;) {
      while (readers.length > 1 && done(readers.at(-1))) readers.pop()
      if (done(readers.at(-1))) {
        // `/` itself, or a spelling that ended on `.`, `..` or a link to one.
        ({ name, node } = chain.pop())
        dir = undefined
        break
      }
      linked = readers.length > 1
      name = next(readers.at(-1))
      if (name === '.') continue
      if (name === '..') { if (chain.length > 1) chain.pop(); continue }
      dir = chain.at(-1).node
      const last = readers.every(done)
      node = dir.entries.get(name)
      // A target that ends in a slash puts that slash on its last name, and
      // a maker judges that name as it would the caller's, unfollowed.
      if (create && !last && readers.every(spent)) { trailing = true; break }
      if (node === undefined) {
        if (last) break
        if (!mkdirs || linked) throw new VfsError('ENOENT', path)
        checkName(name, path)
        node = this.#directory()
        dir.entries.set(name, node)
      }
      if (node.type === 'symlink' && (!last || follow)) {
        if (budget-- === 0) throw new VfsError('ELOOP', path)
        if (node.target.startsWith('/')) chain.length = 1
        readers.push(reader(node.target, true))
        continue
      }
      if (last) {
        if (trailing && !create && node.type !== 'directory') throw new VfsError('ENOTDIR', path)
        break
      }
      if (node.type !== 'directory') throw new VfsError('ENOTDIR', path)
      chain.push({ name, node })
    }
    return { dir, name, node, trailing, chain, linked }
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

  // The directory an entry is taken from, for a spelling that names one:
  // not the root spelled as itself, which is in use, nor a spelling that
  // ends on `.` or `..`, wherever it leads, as POSIX has both.
  #dirOf(found, path) {
    if (found.dir !== undefined) return found.dir
    throw new VfsError(skip(path, 0) === path.length ? 'EBUSY' : 'EINVAL', path)
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
  realpath(path) { return pathOf(this.#found(path)) }

  readFile(path) {
    const node = this.#node(path, true)
    if (node.type === 'directory') throw new VfsError('EISDIR', path)
    return node.bytes
  }

  readText(path) {
    const bytes = this.readFile(path)
    try { return decoder.decode(bytes) } catch { throw new VfsError('EILSEQ', path) }
  }

  // A trailing slash follows the link, as lstat's does: what is then there
  // is no link, or is not there at all.
  readlink(path) {
    const node = this.#node(path, slashed(path))
    if (node.type !== 'symlink') throw new VfsError('EINVAL', path)
    return node.target
  }

  readdir(path) {
    const node = this.#node(path, true)
    if (node.type !== 'directory') throw new VfsError('ENOTDIR', path)
    return [...node.entries.keys()].sort(compareNames)
  }

  // Where a write lands: through a link, the file the link names, made of
  // the bytes if it is not there and handed to `update` if it is. A
  // trailing slash, the caller's or on the target of a link followed last,
  // asks for a directory, which open(2) neither makes nor writes: once the
  // way there is walked, EISDIR whatever the last name holds, unfollowed.
  #write(path, data, update, mode, mtime) {
    const bytes = encode(data, path)
    const found = this.#locate(path, { follow: !slashed(path), create: true })
    if (found.trailing || found.node?.type === 'directory') throw new VfsError('EISDIR', path)
    if (found.node === undefined) this.#set(found, this.#inode('file', { bytes }, mode, mtime), path)
    else update(found.node, bytes)
  }

  // Creates the file or truncates it; the inode stays, so a hard link sees it.
  writeFile(path, data, { mode, mtime } = {}) {
    this.#write(path, data, (node, bytes) => Object.assign(node, { bytes }, meta(mode, mtime, node)), mode, mtime)
  }

  appendFile(path, data) { this.#write(path, data, (node, bytes) => { node.bytes = append(node.bytes, bytes) }) }

  // mkdir(2) never follows the last link, so a link there is a name taken,
  // and a trailing slash changes nothing: any name taken is EEXIST. With
  // `recursive` the link is followed and a directory where it leads is
  // enough, but nothing is ever made where a dangling link points: a name
  // its target spelled is not the caller's to make.
  mkdir(path, { recursive = false, mode, mtime } = {}) {
    const found = this.#locate(path, { follow: recursive, mkdirs: recursive, create: !recursive })
    if (found.node === undefined) {
      if (found.linked) throw new VfsError('ENOENT', path)
      this.#set(found, this.#directory(mode, mtime), path)
    } else if (!recursive || found.node.type !== 'directory') throw new VfsError('EEXIST', path)
  }

  // A link's mode is 0o777 unless given, as Linux has it; one made elsewhere
  // may carry another, and chmod follows the link, so here is where it is set.
  symlink(target, path, { mode, mtime } = {}) {
    if (typeof target !== 'string') throw wrongType('a link target', target)
    if (target === '' || target.includes('\0')) throw new VfsError('EINVAL', path)
    if (!target.isWellFormed()) throw new VfsError('EILSEQ', path)
    if (tooLong(target, PATH_MAX)) throw new VfsError('ENAMETOOLONG', path)
    this.#set(this.#newName(path), this.#inode('symlink', { target, size: utf8Length(target) }, mode, mtime), path)
  }

  // A hard link: the same inode under a second name. A trailing slash
  // follows a symlink, as lstat's does, and the new name is judged before
  // what it would name, as linkat(2) has it.
  hardlink(existing, path) {
    const node = this.#node(existing, slashed(existing))
    const found = this.#newName(path)
    if (node.type === 'directory') throw new VfsError('EPERM', existing)
    this.#set(found, node, path)
  }

  #newName(path) {
    const found = this.#locate(path, { follow: false, create: true })
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
  // directory with a directory; two names of one inode leave both as they
  // are. Both ways are walked before either name is judged, and a name
  // before what it holds, as Linux has it: a directory into itself is
  // EINVAL, onto one of its own parents ENOTEMPTY.
  rename(from, to) {
    const source = this.#locate(from, { follow: false, create: true })
    const target = this.#locate(to, { follow: false, create: true })
    const sourceDir = this.#dirOf(source, from)
    const targetDir = this.#dirOf(target, to)
    if (source.node === undefined) throw new VfsError('ENOENT', from)
    checkName(target.name, to)
    const directory = source.node.type === 'directory'
    if (!directory && (source.trailing || target.trailing)) throw new VfsError('ENOTDIR', source.trailing ? from : to)
    if (target.chain.some((step) => step.node === source.node)) throw new VfsError('EINVAL', to)
    if (source.chain.some((step) => step.node === target.node)) throw new VfsError('ENOTEMPTY', to)
    if (target.node === source.node) return
    if (target.node !== undefined && (target.node.type === 'directory') !== directory) throw new VfsError(directory ? 'ENOTDIR' : 'EISDIR', to)
    if (target.node?.type === 'directory' && target.node.entries.size > 0) throw new VfsError('ENOTEMPTY', to)
    sourceDir.entries.delete(source.name)
    targetDir.entries.set(target.name, source.node)
  }

  chmod(path, mode) { this.#node(path, true).mode = checkMode(mode) }
  utimes(path, mtime) { this.#node(path, true).mtime = checkTime(mtime) }

  // From what `path` leads to, resolved when called, as entries is too: a
  // wrong start throws here and not at the first step.
  walk(path = '/') {
    const found = this.#found(path)
    const base = pathOf(found)
    const under = base === '/' ? '/' : `${base}/`
    return descend(found.node, ({ name, node, depth }) => ({ path: name === '' ? base : under + name, type: node.type, depth }))
  }

  // The tree as tar entries: names relative to `path`, `.` for it or a
  // file's own name, and an inode seen under a second name as a hard link
  // to the first.
  entries(path = '/') {
    const found = this.#found(path)
    const top = found.node.type === 'directory' ? '.' : found.name
    const named = new Map()
    return descend(found.node, ({ name: under, node }) => {
      const name = under === '' ? top : under
      const entry = { name, type: node.type, mode: node.mode, mtime: node.mtime, linkname: '', data: NONE }
      const earlier = named.get(node)
      if (earlier !== undefined) { entry.type = 'hardlink'; entry.linkname = earlier }
      else if (node.type === 'symlink') { named.set(node, name); entry.linkname = node.target }
      else if (node.type === 'file') { named.set(node, name); entry.data = node.bytes }
      return entry
    })
  }
}

// Every inode at or under `top`, depth first, siblings in name order, a
// link named but not crossed, as `shape` has it; `name` is the way down
// from `top`, '' for it.
function* descend(top, shape) {
  const stack = [{ name: '', node: top, depth: 0 }]
  while (stack.length > 0) {
    const entry = stack.pop()
    yield shape(entry)
    if (entry.node.type !== 'directory') continue
    const names = [...entry.node.entries.keys()].sort(compareNames)
    for (let i = names.length - 1; i >= 0; i--) {
      const name = entry.name === '' ? names[i] : `${entry.name}/${names[i]}`
      stack.push({ name, node: entry.node.entries.get(names[i]), depth: entry.depth + 1 })
    }
  }
}

// A spelling read a name at a time, slashes skipped, holding no more than
// where it is. A link's target that ends in a slash reads as a final `.`,
// so what it leads to has to be a directory, as a caller's trailing slash
// asks.
const reader = (text, target = false) => ({ text, at: skip(text, 0), dot: target && text.endsWith('/') })
const spent = (r) => r.at === r.text.length
const done = (r) => spent(r) && !r.dot
const skip = (text, at) => { let i = at; while (text[i] === '/') i++; return i }
function next(r) {
  if (spent(r)) { r.dot = false; return '.' }
  const slash = r.text.indexOf('/', r.at)
  const end = slash === -1 ? r.text.length : slash
  const name = r.text.slice(r.at, end)
  r.at = skip(r.text, end)
  return name
}

// The canonical spelling of what a lookup found.
const pathOf = ({ chain, name }) => `/${[...chain.slice(1).map((step) => step.name), name].filter(Boolean).join('/')}`

const statOf = (node) => ({ type: node.type, ino: node.ino, mode: node.mode, mtime: node.mtime, size: node.bytes?.length ?? node.size ?? 0 })

// Metadata as given and checked, or as it stands in `current`.
const meta = (mode, mtime, current) => ({
  mode: mode === undefined ? current.mode : checkMode(mode),
  mtime: mtime === undefined ? current.mtime : checkTime(mtime),
})

// What a name may be when it is made: text with an encoding, and at most
// NAME_MAX bytes of it, as every filesystem bounds a name.
function checkName(name, path) {
  if (!name.isWellFormed()) throw new VfsError('EILSEQ', path)
  if (tooLong(name, NAME_MAX)) throw new VfsError('ENAMETOOLONG', path)
}

// The UTF-8 length of text, counted rather than encoded: nothing is held
// but the count, however long the text.
function utf8Length(text) {
  let length = 0
  for (const char of text) {
    const code = char.codePointAt(0)
    length += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return length
}

// Whether text is more than `max` bytes of UTF-8. A code unit is at least
// a byte, so text of more units than that is over without being counted.
export const tooLong = (text, max) => text.length > max || utf8Length(text) > max

export function checkMode(mode) {
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) throw new RangeError(`a mode must be an integer from 0 to 0o7777, not ${mode}`)
  return mode
}

export function checkTime(mtime) {
  if (!Number.isSafeInteger(mtime)) throw new RangeError(`an mtime must be an integer of whole seconds, not ${mtime}`)
  return mtime
}

// Text is stored as its UTF-8, and only text that has one; bytes are copied.
export function encode(data, path) {
  if (typeof data === 'string') {
    if (!data.isWellFormed()) throw new VfsError('EILSEQ', path)
    return encoder.encode(data)
  }
  if (data instanceof Uint8Array) return new Uint8Array(data)
  throw wrongType('file contents', data, 'a string or a Uint8Array')
}

// Appends in amortized linear time: a file that grows gets a buffer with
// room to spare and a view over the part in use. A view handed out earlier
// covers only its own length, which an append past its end leaves as it was.
function append(current, more) {
  const length = current.length + more.length
  const room = current.byteOffset + length <= current.buffer.byteLength
  const bytes = room ? new Uint8Array(current.buffer, current.byteOffset, length) : new Uint8Array(Math.max(length, current.length * 2)).subarray(0, length)
  if (!room) bytes.set(current)
  bytes.set(more, current.length)
  return bytes
}
