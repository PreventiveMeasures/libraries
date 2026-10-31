// A pod's directory, held in memory as CocoaPods finds it on disk: what
// is there, what a path comes to through the links on the way, and what
// FileUtils.rm_rf leaves of it.

import { DeptreeError, quote } from '../error.js'

// The links a path is followed through before it is taken to lead
// nowhere, as Linux and macOS give up with ELOOP.
const MAX_LINKS = 40

const parentOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
const join = (dir, name) => (dir === '' ? name : `${dir}/${name}`)

// A pod's directory: its paths from there, each a directory, a file with
// its data and mode, or a link with its target, as given; every directory
// on the way to one is one of them.
export class PodTree {
  constructor({ dirs, files, links }, where) {
    this.where = where
    this.nodes = new Map()
    const add = (path, node) => {
      for (let at = parentOf(path); at !== '' && !this.nodes.has(at); at = parentOf(at)) this.nodes.set(at, { type: 'directory' })
      this.nodes.set(path, node)
    }
    for (const dir of dirs) add(dir, { type: 'directory' })
    for (const [path, { data, mode }] of files) add(path, { type: 'file', data, mode })
    for (const [path, target] of links) add(path, { type: 'symlink', target })
  }

  get paths() {
    return [...this.nodes.keys()]
  }

  // The node `path` comes to, links followed, or undefined where it comes
  // to nothing. A link that leads out of the pod's directory reads as
  // whatever is there on the machine, which is refused.
  resolve(path) {
    let pending = path.split('/')
    let at = ''
    let followed = 0
    while (pending.length > 0) {
      const [name, ...rest] = pending
      pending = rest
      if (name === '' || name === '.') continue
      if (name === '..') {
        if (at === '') throw new DeptreeError(`${quote(path)} leads out of the pod's directory through a link`, this.where)
        at = parentOf(at)
        continue
      }
      const next = join(at, name)
      const node = this.nodes.get(next)
      if (node === undefined) return undefined
      if (node.type === 'symlink') {
        if (++followed > MAX_LINKS) return undefined
        if (node.target.startsWith('/')) throw new DeptreeError(`${quote(next)} links to the absolute ${quote(node.target)}`, this.where)
        pending = [...node.target.split('/'), ...pending]
        continue
      }
      if (node.type === 'file' && pending.length > 0) return undefined
      at = next
    }
    return at === '' ? { path: '', node: { type: 'directory' } } : { path: at, node: this.nodes.get(at) }
  }

  // File.directory? and File.exist?, which follow links.
  isDirectory(path) {
    return this.resolve(path)?.node.type === 'directory'
  }

  exists(path) {
    return this.resolve(path) !== undefined
  }

  // FileUtils.rm_rf of each of `removed`: it, and all under it where it is
  // a directory, as nothing is under a link.
  removeAll(removed) {
    for (const path of this.paths) {
      for (let at = path; at !== ''; at = parentOf(at)) {
        if (!removed.has(at)) continue
        this.nodes.delete(path)
        break
      }
    }
  }

  // The tree as writeFiles writes it.
  contents() {
    const dirs = []
    const files = new Map()
    const links = new Map()
    for (const [path, node] of this.nodes) {
      if (node.type === 'directory') dirs.push(path)
      else if (node.type === 'file') files.set(path, { data: node.data, mode: node.mode })
      else links.set(path, node.target)
    }
    return { dirs, files, links }
  }
}
