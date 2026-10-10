import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { gunzip, gzip } from 'node:zlib'

import { assertCacheName, assertDirectoryPath, assertion, isRepo } from './args.js'
import { MAX_BYTES, decode } from './http.js'
import { pool } from './pool.js'

const DIRS = new Set(['npm/repos', 'npm/tarballs', 'npm/versions', 'cargo/repos', 'cargo/crates', 'composer/repos', 'soldeer/repos', 'soldeer/zips', 'github/trees', 'github/advisories'])
const RECORD_TTL_MS = 30 * 24 * 60 * 60 * 1000 // A link only moves on a transfer or rename, and GitHub redirects those.
const RECORDS_AT_ONCE = 8
// JSON filed gzipped, as `<name>.json.gz`: a listing carries each
// advisory's full text, Markdown that compresses well, and a version
// document all npm has of that version.
const GZIP_DIRS = new Set(['github/advisories', 'npm/versions'])
const compress = promisify(gzip)
const decompress = promisify(gunzip)

// An environment variable may hold anything: only an absolute path is one.
const absolute = (path) => (typeof path === 'string' && isAbsolute(path) ? path : undefined)
const within = (base, ...names) => (base === undefined ? undefined : join(base, ...names))

// os.homedir() takes $HOME as it is, relative or empty, and throws where
// neither it nor the user's passwd entry has one.
function home() {
  try {
    return absolute(homedir())
  } catch {
    return undefined
  }
}

// Only Linux and the BSDs follow the XDG Base Directory spec, so macOS and
// Windows take no XDG_CACHE_HOME, as Go's os.UserCacheDir and Rust's dirs
// take none.
export function cacheDirFor(name) {
  assertCacheName('cacheDirFor', 'name', name)
  if (process.platform === 'darwin') return within(home(), 'Library', 'Caches', name)
  if (process.platform === 'win32') return within(absolute(process.env.LOCALAPPDATA) ?? within(home(), 'AppData', 'Local'), name, 'Cache')
  return within(absolute(process.env.XDG_CACHE_HOME) ?? within(home(), '.cache'), name)
}

export const defaultCacheDir = cacheDirFor('PreventiveMeasures')

let root
let tmpSeq = 0

export function setCacheDir(dir = defaultCacheDir) {
  if (dir === false) {
    root = undefined
    return
  }
  assert.ok(dir !== undefined, 'setCacheDir: there is no default cache directory, as no absolute home directory is known: give one')
  assertDirectoryPath('setCacheDir', 'dir', dir)
  root = resolve(dir)
}

// URI-encoded, so a `/` or `..` in a key stays inside one file name, then
// `@` kept and `/` written `+`, as pnpm names its store: `@babel+core@7.29.7`.
// encodeURIComponent writes neither `@` nor `+` bare, so no two keys meet.
// Where case is not told apart (macOS, Windows), JSONStream and jsonstream
// would still meet, so a capital is written `!` and the letter, and a `!`
// as `!!`. A Windows device name (`con.json` is the console) has its first
// letter escaped, which encodeURIComponent never does.
function cachePath(dir, key, base = root) {
  assert.ok(DIRS.has(dir) && key && typeof key === 'string', `Unexpected cache entry: ${dir}`)
  const name = encodeURIComponent(key.replace(/[!A-Z]/gu, (char) => `!${char.toLowerCase()}`)).replaceAll('%40', '@').replaceAll('%2F', '+')
  return base === undefined ? null : join(base, dir, name.replace(/^(?=(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$))./u, (char) => `%${char.codePointAt(0).toString(16).toUpperCase()}`))
}

// Caches of ours, read whether set or not for what is checked whatever its
// source: the default one, and stasis's, which it sets with setCacheDir.
const OURS = [defaultCacheDir, cacheDirFor('stasis')].filter((base) => base !== undefined)

export const ourCachePaths = (dir, key) => OURS.map((base) => cachePath(dir, key, base))

// Only a regular file, checked on the file as opened, so one swapped in
// after a check can't pass: a FIFO or a device would block or never end.
// Read to the size it had when opened, and no further.
export async function readRegularFile(path) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)).catch(() => null)
  try {
    const stats = await handle?.stat()
    if (!stats?.isFile() || stats.size > MAX_BYTES) return null
    const bytes = new Uint8Array(stats.size)
    for (let at = 0; at < bytes.length;) {
      const { bytesRead } = await handle.read(bytes, at, bytes.length - at, at)
      if (bytesRead === 0) return null
      at += bytesRead
    }
    return bytes
  } catch {
    return null
  } finally {
    await handle?.close()
  }
}

