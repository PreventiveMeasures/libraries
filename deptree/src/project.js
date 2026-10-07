// The project, the lockfile's directory, as a Vfs or anything with its
// methods, by paths from `/`; it is only read, and only where a builder says.

import { utf8toString } from '@exodus/bytes/utf8.js'
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

// `bytes` as text, refused with `detail` where they are not UTF-8. A BOM is
// kept, as in text handed in, for the reader to drop as pnpm does.
export function decodeUtf8(bytes, detail, where) {
  try {
    return utf8toString(bytes)
  } catch {
    throw new DeptreeError(detail, where)
  }
}

export function readBytes(project, path) {
  const bytes = project.readFile(path)
  if (!(bytes instanceof Uint8Array)) throw new TypeError('project.readFile must give back bytes')
  return bytes
}

export function readText(project, path, where) {
  const type = typeOf(project, path)
  if (type === undefined) return undefined
  if (type !== 'file') throw new DeptreeError(`${quote(path.slice(1))} is a ${type}, not a file`, where)
  return decodeUtf8(readBytes(project, path), `${quote(path.slice(1))} is not UTF-8`, where)
}

// The checks each manager's checkHost and inputsOf make alike.
export function checkHostKeys(host, keys, wanted) {
  if (host === null || typeof host !== 'object') throw new TypeError(`host must be an object with ${wanted}`)
  for (const key of keys) if (typeof host[key] !== 'string' || host[key] === '') throw new TypeError(`host.${key} must be a non-empty string`)
}
export function checkLeftOut(values, all = 'both') {
  for (const [name, value] of Object.entries(values)) if (value !== undefined) throw new TypeError(`${name} must be left out where lockfile is: ${all} are read from project`)
}
export function checkTexts(values) {
  for (const [name, value] of Object.entries(values)) if (value !== undefined && typeof value !== 'string') throw new TypeError(`${name} must be a string, or left out`)
}
