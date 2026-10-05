import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { assertDirectoryName, assertDirectoryPath, isDeviceName, isRepo } from './args.js'
import { MAX_BYTES, decode } from './http.js'

const DIRS = new Set(['npm/repos', 'npm/tarballs', 'cargo/repos', 'cargo/crates', 'composer/repos', 'soldeer/repos', 'soldeer/zips', 'github/trees'])
const RECORD_TTL_MS = 30 * 24 * 60 * 60 * 1000 // A link only moves on a transfer or rename, and GitHub redirects those.

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
  assertDirectoryName('cacheDirFor', 'name', name)
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
  const file = isDeviceName(name) ? `%${name.codePointAt(0).toString(16).toUpperCase()}${name.slice(1)}` : name
  return base === undefined ? null : join(base, dir, file)
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

export async function readCacheJSON(dir, key) {
  const bytes = await readCache(dir, key)
  try {
    return bytes && JSON.parse(decode(bytes, key))
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

export async function writeCacheJSON(dir, key, value) {
  return await writeCache(dir, key, JSON.stringify(value))
}

export async function readRecord(dir, name) {
  const record = await readCacheJSON(dir, `${name}.json`)
  const age = typeof record?.at === 'number' ? Date.now() - record.at : Number.NaN
  const fresh = age >= 0 && age <= RECORD_TTL_MS // An entry from the future is not fresh forever.
  return fresh && record.name === name ? record : null
}

export const writeRecord = (dir, name, value) => writeCacheJSON(dir, `${name}.json`, { at: Date.now(), name, ...value })

// Name → the GitHub repo cached for it, for those of `names` that have one.
export async function readRepos(dir, names) {
  const repos = new Map()
  for (const name of names) {
    const entry = await readRecord(dir, name)
    if (isRepo(entry?.github)) repos.set(name, entry.github)
  }
  return repos
}

// An answer into `repos`, and into the cache where it found a repo.
export async function addRepos(dir, repos, answer) {
  for (const [name, github] of answer) {
    repos.set(name, github)
    if (github) await writeRecord(dir, name, { github })
  }
}
