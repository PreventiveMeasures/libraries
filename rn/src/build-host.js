// The host a build looks up and reads its files through (bundle.js's): of
// what it reads or looks for, for a watcher; each path looked up once;
// whether a path is a file or a directory as its directory lists it.

import { basename, dirname } from 'node:path'

// The host, each file read or looked for through it added to `read`: a
// file not there yet (an import written before its module) is a file a
// watcher sees made.
const look = (read, path, found) => {
  read.add(path)
  return found
}
export const reading = (host, read) => ({
  isFile: (path) => look(read, path, host.isFile(path)),
  isDirectory: (path) => look(read, path, host.isDirectory(path)),
  realpath: (path) => host.realpath(path),
  readdir: (path) => host.readdir(path),
  readFile: (path) => {
    read.add(path)
    return host.readFile(path)
  },
})

// The host, each path's isFile, isDirectory and realpath looked up once:
// Metro's resolver (metro-resolver's own too, as its fileSystemLookup) looks
// up each spelling of a module (each platform and extension), and each
// directory up to its package.json, of each import, as a build's files,
// which it reads anew, don't change in it; as Metro's file map has them,
// not from the disk at each import.
export function lookingOnce(host) {
  const known = { isFile: new Map(), isDirectory: new Map(), realpath: new Map() }
  const once = (name) => (path) => {
    const map = known[name]
    if (!map.has(path)) map.set(path, host[name](path))
    return map.get(path)
  }
  return { ...host, isFile: once('isFile'), isDirectory: once('isDirectory'), realpath: once('realpath') }
}

// The host, where it lists a directory's entries of their types (its
// `dirents`: not @preventive/vfs's `entries`, an archive's), whether a
// path is a file or a directory as its directory lists it, each directory
// listed once: as Metro's file map has a module's
// spellings (each platform and extension the resolver tries), of its names
// as they are, not a lookup on the disk of each. A link, an entry of no
// type, or a path in a directory there but not to be listed (EACCES, of
// one searchable alone), as the host has it.
export function listing(host) {
  if (typeof host.dirents !== 'function') return host
  const dirs = new Map()
  const listed = (dir) => {
    if (!dirs.has(dir)) {
      let entries
      try {
        entries = new Map(host.dirents(dir).map((entry) => [entry.name, entry]))
      } catch (error) {
        // No directory there: nothing in it. Else none, each path looked up.
        entries = error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? new Map() : null
      }
      dirs.set(dir, entries)
    }
    return dirs.get(dir)
  }
  const of = (name) => (path) => {
    const dir = dirname(path)
    const entries = dir === path ? null : listed(dir)
    if (entries === null) return host[name](path)
    const entry = entries.get(basename(path))
    if (entry === undefined) return false
    if (entry.isSymbolicLink() || !(entry.isFile() || entry.isDirectory())) return host[name](path)
    return name === 'isFile' ? entry.isFile() : entry.isDirectory()
  }
  return { ...host, isFile: of('isFile'), isDirectory: of('isDirectory') }
}
