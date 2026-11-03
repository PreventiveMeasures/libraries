// Prunes rn-serve's cache: each change to rn, esbuild or a Babel config (or what it depends on) starts a new pack,
// 350 MB for a 10k-file app, and new entries, which no later run reads or removes. Not in the cache key
// (load-cache.js's ownModules()): it removes only what nothing reads.

import { lstat, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

const HOUR = 60 * 60 * 1000
// Whatever no run has used for this long is removed.
export const STALE = 7 * 24 * HOUR
// Over BUDGET bytes, the least recently used packs are removed, but never one used within GRACE,
// as an app's targets for each platform may take more.
export const GRACE = HOUR
const BUDGET = 4 * 1024 ** 3
// Entry directories of the layout before entries were grouped by the cache's salt.
const LEGACY = /^[0-9a-f]{2}$/u

const remove = (path) => rm(path, { recursive: true, force: true }).catch(() => {})

// What is in `dir`, each { name, path, stats }; nothing if it isn't there.
async function listed(dir) {
  const found = []
  for (const name of await readdir(dir).catch(() => [])) {
    const path = join(dir, name)
    const stats = await stat(path).catch(() => null)
    if (stats !== null) found.push({ name, path, stats })
  }
  return found
}

// The bytes of a pack's segments. A segment left half-written (by a run that ended mid-write) is removed after GRACE.
async function sizeOf(dir, now) {
  let size = 0
  for (const { name, path, stats } of await listed(dir)) {
    if (name.endsWith('.tmp') && now - stats.mtimeMs > GRACE) await remove(path)
    else size += stats.size
  }
  return size
}

// Removes the entries, packs and last builds (serve-cache.js's) unused for STALE, by mtime, which runs stamp
// (load-pack.js's touch()); then packs past `budget`; the legacy layout; and each old cache in `before`, if it
// is this user's own directory, not a link. Failures are ignored: what is removed is loaded anew.
export async function prune(dir, { now = Date.now(), budget = BUDGET, before = [] } = {}) {
  for (const path of before) {
    const found = await lstat(path).catch(() => null)
    if (found?.isDirectory() && found.uid === (process.getuid?.() ?? found.uid)) await remove(path)
  }
  for (const name of await readdir(dir).catch(() => [])) if (LEGACY.test(name)) await remove(join(dir, name))
  for (const kind of ['entries', 'builds']) {
    for (const { path, stats } of await listed(join(dir, kind))) if (now - stats.mtimeMs > STALE) await remove(path)
  }
  // Of the packs not STALE, the most recently used first, as many as the budget takes.
  const packs = (await listed(join(dir, 'packs'))).filter(({ stats }) => stats.isDirectory()).toSorted((a, b) => b.stats.mtimeMs - a.stats.mtimeMs)
  let total = 0
  for (const { path, stats } of packs) {
    const unused = now - stats.mtimeMs
    const size = unused > STALE ? 0 : await sizeOf(path, now)
    if (unused > STALE || (total + size > budget && unused > GRACE)) await remove(path)
    else total += size
  }
}
