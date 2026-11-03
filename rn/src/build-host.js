// Hosts a build looks up and reads its files through (bundle.js): noting what it reads or looks for, for
// a watcher; looking each path up once; and telling files from directories by their directory's listing.

import { basename, dirname } from 'node:path'

// The host, noting in `read` each file read or looked for: one not there yet (an import written before
// its module) is a file a watcher sees made.
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

// The host, looking up each path's isFile, isDirectory and realpath once, as Metro's file map does:
// the resolver tries every spelling of each import (platform, extension) and each directory up to its
// package.json, and a build's files don't change during it.
export function lookingOnce(host) {
  const known = { isFile: new Map(), isDirectory: new Map(), realpath: new Map() }
  const once = (name) => (path) => {
    const map = known[name]
    if (!map.has(path)) map.set(path, host[name](path))
    return map.get(path)
  }
  return { ...host, isFile: once('isFile'), isDirectory: once('isDirectory'), realpath: once('realpath') }
}

// The host, telling a file from a directory by its directory's typed entries (`dirents`, not
// @preventive/vfs's `entries`, an archive's), each directory listed once, as Metro's file map does.
// A link, an entry of no type, or a directory that can't be listed (EACCES) is left to the host.
export function listing(host) {
  if (typeof host.dirents !== 'function') return host
  const dirs = new Map()
  const listed = (dir) => {
    if (dirs.has(dir)) return dirs.get(dir)
    let entries
    try {
      entries = new Map(host.dirents(dir).map((entry) => [entry.name, entry]))
    } catch (error) {
      // No directory there has nothing in it; null leaves each path in one not listed to the host.
      entries = error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? new Map() : null
    }
    dirs.set(dir, entries)
    return entries
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