export async function readCache(dir, key) {
  const path = cachePath(dir, key)
  return path && await readRegularFile(path)
}

// With `compressed`, the file is decompressed first, to no more than a file
// read; one that is not gzip, fails its CRC, or runs past that, is a miss.
export async function readCacheJSON(dir, key, { compressed = false } = {}) {
  const bytes = await readCache(dir, key)
  try {
    return bytes && JSON.parse(decode(compressed ? await decompress(bytes, { maxOutputLength: MAX_BYTES }) : bytes, key))
  } catch {
    return null
  }
}

export async function writeCache(dir, key, data) {
  const path = cachePath(dir, key)
  if (path === null) return false
  const tmp = `${path}.${process.pid}.${++tmpSeq}.tmp`
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(tmp, data)
    await rename(tmp, path)
    return true
  } catch {
    await rm(tmp, { force: true }).catch(() => {})
    return false
  }
}

export async function writeCacheJSON(dir, key, value, { compressed = false } = {}) {
  const json = JSON.stringify(value)
  return await writeCache(dir, key, compressed ? await compress(json) : json)
}

// A call's `cache` option: a store of the caller's, with read and write,
// to keep what the call caches in place of the cache set; or false, for
// the cache set to be read and nothing written. `cache` below is that.
export const assertCache = assertion('false, or a store with read and write', (value) => value === false || (typeof value?.read === 'function' && typeof value?.write === 'function'))

// What is kept as `dir` and `name`: in a `cache` store, else in the cache
// set, as `fromDisk` and `toDisk` read and write it.
async function read(dir, name, cache, fromDisk) {
  assert.ok(DIRS.has(dir), `Unexpected cache entry: ${dir}`)
  return cache ? await cache.read(dir, name) : await fromDisk()
}

async function write(dir, name, value, cache, toDisk) {
  assert.ok(DIRS.has(dir), `Unexpected cache entry: ${dir}`)
  if (cache === false) return false
  if (!cache) return await toDisk()
  await cache.write(dir, name, value)
  return true
}

// JSON, as it is in a store, and in the cache set gzipped where `dir` is.
const jsonFile = (dir, name) => (GZIP_DIRS.has(dir) ? { file: `${name}.json.gz`, compressed: true } : { file: `${name}.json` })

export function readJSON(dir, name, cache) {
  const { file, compressed } = jsonFile(dir, name)
  return read(dir, name, cache, () => readCacheJSON(dir, file, { compressed }))
}

export function writeJSON(dir, name, value, cache) {
  const { file, compressed } = jsonFile(dir, name)
  return write(dir, name, value, cache, () => writeCacheJSON(dir, file, value, { compressed }))
}

// Bytes, in the cache set as `file`. A store may keep what it is given and
// answer what it keeps, so bytes cross it as a copy each way; what it
// answers that is not bytes is none.
export async function readBytes(dir, name, file, cache) {
  const bytes = await read(dir, name, cache, () => readCache(dir, file))
  if (!(bytes instanceof Uint8Array)) return null
  return cache ? new Uint8Array(bytes) : bytes
}

export const writeBytes = (dir, name, file, bytes, cache) => write(dir, name, cache ? new Uint8Array(bytes) : bytes, cache, () => writeCache(dir, file, bytes))

// A record, kept as readJSON and writeJSON keep it, for `ttl`.
export async function readRecord(dir, name, cache, ttl = RECORD_TTL_MS) {
  const record = await readJSON(dir, name, cache)
  const age = typeof record?.at === 'number' ? Date.now() - record.at : Number.NaN
  const fresh = age >= 0 && age <= ttl // An entry from the future is not fresh forever.
  return fresh && record.name === name ? record : null
}

export const writeRecord = (dir, name, value, cache) => writeJSON(dir, name, { at: Date.now(), name, ...value }, cache)

// Name -> the GitHub repo kept for it (readRecord), for those of `names`
// that have one.
export async function readRepos(dir, names, cache) {
  const entries = await pool(names, RECORDS_AT_ONCE, (name) => readRecord(dir, name, cache))
  return new Map(names.flatMap((name, i) => (isRepo(entries[i]?.github) ? [[name, entries[i].github]] : [])))
}

// An answer into `repos`, and kept (writeRecord) where it found a repo.
export async function addRepos(dir, repos, answer, cache) {
  for (const [name, github] of answer) repos.set(name, github)
  await pool([...answer].filter(([, github]) => github), RECORDS_AT_ONCE, ([name, github]) => writeRecord(dir, name, { github }, cache))
}
