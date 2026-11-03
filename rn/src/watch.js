// Watches the directories of the files a build read and those above them up to the project root, so added files,
// package.json edits and installs are seen. inotify (Linux) gets a watch per directory, as node_modules would exhaust
// it; FSEvents and ReadDirectoryChangesW get one recursive watch of the root, plus one per directory outside it.

import { watch as fsWatch } from 'node:fs'
import { dirname, join } from 'node:path'

import { inside } from './dev-bundler.js'

const RECURSIVE = process.platform === 'darwin' || process.platform === 'win32'

// Calls `onChange(path)` on each relevant change; update(files) sets the files builds read.
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
    // The recursive watch counts only the build's directories. There, edits count only to files a build read
    // (a log written beside them mustn't rebuild); adds, removes and renames count for any, as they may change resolution.
    const seen = (event, path) => {
      if (deep && !dirs.has(dirname(path)) && !dirs.has(path)) return
      if (event === 'change' && !read.has(path)) return
      onChange(path)
    }
    try {
      const watcher = watch(dir, { persistent: false, recursive: deep }, (event, name) => seen(event, name === null ? dir : join(dir, String(name))))
      // A watch that fails (its directory removed, say) counts as a change.
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
      for (const dir of wanted) if (!watchers.has(dir)) add(dir)
    },
    close() {
      for (const watcher of watchers.values()) watcher.close()
      watchers.clear()
    },
  }
}
