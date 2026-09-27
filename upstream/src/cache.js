import assert from 'node:assert/strict'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { assertDirectoryPath } from './args.js'
import { decode } from './http.js'

const DIRS = new Set(['npm/repos', 'npm/tarballs'])

let root
let tmpSeq = 0

export function setCacheDir(dir) {
  assertDirectoryPath('setCacheDir', 'dir', dir)
  root = resolve(dir)
}

// URI-encoded, so a `/` or `..` in a key stays inside one file name.
function cachePath(dir, key) {
  assert.ok(DIRS.has(dir) && key && typeof key === 'string', `Unexpected cache entry: ${dir}`)
  return root === undefined ? null : join(root, dir, encodeURIComponent(key))
}

export async function readCache(dir, key) {
  const path = cachePath(dir, key)
  return path && await readFile(path).then((bytes) => new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), () => null)
}

export async function readCacheJSON(dir, key) {
  const bytes = await readCache(dir, key)
  try {
    return bytes && JSON.parse(decode(bytes, key))
  } catch {
    return null
  }
}

export async function writeCache(dir, key, data) {
  const path = cachePath(dir, key)
  if (path === null) return false
  const tmp = `${path}.${process.pid}.${++tmpSeq}.tmp`
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(tmp, data)
    await rename(tmp, path)
    return true
  } catch {
    await rm(tmp, { force: true }).catch(() => {})
    return false
  }
}

export async function writeCacheJSON(dir, key, value) {
  return await writeCache(dir, key, JSON.stringify(value))
}
