// A pod's download held in memory as CocoaPods finds it on disk: what is there, what a path comes to through the
// links on the way, and what FileUtils.rm_rf leaves of it.

import { PodError, quote } from '../error.js'
import { CASE_UNSTABLE, fold } from './unicode.js'

// The links a path is followed through before it leads nowhere, as each system gives up with ELOOP; and the
// longest path and name in bytes a call takes, which a path is shorter than with the pod's directory before it.
const LIMITS = {
  linux: { links: 40, path: 4096, name: 255 },
  darwin: { links: 32, path: 1024, name: 255 },
}

const parentOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
const join = (dir, name) => (dir === '' ? name : `${dir}/${name}`)

// Its paths, each a directory, a file with its data and mode, or a link with its target; each directory on the
// way to one is one. `folded` where it is on macOS, which finds a name whatever its case and normalization: two
// that are one name there are refused, as git's checkout would write one of them alone.
export class PodTree {
  constructor({ dirs, files, links }, folded, where) {
    this.where = where
    this.limits = LIMITS[folded ? 'darwin' : 'linux']
    this.key = folded ? fold : (path) => path
    this.nodes = new Map()
    const add = (path, node) => {
      for (let at = parentOf(path); at !== '' && !this.nodes.has(at); at = parentOf(at)) this.nodes.set(at, { type: 'directory' })
      this.nodes.set(path, node)
    }
    for (const dir of dirs) add(dir, { type: 'directory' })
    for (const [path, { data, mode }] of files) add(path, { type: 'file', data, mode })
    for (const [path, target] of links) add(path, { type: 'symlink', target })
    this.byKey = new Map()
    for (const [path, node] of this.nodes) {
      this.check(path, node.target)
      const other = this.byKey.get(this.key(path))
      if (other !== undefined) throw new PodError(`${quote(other)} and ${quote(path)} are one name on macOS`, where)
      this.byKey.set(this.key(path), path)
    }
  }

  // What CocoaPods fails on, a path or a name too long, and what it reads by case otherwise in one release of
  // Ruby than another.
  check(path, target) {
    if (Buffer.byteLength(path) >= this.limits.path || path.split('/').some((name) => Buffer.byteLength(name) > this.limits.name)) {
      throw new PodError(`${quote(path)} is longer than a path or a name can be, and CocoaPods fails on it`, this.where)
    }
    if (CASE_UNSTABLE.test(path) || (target !== undefined && CASE_UNSTABLE.test(target))) {
      throw new PodError(`${quote(path)} has a letter whose case each release of Ruby maps otherwise, by which CocoaPods compares names`, this.where)
    }
  }

  get paths() {
    return [...this.nodes.keys()]
  }

  // The node `path` comes to, links followed, or undefined where it comes to nothing. A link out of the pod's
  // directory reads whatever is there on the machine, and is refused.
  resolve(path) {
    // The names still to follow, the next one last.
    const pending = path.split('/').toReversed()
    let at = ''
    let followed = 0
    while (pending.length > 0) {
      const name = pending.pop()
      if (name === '' || name === '.') continue
      if (name === '..') {
        if (at === '') throw new PodError(`${quote(path)} leads out of the pod's directory through a link`, this.where)
        at = parentOf(at)
        continue
      }
      const next = this.byKey.get(this.key(join(at, name)))
      if (next === undefined) return undefined
      const node = this.nodes.get(next)
      if (node.type === 'symlink') {
        // A link to nothing at all leads nowhere.
        if (++followed > this.limits.links || node.target === '') return undefined
        if (node.target.startsWith('/')) throw new PodError(`${quote(next)} links to the absolute ${quote(node.target)}`, this.where)
        pending.push(...node.target.split('/').toReversed())
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

  // FileUtils.rm_rf of each of `removed`, and all under it, as nothing is under a link.
  removeAll(removed) {
    for (const path of this.paths) {
      let at = path
      while (at !== '' && !removed.has(at)) at = parentOf(at)
      if (at === '') continue
      this.nodes.delete(path)
      this.byKey.delete(this.key(path))
    }
  }

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
