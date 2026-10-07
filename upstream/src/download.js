import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { ourCachePaths, readCache, readRegularFile, writeCache } from './cache.js'
import { request } from './http.js'
import { gitTreeOfTarball } from './tree.js'

// A hash as each registry writes it: npm's integrity, one sha512 in base64
// after `sha512-`; crates.io's and Soldeer's checksum, a sha256 in hex; a
// git tree id for a tarball of that tree.
const DIGESTS = {
  sha512: (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
  sha256: (bytes) => createHash('sha256').update(bytes).digest('hex'),
  tree: gitTreeOfTarball,
}

// A copy of bytes, a Buffer's included, whose slice() is a view; anything
// else as it is.
const copied = (value) => (value instanceof Uint8Array ? new Uint8Array(value) : value)

// Bytes whose `algorithm` hash is `expected`, which the registry or the
// caller gives, never a disk; without it nothing is read. From `local`,
// other tools' caches, and with `ours` our default cache and stasis's,
// whether set or not (read, never written; a mismatch is passed over),
// else the cache set, or with `store` the caller's store in its place, as
// `dir` and `what` (a mismatch throws; from a store, what is not bytes is
// a miss), else what `locate` answers, checked and then cached there, but
// with `store` false, not cached.
export async function verifiedDownload({ method, dir, what, ext, algorithm, expected, local = [], ours = false, store, locate, options = {}, list }) {
  assert.ok(Object.hasOwn(DIGESTS, algorithm) && typeof expected === 'string' && expected !== '', `${method}: nothing to check ${what} against`)
  const digest = (bytes) => DIGESTS[algorithm](bytes, { expected, list })
  const key = `${what}.${ext}`
  for (const path of ours ? [...local, ...ourCachePaths(dir, key)] : local) {
    const bytes = await readRegularFile(path)
    if (bytes && await digest(bytes) === expected) return bytes
  }
  const check = async (bytes, from) => {
    const actual = await digest(bytes)
    assert.ok(actual === expected, `${method}: integrity mismatch for ${what} from ${from}: expected ${expected}, got ${actual}`)
    return bytes
  }
  // A store may keep what it is given and answer what it keeps: bytes
  // cross as a copy, so the caller's are never the store's.
  const cached = store ? copied(await store.read(dir, what)) : await readCache(dir, key)
  if (cached instanceof Uint8Array) return await check(cached, store ? 'the store' : 'the cache')
  const url = await locate()
  const bytes = await check(await request(url, { ...options, as: 'bytes' }), url)
  if (store) await store.write(dir, what, new Uint8Array(bytes))
  else if (store !== false) await writeCache(dir, key, bytes)
  return bytes
}
