import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { assertPackageName, assertPackageVersion, printable, show } from '../args.js'
import { readCache, readCacheJSON, writeCache, writeCacheJSON } from '../cache.js'
import { NPM_REGISTRY, buildUrl, request } from '../http.js'

async function getDist(name, version) {
  const json = await request(buildUrl(NPM_REGISTRY, [...name.split('/'), version]), { as: 'json' })
  assert.ok(json?.name === name && json.version === version, `getTarball: the registry answered for ${show(json?.name)}@${show(json?.version)}, not ${name}@${version}`)
  const { tarball, integrity } = json.dist ?? {}
  const expected = buildUrl(NPM_REGISTRY, [...name.split('/'), '-', `${name.split('/').at(-1)}-${version}.tgz`])
  assert.ok(tarball === expected, `getTarball: unexpected tarball URL for ${name}@${version}: ${show(tarball)}`)
  assert.ok(typeof integrity === 'string', `getTarball: no integrity for ${name}@${version}`)
  return { tarball, integrity }
}

// Only sha512: every version on the registry has one, so a sha1-only
// integrity is refused rather than trusted.
const SHA512_RE = /^sha512-(?<digest>[\dA-Za-z+/]{86}==)(?:\?[!-~]*)?$/u

function assertIntegrity(bytes, integrity, what) {
  const expected = integrity.split(/\s+/u).map((entry) => SHA512_RE.exec(entry)?.groups.digest).filter(Boolean)
  assert.ok(expected.length > 0, `getTarball: no sha512 integrity for ${what}: ${show(integrity)}`)
  const actual = createHash('sha512').update(bytes).digest('base64')
  assert.ok(expected.includes(actual), `getTarball: integrity mismatch for ${what}: expected ${printable(integrity)}, got sha512-${actual}`)
}

// The bytes, and beside them a `.json` with the integrity they were
// checked against. No expiry: the registry never takes a version twice.
const DIR = 'npm/tarballs'

// Whole entries are written only after checking, so a mismatch here is
// tampering or corruption: it throws rather than fetching over it.
async function readTarballCache(name, version) {
  const entry = await readCacheJSON(DIR, `${name}@${version}.json`)
  if (entry?.name !== name || entry.version !== version || typeof entry.integrity !== 'string') return null
  const bytes = await readCache(DIR, `${name}@${version}.tgz`)
  if (bytes === null) return null
  assertIntegrity(bytes, entry.integrity, `${name}@${version} from the cache`)
  return bytes
}

// Bytes first: the `.json` is what makes an entry.
async function writeTarballCache(name, version, bytes, integrity) {
  if (await writeCache(DIR, `${name}@${version}.tgz`, bytes)) {
    await writeCacheJSON(DIR, `${name}@${version}.json`, { name, version, integrity })
  }
}

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
