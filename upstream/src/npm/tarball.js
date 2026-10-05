import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { assertArgs, assertPackage, assertion, matches, show } from '../args.js'
import { verifiedDownload } from '../download.js'
import { NPM_REGISTRY, buildUrl } from '../http.js'
import { getDocument, withNpmToken } from './registry.js'

const DIR = 'npm/tarballs' // No expiry: the registry never takes a version twice.
// One sha512 and nothing else, as the registry writes it: a sha1, a second
// hash or an option is refused rather than trusted. 64 bytes leave the
// last character before `==` two bits, so only A, Q, g or w is canonical.
const assertIntegrity = assertion('"sha512-" and a base64 sha512', matches(/^sha512-[\dA-Za-z+/]{85}[AQgw]==$/u))

// `{ tarball, integrity }` and nothing else, the tarball exactly the
// registry's own URL for that version. Each field is read once, and only
// as the object's own, into a copy that is checked and used from then on:
// the caller's object can change while a request is out, and a field on
// its prototype is not one it has.
function checkedDist(method, name, version, dist) {
  assertArgs(method, dist, { tarball: null, integrity: null }, 'dist')
  const [tarball, integrity] = ['tarball', 'integrity'].map((key) => (Object.hasOwn(dist, key) ? dist[key] : undefined))
  assertIntegrity(method, 'dist.integrity', integrity)
  const segments = name.split('/')
  const expected = buildUrl(NPM_REGISTRY, [...segments, '-', `${segments.at(-1)}-${version}.tgz`])
  assert.ok(tarball === expected, `${method}: dist.tarball must be ${expected}, got ${show(tarball)}`)
  return { tarball, integrity }
}

async function getDist(method, name, version) {
  const json = await getDocument(method, name, version)
  assert.ok(json.version === version, `${method}: the registry answered for ${name}@${show(json.version)}, not ${name}@${version}`)
  return checkedDist(method, name, version, { tarball: json.dist?.tarball, integrity: json.dist?.integrity })
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

// npm 5+ (cacache) files a tarball by its sha512, npm 4 and before as
// <name>/<version>/package.tgz; ~/.audit as <org>:<name>-<version>.tgz.
function localPaths(name, version, integrity) {
  const hex = Buffer.from(integrity.slice('sha512-'.length), 'base64').toString('hex')
  const npm = npmCacheDirs().flatMap((root) => [join(root, '_cacache/content-v2/sha512', hex.slice(0, 2), hex.slice(2, 4), hex.slice(4)), join(root, name, version, 'package.tgz')])
  return [...npm, join(homedir(), '.audit/cache/tgz', `${name.replace(/^@/u, '').replace('/', ':')}-${version}.tgz`)]
}

export async function getMeta(name, version) {
  assertPackage('getMeta', name, version)
  return { name, version, dist: await getDist('getMeta', name, version) }
}

export async function verifyDist(name, version, dist) {
  assertPackage('verifyDist', name, version)
  const given = checkedDist('verifyDist', name, version, dist)
  const { integrity } = await getDist('verifyDist', name, version)
  assert.ok(given.integrity === integrity, `verifyDist: ${name}@${version} is ${integrity} on the registry, not ${given.integrity}`)
}

// Without `dist`, the version document is read every time, cache or not:
// bytes from a cache are checked against the registry's integrity, never
// against anything a cache itself holds.
export async function getTarball(name, version, dist) {
  assertPackage('getTarball', name, version)
  const { tarball, integrity } = dist === undefined ? await getDist('getTarball', name, version) : checkedDist('getTarball', name, version, dist)
  return await verifiedDownload({ method: 'getTarball', dir: DIR, what: `${name}@${version}`, ext: 'tgz', algorithm: 'sha512', expected: integrity, local: localPaths(name, version, integrity), ours: true, locate: () => tarball, options: withNpmToken(name, tarball) })
}
