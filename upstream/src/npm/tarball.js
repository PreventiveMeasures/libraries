import { Buffer } from 'node:buffer'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { assertArgs, assertPackage, assertPackageName, isPlainObject, isSha, optional } from '../args.js'
import { assertCache } from '../cache.js'
import { verifiedDownload } from '../download.js'
import { getDocument, withNpmToken } from './registry.js'
import { checkedDist, fetchVersion, getDist } from './versions.js'

const DIR = 'npm/tarballs' // No expiry: the registry never takes a version twice.

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

// A call's options: `cache` alone.
const assertOptions = (method, options) => assertArgs(method, options, { cache: optional(assertCache) })

const own = (object, key) => (Object.hasOwn(object, key) ? object[key] : undefined)
const stringOr = (value) => (typeof value === 'string' ? value : undefined)

// A string as it is, or an object's strings under `keys`, the rest undefined:
// none where it is neither, or names none of them.
function linkOf(value, keys) {
  if (typeof value === 'string') return value
  if (!isPlainObject(value)) return undefined
  const link = Object.fromEntries(keys.map((key) => [key, stringOr(own(value, key))]))
  return keys.some((key) => link[key] !== undefined) ? link : undefined
}

// Fetched, as getDist fetches without an integrity: beside its dist, the
// document's gitHead where that is a full commit id, and its repository,
// homepage and bugs, in the shapes a package.json gives them. Each but dist
// is left out where there is none.
export async function getMeta(name, version, options = {}) {
  assertPackage('getMeta', name, version)
  assertOptions('getMeta', options)
  const { dist, json } = await fetchVersion('getMeta', name, version, options.cache)
  const about = {
    gitHead: isSha(own(json, 'gitHead')) ? json.gitHead : undefined,
    repository: linkOf(own(json, 'repository'), ['type', 'url', 'directory']),
    homepage: stringOr(own(json, 'homepage')),
    bugs: linkOf(own(json, 'bugs'), ['url', 'email']),
  }
  return { name, version, dist, ...Object.fromEntries(Object.entries(about).filter(([, value]) => value !== undefined)) }
}

// Only the whole package's document has `time`: megabytes for some.
const PUBLISHED = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,3}))?Z$/u
const record = (value) => (isPlainObject(value) ? value : {})

// A time toISOString writes back as given, its milliseconds padded: none
// Date.parse moves, as it moves 2018-02-29 to March.
function readTime(value) {
  const match = typeof value === 'string' ? PUBLISHED.exec(value) : null
  if (match === null) return undefined
  const iso = `${match[1]}.${(match[2] ?? '').padEnd(3, '0')}Z`
  const parsed = Date.parse(iso)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === iso ? iso : undefined
}

export async function getPublishTimes(name) {
  assertPackageName('getPublishTimes', 'name', name)
  const json = await getDocument('getPublishTimes', name)
  const time = record(json.time)
  const times = new Map()
  for (const version of Object.keys(record(json.versions))) {
    const at = readTime(Object.hasOwn(time, version) ? time[version] : undefined)
    if (at !== undefined) times.set(version, at)
  }
  return times
}

export async function verifyDist(name, version, dist, options = {}) {
  assertPackage('verifyDist', name, version)
  assertOptions('verifyDist', options)
  await getDist('verifyDist', name, version, checkedDist('verifyDist', name, version, dist).integrity, options.cache)
}

// Without `dist`, the version document is read every time, cache or not:
// bytes from a cache are checked against the registry's integrity, never
// against anything a cache itself holds.
export async function getTarball(name, version, dist, options = {}) {
  assertPackage('getTarball', name, version)
  assertOptions('getTarball', options)
  const { cache } = options
  const { tarball, integrity } = dist === undefined ? await getDist('getTarball', name, version, undefined, cache) : checkedDist('getTarball', name, version, dist)
  return await verifiedDownload({ method: 'getTarball', dir: DIR, what: `${name}@${version}`, ext: 'tgz', algorithm: 'sha512', expected: integrity, local: localPaths(name, version, integrity), ours: true, cache, locate: () => tarball, options: withNpmToken(name, tarball) })
}
