import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { assertPackageName, assertPackageVersion, printable, show } from '../args.js'
import { readCache, readCacheJSON, writeCache, writeCacheJSON } from '../cache.js'
import { NPM_REGISTRY, buildUrl, request } from '../http.js'

// A published version's tarball, whole, in memory: the `.tgz` bytes as
// the registry serves them, checked against the `dist.integrity` the
// registry publishes for that version — on the way in from the network,
// before anything is written to the cache, and again on every load from
// it.

// The version's own document rather than the packument: `dist` is all
// that is read, and the full document is megabytes of every other
// version. Only called with a name and version getTarball has checked.
async function getDist(name, version) {
  const json = await request(buildUrl(NPM_REGISTRY, [...name.split('/'), version]), { as: 'json' })
  assert.ok(json?.name === name && json.version === version, `getTarball: the registry answered for ${show(json?.name)}@${show(json?.version)}, not ${name}@${version}`)
  const { tarball, integrity } = json.dist ?? {}
  // Taken from `dist`, but only where it is exactly the URL the registry
  // files this version's tarball under, checked before anything is
  // downloaded: never another host, another package or another version.
  const expected = buildUrl(NPM_REGISTRY, [...name.split('/'), '-', `${name.split('/').at(-1)}-${version}.tgz`])
  assert.ok(tarball === expected, `getTarball: unexpected tarball URL for ${name}@${version}: ${show(tarball)}`)
  assert.ok(typeof integrity === 'string', `getTarball: no integrity for ${name}@${version}`)
  return { tarball, integrity }
}

// SRI, as npm writes it: space-separated `<algorithm>-<base64>` entries,
// each optionally followed by `?options`. Only sha512 is read — every
// version on the registry carries one, back to the oldest — so a
// document offering nothing stronger than sha1 is refused rather than
// checked with the weaker hash. A sha512 entry has to be one: 64 bytes,
// in base64. Any one of them matching is a match, as SRI has it.
const SHA512_RE = /^sha512-(?<digest>[\dA-Za-z+/]{86}==)(?:\?[!-~]*)?$/u

function assertIntegrity(bytes, integrity, what) {
  const expected = integrity.split(/\s+/u).map((entry) => SHA512_RE.exec(entry)?.groups.digest).filter(Boolean)
  assert.ok(expected.length > 0, `getTarball: no sha512 integrity for ${what}: ${show(integrity)}`)
  const actual = createHash('sha512').update(bytes).digest('base64')
  assert.ok(expected.includes(actual), `getTarball: integrity mismatch for ${what}: expected ${printable(integrity)}, got sha512-${actual}`)
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
  assertPackageName('getTarball', 'name', name)
  assertPackageVersion('getTarball', 'version', version)
  const cached = await readTarballCache(name, version)
  if (cached) return cached
  const { tarball, integrity } = await getDist(name, version)
  const bytes = await request(tarball, { as: 'bytes' })
  assertIntegrity(bytes, integrity, `${name}@${version} from ${tarball}`)
  await writeTarballCache(name, version, bytes, integrity)
  return bytes
}
