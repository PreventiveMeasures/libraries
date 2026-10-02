import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { assertDirectoryPath } from './args.js'
import { MAX_BYTES, decode } from './http.js'

const DIRS = new Set(['npm/repos', 'npm/tarballs', 'cargo/repos', 'cargo/crates', 'composer/repos', 'soldeer/repos', 'soldeer/zips', 'github/trees'])
const RECORD_TTL_MS = 30 * 24 * 60 * 60 * 1000 // A link only moves on a transfer or rename, and GitHub redirects those.

let root
let tmpSeq = 0

export function setCacheDir(dir) {
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
function cachePath(dir, key) {
  assert.ok(DIRS.has(dir) && key && typeof key === 'string', `Unexpected cache entry: ${dir}`)
  const name = encodeURIComponent(key.replace(/[!A-Z]/gu, (char) => `!${char.toLowerCase()}`)).replaceAll('%40', '@').replaceAll('%2F', '+')
  return root === undefined ? null : join(root, dir, name.replace(/^(?=(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$))./u, (char) => `%${char.codePointAt(0).toString(16).toUpperCase()}`))
}

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
