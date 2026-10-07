import { Buffer } from 'node:buffer'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { assertArgs, assertPackage, assertPackageName, isPlainObject, isSha, optional } from '../args.js'
import { assertCache } from '../cache.js'
import { verifiedDownload } from '../download.js'
import { NPM_REGISTRY, decode } from '../http.js'
import { readNpmCached } from './cacache.js'
import { getDocument, withNpmToken } from './registry.js'
import { checkedDist, getVersion, matchingDist } from './versions.js'

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

// verifyDist's and getTarball's options: `cache` alone.
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

const mediaType = (value) => (typeof value === 'string' ? value.split(';')[0].trim().toLowerCase() : undefined)

function jsonOf(bytes, from) {
  try {
    return JSON.parse(decode(bytes, from))
  } catch {
    return undefined
  }
}

// A version as npm's own cache keeps it, where it keeps its name's full
// packument, as npm 10 and later fetch it, whose entry for the version
// matches `given` (matchingDist): that entry is the version's document. An
// abbreviated packument, as earlier npm fetches, has none of the rest
// getMeta answers, and is passed over.
async function npmCachedVersion(name, version, given) {
  const url = `${NPM_REGISTRY}/${name.replace('/', '%2f')}`
  for (const root of npmCacheDirs()) {
    const cached = await readNpmCached(join(root, '_cacache'), url)
    if (!cached || mediaType(cached.metadata?.resHeaders?.['content-type']) !== 'application/json') continue
    const packument = jsonOf(cached.body, url)
    const json = packument?.name === name && isPlainObject(packument.versions) ? own(packument.versions, version) : undefined
    const dist = matchingDist('getMeta', name, version, json, given)
    if (dist) return { dist, json }
  }
  return undefined
}

// The version's document: with the `dist` the caller has, npm's own cache's
// where it matches (npmCachedVersion), and neither `cache` nor the cache
// set is read or written; else as getVersion has it. Beside its dist, the
// document's gitHead where that is a full commit id, and its repository,
// homepage and bugs, in the shapes a package.json gives them. Each but
// dist is left out where there is none.
export async function getMeta(name, version, options = {}) {
  assertPackage('getMeta', name, version)
  assertArgs('getMeta', options, { dist: null, cache: optional(assertCache) })
  const given = options.dist === undefined ? undefined : checkedDist('getMeta', name, version, options.dist)
  const { dist, json } = (given && await npmCachedVersion(name, version, given)) ?? await getVersion('getMeta', name, version, given, options.cache)
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
  await getVersion('verifyDist', name, version, checkedDist('verifyDist', name, version, dist), options.cache)
}

// Without `dist`, the version document is read every time, cache or not:
// bytes from a cache are checked against the registry's integrity, never
// against anything a cache itself holds.
export async function getTarball(name, version, dist, options = {}) {
  assertPackage('getTarball', name, version)
  assertOptions('getTarball', options)
  const { cache } = options
  const { tarball, integrity } = dist === undefined ? (await getVersion('getTarball', name, version, undefined, cache)).dist : checkedDist('getTarball', name, version, dist)
  return await verifiedDownload({ method: 'getTarball', dir: DIR, what: `${name}@${version}`, ext: 'tgz', algorithm: 'sha512', expected: integrity, local: localPaths(name, version, integrity), ours: true, cache, locate: () => tarball, options: withNpmToken(name, tarball) })
}
