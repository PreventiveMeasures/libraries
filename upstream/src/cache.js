import assert from 'node:assert/strict'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

// Where cached answers live on disk, which is the caller's to decide and
// nobody else's: this package has no idea what the host is or where a
// deployment wants its cache. So there is no default and no environment
// variable read here.
//
// Unset, there is no cache at all: every read misses and every write is
// skipped, so a caller that never calls setCacheDir asks the network each
// time and leaves nothing behind on disk.
let root

export function setCacheDir(dir) {
  assert.ok(typeof dir === 'string' && dir.length > 0, 'setCacheDir: expected a directory path')
  root = dir
}

// One file in the cache: `dir` is where under the root a kind of record
// is filed — under the registry or API that answered it, since what a
// record means is a property of who was asked — and `key` names the
// record in it. The key goes through encodeURIComponent, so the `/` in a
// scoped package name, or a `..` in anything, stays part of one file name
// rather than making a directory of it. Null while there is no cache.
const cachePath = (dir, key) => (root === undefined ? null : join(root, dir, encodeURIComponent(key)))

// A record's bytes, or null for no cache or nothing readable there. What
// they have to be is the caller's to check: every answer but a usable
// record is a miss.
export async function readCache(dir, key) {
  const path = cachePath(dir, key)
  if (path === null) return null
  try {
    const bytes = await readFile(path)
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  } catch {
    return null
  }
}

export async function readCacheJSON(dir, key) {
  const path = cachePath(dir, key)
  if (path === null) return null
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

let tmpSeq = 0

// Written through a temp name and renamed into place, so a killed process
// cannot leave a truncated file that a later read would take for the
// record. A cache that cannot be written at all — none set, a read-only
// directory, a full disk — is a slower next call, not a failed one, so
// this never throws: false where it could not write.
export async function writeCache(dir, key, data) {
  const path = cachePath(dir, key)
  if (path === null) return false
  const tmp = `${path}.${process.pid}.${++tmpSeq}.tmp`
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(tmp, data)
    await rename(tmp, path)
  } catch {
    return false
  }
  return true
}

export async function writeCacheJSON(dir, key, value) {
  return await writeCache(dir, key, JSON.stringify(value))
}
