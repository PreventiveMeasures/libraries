// The project, the lockfile's directory, as a Vfs or anything with its
// methods, by paths from `/`; it is only read, and only where a builder says.

import { DeptreeError, quote } from './error.js'

export function checkProject(project) {
  if (['readdir', 'lstat', 'stat', 'readFile'].some((name) => typeof project?.[name] !== 'function')) {
    throw new TypeError('project must be a Vfs, or have its readdir, lstat, stat and readFile')
  }
}

const NOWHERE = new Set(['ENOENT', 'ENOTDIR', 'ELOOP'])
export function typeOf(project, path, follow = true) {
  try {
    return (follow ? project.stat(path) : project.lstat(path)).type
  } catch (error) {
    if (NOWHERE.has(error?.code)) return undefined
    throw error
  }
}

// A BOM is kept, as in text handed in, for the reader to drop as pnpm does.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export function readBytes(project, path) {
  const bytes = project.readFile(path)
  if (!(bytes instanceof Uint8Array)) throw new TypeError('project.readFile must give back bytes')
  return bytes
}

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
