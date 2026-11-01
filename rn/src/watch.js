// Watching what the bundles were built from: the directory of each file a
// build read, and each directory above it up to the project root, so that a
// file added beside one (a `.ios.js`), a package.json and a package installed
// are seen too. With inotify (Linux), a watch of each of those directories,
// not of the whole tree: node_modules has more directories than inotify
// watches. With FSEvents and ReadDirectoryChangesW (macOS, Windows), which
// watch a tree as cheaply as a directory, one recursive watch of the project
// root, its changes taken in those directories alone; and a watch of each
// directory outside it. A file's contents changing counts where a build read
// it, as a log written beside the files must not rebuild them; a file added,
// removed or renamed counts wherever, as it may change what resolves.

import { watch as fsWatch } from 'node:fs'
import { dirname, join } from 'node:path'

import { inside } from './dev-bundler.js'

const RECURSIVE = process.platform === 'darwin' || process.platform === 'win32'

// -> { update(files), close() }. `onChange(path)` on each change seen.
export function createWatcher(projectRoot, onChange, { watch = fsWatch, recursive = RECURSIVE, onError = () => {} } = {}) {
  const watchers = new Map()
  let dirs = new Set()
  let read = new Set()
  const dirsOf = (files) => {
    const found = new Set([projectRoot])
    for (const file of files) {
      for (let dir = dirname(file); !found.has(dir); dir = dirname(dir)) {
        found.add(dir)
        if (!inside(projectRoot, dir)) break
      }
    }
    return found
  }
  const add = (dir) => {
    const deep = recursive && dir === projectRoot
    const seen = (event, path) => {
      if (deep && !dirs.has(dirname(path)) && !dirs.has(path)) return
      if (event === 'change' && !read.has(path)) return
      onChange(path)
    }
    try {
      const watcher = watch(dir, { persistent: false, recursive: deep }, (event, name) => seen(event, name === null ? dir : join(dir, String(name))))
      watcher.on('error', () => {
        watcher.close()
        watchers.delete(dir)
        onChange(dir)
      })
      watchers.set(dir, watcher)
    } catch (error) {
      if (error?.code !== 'ENOENT') onError(error)
    }
  }
  return {
    update(files) {
      read = new Set(files)
      dirs = dirsOf(read)
      const wanted = recursive ? new Set([...dirs].filter((dir) => dir === projectRoot || !inside(projectRoot, dir))) : dirs
      for (const [dir, watcher] of watchers) {
        if (wanted.has(dir)) continue
        watcher.close()
        watchers.delete(dir)
      }
      for (const dir of wanted) {
        if (!watchers.has(dir)) add(dir)
      }
    },
    close() {
      for (const watcher of watchers.values()) watcher.close()
      watchers.clear()
    },
  }
}
