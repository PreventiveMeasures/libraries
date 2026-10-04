import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { readCache, readRegularFile, writeCache } from './cache.js'
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

// Bytes whose `algorithm` hash is `expected`, which the registry or the
// caller gives, never a disk; without it nothing is read. From `local`,
// other tools' caches (read, never written; a mismatch is passed over),
// else ours (a mismatch throws), else what `locate` answers, checked and
// then cached. `via` stands in for request(), as for NPM_TOKEN on the
// registry.
export async function verifiedDownload({ method, dir, what, ext, algorithm, expected, local = [], locate, options = {}, list, via = request }) {
  assert.ok(Object.hasOwn(DIGESTS, algorithm) && typeof expected === 'string' && expected !== '', `${method}: nothing to check ${what} against`)
  const digest = (bytes) => DIGESTS[algorithm](bytes, { expected, list })
  for (const path of local) {
    const bytes = await readRegularFile(path)
    if (bytes && await digest(bytes) === expected) return bytes
  }
  const check = async (bytes, from) => {
    const actual = await digest(bytes)
    assert.ok(actual === expected, `${method}: integrity mismatch for ${what} from ${from}: expected ${expected}, got ${actual}`)
    return bytes
  }
  const key = `${what}.${ext}`
  const cached = await readCache(dir, key)
  if (cached) return await check(cached, 'the cache')
  const url = await locate()
  const bytes = await check(await via(url, { ...options, as: 'bytes' }), url)
  await writeCache(dir, key, bytes)
  return bytes
}
