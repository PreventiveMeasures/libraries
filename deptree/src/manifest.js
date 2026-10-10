// A package.json as pnpm, yarn 1 and npm read one, a byte order mark dropped.

import { DeptreeError, quote } from './error.js'
import { isInside } from './mount.js'

// A package.json is a few levels deep. One far deeper is refused where it is
// read, and again where it is copied whole, as structuredClone, which
// recurses, runs out of stack on one some thousands deep.
const DEEPEST = 100

export function checkNesting(value, where) {
  const pending = [[value, 0]]
  while (pending.length > 0) {
    const [item, depth] = pending.pop()
    if (item === null || typeof item !== 'object') continue
    if (depth === DEEPEST) throw new DeptreeError(`nested more than ${DEEPEST} deep, which is not supported`, where)
    for (const child of Object.values(item)) pending.push([child, depth + 1])
  }
  return value
}

// What a package.json's mapping has under `key` of its own. JSON.parse makes
// plain objects, which have `constructor` and `toString` from
// Object.prototype under names a package may have.
export const own = (map, key) => (map != null && Object.hasOwn(map, key) ? map[key] : undefined)

export function readManifest(text, where) {
  if (typeof text !== 'string') throw new TypeError(`${where} must be the text of a package.json`)
  let manifest
  try {
    manifest = JSON.parse(text.replace(/^\uFEFF/u, ''))
  } catch (error) {
    throw new DeptreeError(`not JSON: ${error.message}`, where, { cause: error })
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) throw new DeptreeError('expected an object', where)
  return checkNesting(manifest, where)
}

// The package.json texts given by directory, in a Map or a Record: the
// project's, and its workspaces', each in a directory under it, as one
// found in a project is. A workspace's dependencies are written in its
// directory, and a link made to it.
export function readManifests(texts) {
  const read = new Map()
  for (const [dir, text] of texts instanceof Map ? texts : Object.entries(texts)) {
    const where = `manifests[${quote(dir)}]`
    if (dir !== '.' && !isInside(dir)) throw new DeptreeError('expected "." or a directory under the project\'s, by its path from there in normal form', where)
    read.set(dir, readManifest(text, where))
  }
  if (!read.has('.')) throw new DeptreeError('the root package.json is not given', 'manifests["."]')
  return read
}
