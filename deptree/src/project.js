// The project a tree is built for: a view of the lockfile's directory, by
// paths from `/` — a Vfs, or anything with its readdir, lstat, stat and
// readFile, such as one of a directory on disk. It is only read, and only
// where each builder says it reads it (pnpm/project.js, yarn1/inputs.js,
// soldeer/inputs.js).

import { DeptreeError, quote } from './error.js'

export function checkProject(project) {
  if (['readdir', 'lstat', 'stat', 'readFile'].some((name) => typeof project?.[name] !== 'function')) {
    throw new TypeError('project must be a Vfs, or have its readdir, lstat, stat and readFile')
  }
}

// What `path` leads to, links followed, or where `follow` is false, what
// it is; nothing, where it leads nowhere: to no entry, through a file, or
// round a loop of links. Any other failure is thrown.
const NOWHERE = new Set(['ENOENT', 'ENOTDIR', 'ELOOP'])
export function typeOf(project, path, follow = true) {
  try {
    return (follow ? project.stat(path) : project.lstat(path)).type
  } catch (error) {
    if (NOWHERE.has(error?.code)) return undefined
    throw error
  }
}

// As text handed in would be: a byte order mark kept, for what reads it
// to drop as pnpm does.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

// The bytes of the file at `path`, as a Vfs gives them back.
export function readBytes(project, path) {
  const bytes = project.readFile(path)
  if (!(bytes instanceof Uint8Array)) throw new TypeError('project.readFile must give back bytes')
  return bytes
}

// The text of the file at `path`, or undefined where nothing is.
export function readText(project, path, where) {
  const type = typeOf(project, path)
  if (type === undefined) return undefined
  if (type !== 'file') throw new DeptreeError(`${quote(path.slice(1))} is a ${type}, not a file`, where)
  const bytes = readBytes(project, path)
  try {
    return decoder.decode(bytes)
  } catch {
    throw new DeptreeError(`${quote(path.slice(1))} is not UTF-8`, where)
  }
}
