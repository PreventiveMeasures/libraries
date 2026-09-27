import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { readCache, readCacheJSON, writeCache, writeCacheJSON } from '../cache.js'
import { REGISTRY, assertPackageName, assertPackageVersion } from './registry.js'

// A published version's tarball, whole, in memory: the `.tgz` bytes as
// the registry serves them, checked against the `dist.integrity` the
// registry publishes for that version — on the way in from the network,
// before anything is written to the cache, and again on every load from
// it.

// The version's own document rather than the packument: `dist` is all
// that is read, and the full document is megabytes of every other
// version.
async function getDist(name, version) {
  assertPackageName(name)
  assertPackageVersion(version)
  const res = await fetch(`${REGISTRY}/${name}/${version}`)
  assert.ok(res.ok, `Failed to fetch ${name}@${version} from npm: ${res.status}`)
  const json = await res.json()
  assert.equal(json.name, name)
  assert.equal(json.version, version)
  const { tarball, integrity } = json.dist ?? {}
  // Taken from `dist`, but only where it is exactly the URL the registry
  // files this version's tarball under, checked before anything is
  // downloaded: never another host, another package or another version.
  const expected = `${REGISTRY}/${name}/-/${name.split('/').at(-1)}-${version}.tgz`
  assert.equal(tarball, expected, `Unexpected tarball URL for ${name}@${version}: ${tarball}`)
  assert.ok(typeof integrity === 'string', `No integrity for ${name}@${version}`)
  return { tarball, integrity }
}

// SRI, as npm writes it: space-separated `<algorithm>-<base64>` entries,
// each optionally followed by `?options`. Only sha512 is read — every
// version on the registry carries one, back to the oldest — so a
// document offering nothing stronger than sha1 is refused rather than
// checked with the weaker hash. Any one sha512 entry matching is a match,
// as SRI has it.
function assertIntegrity(bytes, integrity, what) {
  const expected = integrity.split(/\s+/u)
    .filter((entry) => entry.startsWith('sha512-'))
    .map((entry) => entry.slice('sha512-'.length).split('?')[0])
  assert.ok(expected.length > 0, `No sha512 integrity for ${what}: ${integrity}`)
  const actual = createHash('sha512').update(bytes).digest('base64')
  assert.ok(expected.includes(actual), `Integrity mismatch for ${what}: expected ${integrity}, got sha512-${actual}`)
}

// Filed under npm/tarballs, beside the repo links: `<name>@<version>.tgz`
// holding the bytes, and `<name>@<version>.json` beside it holding the
// integrity they were checked against, so a load checks them again
// without asking the registry anything. A published version's tarball
// never changes — the registry refuses to take a version twice — so an
// entry does not expire.
const DIR = 'npm/tarballs'

// Null for a miss: no cache, no entry, half of one, or a record that is
// not one this writes. An entry that IS whole but whose bytes do not
// match the integrity filed with them is not a miss: both halves were
// checked before they were written and each was renamed into place
// whole, so something other than this changed them. That throws, rather
// than quietly fetching over whatever did.
async function readTarballCache(name, version) {
  const entry = await readCacheJSON(DIR, `${name}@${version}.json`)
  if (entry?.name !== name || entry.version !== version || typeof entry.integrity !== 'string') return null
  const bytes = await readCache(DIR, `${name}@${version}.tgz`)
  if (bytes === null) return null
  assertIntegrity(bytes, entry.integrity, `${name}@${version} from the cache`)
  return bytes
}

// The bytes first and the integrity after, since the `.json` is what
// makes an entry: a process killed between the two leaves bytes nothing
// reads, never an entry whose bytes are missing.
async function writeTarballCache(name, version, bytes, integrity) {
  if (await writeCache(DIR, `${name}@${version}.tgz`, bytes)) {
    await writeCacheJSON(DIR, `${name}@${version}.json`, { name, version, integrity })
  }
}

// The cache first, when setCacheDir has named one; the registry after,
// and only bytes that match the published integrity are written back or
// returned.
export async function getTarball(name, version) {
  assertPackageName(name)
  assertPackageVersion(version)
  const cached = await readTarballCache(name, version)
  if (cached) return cached
  const { tarball, integrity } = await getDist(name, version)
  const res = await fetch(tarball)
  assert.ok(res.ok, `Failed to fetch ${tarball}: ${res.status}`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  assertIntegrity(bytes, integrity, `${name}@${version} from ${tarball}`)
  await writeTarballCache(name, version, bytes, integrity)
  return bytes
}
