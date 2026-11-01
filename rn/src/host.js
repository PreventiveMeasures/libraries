// What the resolver and the asset readers read a tree through: the disk by
// default, or anything with the same five synchronous calls. A Vfs from
// @preventive/vfs has them as they are. Paths are absolute, as node:path
// spells them; a file and a directory are what a link leads to.

import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'

const kind = (path) => {
  try {
    return statSync(path, { throwIfNoEntry: false }) ?? null
  } catch {
    return null // ENOTDIR, ELOOP, EACCES: nothing there to resolve to
  }
}

export const diskHost = Object.freeze({
  isFile: (path) => kind(path)?.isFile() ?? false,
  isDirectory: (path) => kind(path)?.isDirectory() ?? false,
  realpath: (path) => realpathSync(path),
  readFile: (path) => readFileSync(path),
  readdir: (path) => readdirSync(path),
})
