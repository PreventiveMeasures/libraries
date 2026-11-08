// A gem's directory as RubyGems 3.5.15 to 4.0 leave it for Bundler, umask
// 0o022: extract_tar_gz with no dir, prog or data mode, then generate_bin.
// What a release removes, writes over or fails on as a user is refused.

import { DeptreeError, quote } from '../error.js'
import { fold } from '../mount.js'

const sameBytes = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i])

const dirname = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')

// File.expand_path's lexical reading of `path` under `from`, both within
// the gem's directory, '' for it; undefined where it leads out.
function expand(from, path) {
  const out = from === '' ? [] : from.split('/')
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment !== '..') out.push(segment)
    else if (out.pop() === undefined) return undefined
  }
  return out.join('/')
}

const SPECIAL = 0o7000
const UMASK = 0o022

function refuse(detail, where) {
  throw new DeptreeError(detail, where)
}

class GemDir {
  constructor(folded) {
    this.key = folded ? fold : (name) => name
    // Each node by its path's key: its path, and a directory's or a file's
    // mode, a file's data, a link's target.
    this.nodes = new Map([['', { path: '', type: 'directory', mode: 0o755 }]])
    // The longest a chain of links resolves through: Linux's 40, macOS' 32.
    this.maxLinks = folded ? 32 : 40
  }

  get(path) {
    return this.nodes.get(this.key(path))
  }

  // As any user but root, nothing is made in a directory its owner cannot
  // write in and search.
  makeIn(path, here) {
    const parent = this.get(dirname(path))
    if ((parent.mode & 0o300) !== 0o300) refuse(`mode ${parent.mode.toString(8)} of ${quote(parent.path)}, which keeps RubyGems from making what is in it as any user but root, is not supported`, here)
  }

  add(node, here) {
    this.makeIn(node.path, here)
    this.nodes.set(this.key(node.path), node)
  }

  // FileUtils.mkdir_p: each directory not there made, of `mode` where it is
  // given, chmod setting it past the umask, else 0o755.
  mkdirP(path, mode, here) {
    const missing = []
    for (let at = path; at !== '' && this.get(at)?.type !== 'directory'; at = dirname(at)) {
      if (this.get(at) !== undefined) refuse(`${quote(at)} is a ${this.get(at).type}, where RubyGems makes a directory`, here)
      missing.push(at)
    }
    for (const dir of missing.toReversed()) this.add({ path: dir, type: 'directory', mode: mode ?? 0o755 }, here)
  }

  // The node a path leads to, following each link made as the machine
  // does, a component at a time; undefined where it leads nowhere, `null`
  // where it leads out of the gem's directory.
  resolve(path) {
    const parts = path.split('/')
    const real = []
    let followed = 0
    while (parts.length > 0) {
      const part = parts.shift()
      if (part === '' || part === '.') continue
      if (part === '..') {
        if (real.pop() === undefined) return null
        continue
      }
      const node = this.get([...real, part].join('/'))
      if (node === undefined || (node.type === 'file' && parts.length > 0)) return undefined
      if (node.type === 'symlink') {
        if (++followed > this.maxLinks) return undefined
        parts.unshift(...node.target.split('/'))
        continue
      }
      real.push(part)
    }
    return this.get(real.join('/'))
  }
}

// An entry's mode within 0o777, as chmod takes it; a special bit refused.
function permissions(entry, here) {
  if (entry.mode & SPECIAL) refuse(`mode ${entry.mode.toString(8)}, of a setuid, setgid or sticky bit, which RubyGems 4.0.24 drops and those before keep, is not supported`, here)
  return entry.mode & 0o777
}

// extract_tar_gz: each entry where install_location puts it; what rm_rf
// would remove refused, but the same file again; its directory made once;
// each link, after every entry, where what it leads to is there.
function extract(entries, dir, where) {
  const made = new Set()
  const links = []
  for (const entry of entries) {
    const here = `${where}: ${quote(entry.name)}`
    if (entry.name.startsWith('/') || entry.name.startsWith('~')) refuse('a name RubyGems reads as outside the gem\'s directory, which it refuses', here)
    const destination = expand('', entry.name)
    if (destination === undefined || destination === '') refuse('a name leading out of the gem\'s directory, which RubyGems refuses', here)
    if (entry.type === 'symlink') {
      if (entry.linkname.startsWith('/') || entry.linkname.startsWith('~')) refuse('a link RubyGems reads as leading out of the gem\'s directory, which it refuses', here)
      const target = expand(dirname(destination), entry.linkname)
      if (target === undefined || target === '') refuse('a link leading out of the gem\'s directory, which RubyGems refuses', here)
      if (links.some((link) => dir.key(link.path) === dir.key(destination))) refuse('a link twice, which RubyGems fails to make again', here)
      links.push({ path: destination, linkname: entry.linkname, target, here })
    }
    const there = dir.get(destination)
    if (there !== undefined && !(entry.type === 'file' && there.type === 'file' && there.entry.mode === entry.mode && sameBytes(there.entry.data, entry.data))) {
      refuse(`a ${entry.type} where RubyGems has made a ${there.type} already, which it removes first`, here)
    }
    if (links.some((link) => link.path !== destination && dir.key(link.path) === dir.key(destination))) refuse('a link\'s place, which RubyGems fails to make the link in', here)
    const mkdir = entry.type === 'directory' ? destination : dirname(destination)
    if (!made.has(dir.key(mkdir))) {
      dir.mkdirP(mkdir, entry.type === 'directory' ? permissions(entry, here) : undefined, here)
      made.add(dir.key(mkdir))
    }
    if (entry.type === 'file' && there === undefined) dir.add({ path: destination, type: 'file', mode: permissions(entry, here) & ~UMASK, data: entry.data, entry }, here)
  }
  for (const { path, linkname, target, here } of links) {
    const found = dir.resolve(target)
    if (found === null) refuse('a link leading out of the gem\'s directory through another', here)
    if (found === undefined) continue
    if (dir.get(path) !== undefined) refuse(`a link where RubyGems has made a ${dir.get(path).type}, which it fails to make the link in`, here)
    dir.add({ path, type: 'symlink', target: linkname }, here)
  }
}

// generate_bin: each executable there, File.stat following links, made
// executable by all; one leading out of the gem's directory refused, as
// RubyGems would chmod what is there.
function makeExecutable(dir, { bindir, executables }, where) {
  for (const name of executables) {
    const path = `${bindir}/${name}`
    const node = dir.resolve(path)
    if (node === null) refuse(`its executable ${quote(name)} in ${quote(bindir)} leads out of its directory`, where)
    if (node !== undefined) node.mode |= 0o111
  }
}

// The gem's directory, as writeFiles takes it.
export function installGem(entries, spec, folded, where) {
  const dir = new GemDir(folded)
  extract(entries, dir, where)
  makeExecutable(dir, spec, where)
  const dirs = []
  const files = new Map()
  const links = new Map()
  for (const node of dir.nodes.values()) {
    if (node.path === '') continue
    if (node.type === 'directory') dirs.push(node)
    else if (node.type === 'file') files.set(node.path, { data: node.data, mode: node.mode })
    else links.set(node.path, node.target)
  }
  return { dirs, files, links }
}
