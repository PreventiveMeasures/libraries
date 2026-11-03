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

const namesOf = (dir) => readdir(dir).catch(() => [])
const statOf = (path) => stat(path).catch(() => null)
const remove = (path) => rm(path, { recursive: true, force: true }).catch(() => {})

// The bytes of a pack's segments. A segment left half-written (by a run that ended mid-write) is removed after GRACE.
async function sizeOf(dir, now) {
  let size = 0
  for (const name of await namesOf(dir)) {
    const path = join(dir, name)
    const found = await statOf(path)
    if (found === null) continue
    if (name.endsWith('.tmp') && now - found.mtimeMs > GRACE) await remove(path)
    else size += found.size
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
  for (const name of await namesOf(dir)) if (LEGACY.test(name)) await remove(join(dir, name))
  const packs = []
  for (const kept of ['entries', 'builds', 'packs']) {
    for (const name of await namesOf(join(dir, kept))) {
      const path = join(dir, kept, name)
      const found = await statOf(path)
      if (found === null || (kept === 'packs' && !found.isDirectory())) continue
      if (now - found.mtimeMs > STALE) await remove(path)
      else if (kept === 'packs') packs.push({ path, used: found.mtimeMs, size: await sizeOf(path, now) })
    }
  }
  // Keep the most recently used first, as many as the budget takes.
  let total = 0
  for (const { path, used, size } of packs.toSorted((a, b) => b.used - a.used)) {
    if (total + size > budget && now - used > GRACE) await remove(path)
    else total += size
  }
}
