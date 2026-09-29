import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'

import { readCache, writeCache } from './cache.js'
import { MAX_BYTES, request } from './http.js'

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

// Only a regular file: a FIFO or a device would block or never end.
async function readRegularFile(path) {
  const stats = await stat(path).catch(() => null)
  if (!stats?.isFile() || stats.size > MAX_BYTES) return null
  return await readFile(path).then((bytes) => new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), () => null)
}

// Bytes whose `digest` is `expected`, from the first that has them of:
// `local`, other tools' caches, read and never written, where a file that
// does not match is passed over; ours, where one that does not match
// throws rather than being fetched over; and the URL `locate` answers,
// checked before it is cached.
export async function verifiedDownload({ method, dir, what, ext, digest, expected, local = [], locate }) {
  for (const path of local) {
    const bytes = await readRegularFile(path)
    if (bytes && digest(bytes) === expected) return bytes
  }
  const check = (bytes, from) => {
    const actual = digest(bytes)
    assert.ok(actual === expected, `${method}: integrity mismatch for ${what} from ${from}: expected ${expected}, got ${actual}`)
    return bytes
  }
  const key = `${what}.${ext}`
  const cached = await readCache(dir, key)
  if (cached) return check(cached, 'the cache')
  const url = await locate()
  const bytes = check(await request(url, { as: 'bytes' }), url)
  await writeCache(dir, key, bytes)
  return bytes
}
