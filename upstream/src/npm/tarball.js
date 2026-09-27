import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { assertPackageName, assertPackageVersion, printable, show } from '../args.js'
import { readCache, writeCache } from '../cache.js'
import { NPM_REGISTRY, buildUrl, request } from '../http.js'

const DIR = 'npm/tarballs' // No expiry: the registry never takes a version twice.
// Only sha512: every version on the registry has one, so a sha1-only
// integrity is refused rather than trusted.
const SHA512_RE = /^sha512-(?<digest>[\dA-Za-z+/]{86}==)(?:\?[!-~]*)?$/u

async function getDist(name, version) {
  const segments = name.split('/')
  const json = await request(buildUrl(NPM_REGISTRY, [...segments, version]), { as: 'json' })
  assert.ok(json?.name === name && json.version === version, `getTarball: the registry answered for ${show(json?.name)}@${show(json?.version)}, not ${name}@${version}`)
  const { tarball, integrity } = json.dist ?? {}
  const expected = buildUrl(NPM_REGISTRY, [...segments, '-', `${segments.at(-1)}-${version}.tgz`])
  assert.ok(tarball === expected, `getTarball: unexpected tarball URL for ${name}@${version}: ${show(tarball)}`)
  assert.ok(typeof integrity === 'string', `getTarball: no integrity for ${name}@${version}`)
  return { tarball, integrity }
}

function assertIntegrity(bytes, integrity, what) {
  const expected = integrity.split(/\s+/u).map((entry) => SHA512_RE.exec(entry)?.groups.digest).filter(Boolean)
  assert.ok(expected.length > 0, `getTarball: no sha512 integrity for ${what}: ${show(integrity)}`)
  const actual = createHash('sha512').update(bytes).digest('base64')
  assert.ok(expected.includes(actual), `getTarball: integrity mismatch for ${what}: expected ${printable(integrity)}, got sha512-${actual}`)
}

// The version document is read every time, cache or not: bytes from the
// cache are checked against the registry's integrity, never against
// anything the cache itself holds. A mismatch there throws rather than
// fetching over it.
export async function getTarball(name, version) {
  assertPackageName('getTarball', 'name', name)
  assertPackageVersion('getTarball', 'version', version)
  const { tarball, integrity } = await getDist(name, version)
  const key = `${name}@${version}.tgz`
  const cached = await readCache(DIR, key)
  if (cached) {
    assertIntegrity(cached, integrity, `${name}@${version} from the cache`)
    return cached
  }
  const bytes = await request(tarball, { as: 'bytes' })
  assertIntegrity(bytes, integrity, `${name}@${version} from ${tarball}`)
  await writeCache(DIR, key, bytes)
  return bytes
}
