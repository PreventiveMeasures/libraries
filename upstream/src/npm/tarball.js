import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { assertArgs, assertPackageName, assertPackageVersion, assertion, matches, show } from '../args.js'
import { readCache, writeCache } from '../cache.js'
import { MAX_BYTES, NPM_REGISTRY, buildUrl, request } from '../http.js'

const DIR = 'npm/tarballs' // No expiry: the registry never takes a version twice.
// One sha512 and nothing else, as the registry writes it: a sha1, a second
// hash or an option is refused rather than trusted.
const assertIntegrity = assertion('"sha512-" and a base64 sha512', matches(/^sha512-[\dA-Za-z+/]{86}==$/u))
const sha512 = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`

function assertPackage(method, name, version) {
  assertPackageName(method, 'name', name)
  assertPackageVersion(method, 'version', version)
}

function tarballUrl(name, version) {
  const segments = name.split('/')
  return buildUrl(NPM_REGISTRY, [...segments, '-', `${segments.at(-1)}-${version}.tgz`])
}

// `{ tarball, integrity }` and nothing else, the tarball exactly the
// registry's own URL for that version.
function assertDist(method, name, version, dist) {
  assertArgs(method, dist, { tarball: null, integrity: assertIntegrity }, 'dist')
  const expected = tarballUrl(name, version)
  assert.ok(dist.tarball === expected, `${method}: dist.tarball must be ${expected}, got ${show(dist.tarball)}`)
}

async function getDist(method, name, version) {
  const json = await request(buildUrl(NPM_REGISTRY, [...name.split('/'), version]), { as: 'json' })
  assert.ok(json?.name === name && json.version === version, `${method}: the registry answered for ${show(json?.name)}@${show(json?.version)}, not ${name}@${version}`)
  const dist = { tarball: json.dist?.tarball, integrity: json.dist?.integrity }
  assertDist(method, name, version, dist)
  return dist
}

function assertBytes(bytes, integrity, what) {
  const actual = sha512(bytes)
  assert.ok(actual === integrity, `getTarball: integrity mismatch for ${what}: expected ${integrity}, got ${actual}`)
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
async function readLocalCaches(name, version, integrity) {
  const hex = Buffer.from(integrity.slice('sha512-'.length), 'base64').toString('hex')
  const npm = npmCacheDirs().flatMap((root) => [join(root, '_cacache/content-v2/sha512', hex.slice(0, 2), hex.slice(2, 4), hex.slice(4)), join(root, name, version, 'package.tgz')])
  const audit = join(homedir(), '.audit/cache/tgz', `${name.replace(/^@/u, '').replace('/', ':')}-${version}.tgz`)
  for (const path of [...npm, audit]) {
    const bytes = await readRegularFile(path)
    if (bytes && sha512(bytes) === integrity) return bytes
  }
  return null
}

export async function getMeta(name, version) {
  assertPackage('getMeta', name, version)
  return { name, version, dist: await getDist('getMeta', name, version) }
}

export async function verifyDist(name, version, dist) {
  assertPackage('verifyDist', name, version)
  assertDist('verifyDist', name, version, dist)
  const { integrity } = await getDist('verifyDist', name, version)
  assert.ok(dist.integrity === integrity, `verifyDist: ${name}@${version} is ${integrity} on the registry, not ${dist.integrity}`)
}

// Without `dist`, the version document is read every time, cache or not:
// bytes from a cache are checked against the registry's integrity, never
// against anything a cache itself holds. A mismatch in ours throws rather
// than fetching over it.
export async function getTarball(name, version, dist) {
  assertPackage('getTarball', name, version)
  if (dist === undefined) dist = await getDist('getTarball', name, version)
  else assertDist('getTarball', name, version, dist)
  const local = await readLocalCaches(name, version, dist.integrity)
  if (local) return local
  const key = `${name}@${version}.tgz`
  const cached = await readCache(DIR, key)
  if (cached) {
    assertBytes(cached, dist.integrity, `${name}@${version} from the cache`)
    return cached
  }
  const bytes = await request(dist.tarball, { as: 'bytes' })
  assertBytes(bytes, dist.integrity, `${name}@${version} from ${dist.tarball}`)
  await writeCache(DIR, key, bytes)
  return bytes
}
