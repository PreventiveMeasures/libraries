import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { assertPackageName, assertPackageVersion, show } from '../args.js'
import { readCache, writeCache } from '../cache.js'
import { MAX_BYTES, NPM_REGISTRY, buildUrl, request } from '../http.js'

const DIR = 'npm/tarballs' // No expiry: the registry never takes a version twice.
// Only sha512: every version on the registry has one, so a sha1-only
// integrity is refused rather than trusted.
const SHA512_RE = /^sha512-(?<digest>[\dA-Za-z+/]{86}==)(?:\?[!-~]*)?$/u
const sha512 = (bytes) => createHash('sha512').update(bytes).digest('base64')

async function getDist(name, version) {
  const segments = name.split('/')
  const json = await request(buildUrl(NPM_REGISTRY, [...segments, version]), { as: 'json' })
  assert.ok(json?.name === name && json.version === version, `getTarball: the registry answered for ${show(json?.name)}@${show(json?.version)}, not ${name}@${version}`)
  const { tarball, integrity } = json.dist ?? {}
  const expected = buildUrl(NPM_REGISTRY, [...segments, '-', `${segments.at(-1)}-${version}.tgz`])
  assert.ok(tarball === expected, `getTarball: unexpected tarball URL for ${name}@${version}: ${show(tarball)}`)
  assert.ok(typeof integrity === 'string', `getTarball: no integrity for ${name}@${version}`)
  const digests = integrity.split(/\s+/u).map((entry) => SHA512_RE.exec(entry)?.groups.digest).filter(Boolean)
  assert.ok(digests.length > 0, `getTarball: no sha512 integrity for ${name}@${version}: ${show(integrity)}`)
  return { tarball, digests }
}

function assertIntegrity(bytes, digests, what) {
  const actual = sha512(bytes)
  assert.ok(digests.includes(actual), `getTarball: integrity mismatch for ${what}: expected sha512-${digests.join(' sha512-')}, got sha512-${actual}`)
}

// Where npm keeps its cache, short of an .npmrc moving it: npm_config_cache,
// as npm sets it for what it runs, else npm's default. On Windows, npm 4
// and before defaulted to %APPDATA%, later ones to %LOCALAPPDATA%.
function npmCacheDirs() {
  const configured = process.env.npm_config_cache || process.env.NPM_CONFIG_CACHE
  if (configured) return [resolve(configured.replace(/^~(?=[/\\])/u, homedir()))]
  if (process.platform !== 'win32') return [join(homedir(), '.npm')]
  return [process.env.LOCALAPPDATA, process.env.APPDATA].map((dir) => join(dir || homedir(), 'npm-cache'))
}

// Only a regular file: a FIFO or a device would block or never end.
async function readRegularFile(path) {
  const stats = await stat(path).catch(() => null)
  if (!stats?.isFile() || stats.size > MAX_BYTES) return null
  return await readFile(path).then((bytes) => new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), () => null)
}

// npm 5+ (cacache) files a tarball by its sha512, npm 4 and before as
// <name>/<version>/package.tgz; ~/.audit as <org>:<name>-<version>.tgz.
async function readLocalCaches(name, version, digests) {
  const hexes = digests.map((digest) => Buffer.from(digest, 'base64').toString('hex'))
  const npm = npmCacheDirs().flatMap((root) => [...hexes.map((hex) => join(root, '_cacache/content-v2/sha512', hex.slice(0, 2), hex.slice(2, 4), hex.slice(4))), join(root, name, version, 'package.tgz')])
  const audit = join(homedir(), '.audit/cache/tgz', `${name.replace(/^@/u, '').replace('/', ':')}-${version}.tgz`)
  for (const path of [...npm, audit]) {
    const bytes = await readRegularFile(path)
    if (bytes && digests.includes(sha512(bytes))) return bytes
  }
  return null
}

// The version document is read every time, cache or not: bytes from a
// cache are checked against the registry's integrity, never against
// anything a cache itself holds. A mismatch in ours throws rather than
// fetching over it.
export async function getTarball(name, version) {
  assertPackageName('getTarball', 'name', name)
  assertPackageVersion('getTarball', 'version', version)
  const dist = await getDist(name, version)
  const local = await readLocalCaches(name, version, dist.digests)
  if (local) return local
  const key = `${name}@${version}.tgz`
  const cached = await readCache(DIR, key)
  if (cached) {
    assertIntegrity(cached, dist.digests, `${name}@${version} from the cache`)
    return cached
  }
  const bytes = await request(dist.tarball, { as: 'bytes' })
  assertIntegrity(bytes, dist.digests, `${name}@${version} from ${dist.tarball}`)
  await writeCache(DIR, key, bytes)
  return bytes
}
