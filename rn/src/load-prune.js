// rn-serve's cache (load-cache.js's), pruned: of each change to rn's code,
// to esbuild, or to a target's Babel config (or what it depends on), the cache has a pack of
// its own, of an app of 10k files 350 MB, and entries of their own, which
// no run after would read again, nor remove. Not of the chain (load-cache.js's
// ownModules()): what it removes is read by none, of a key of none.

import { lstat, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

const HOUR = 60 * 60 * 1000
// Of what no run has used for so long, all of it removed.
export const STALE = 7 * 24 * HOUR
// Of packs no run has used for so long, the least lately used removed
// while the rest take more than BUDGET bytes; what a run uses now (of the
// last hour) none of, as an app's targets of each platform may take more.
export const GRACE = HOUR
export const BUDGET = 4 * 1024 ** 3
// A directory of entries of the layout before entries were kept by the
// cache's salt (load-cache.js's createLoadCache()).
const LEGACY = /^[0-9a-f]{2}$/u

const namesOf = (dir) => readdir(dir).catch(() => [])
const remove = (path) => rm(path, { recursive: true, force: true }).catch(() => {})
// When a run last used a pack or entries, by their directory's mtime,
// which a run stamps as it reads or writes them (load-pack.js's touch());
// null where none is there.
const usedOf = (path) =>
  stat(path).then(
    (found) => (found.isDirectory() ? found.mtimeMs : null),
    () => null,
  )

// The bytes of a pack's segments; of a segment left half written (a run's
// that ended as it wrote it), none: it is removed, of before GRACE.
async function sizeOf(dir, now) {
  let size = 0
  for (const name of await namesOf(dir)) {
    const path = join(dir, name)
    const found = await stat(path).catch(() => null)
    if (found === null) continue
    if (name.endsWith('.tmp') && now - found.mtimeMs > GRACE) await remove(path)
    else size += found.size
  }
  return size
}

// The cache in `dir` pruned: the entries, packs and last builds (serve-cache.js's)
// of `dir` no run has used for STALE, then of the packs, while they take more than `budget`
// bytes, the least lately used of those no run has used for GRACE; the
// entries of the layout before; and each directory of `before`, a cache of
// rn-serve's before this one, the user's own (not a link). A cache, at best:
// what fails to be removed is left; what is removed, another run loads anew.
export async function prune(dir, { now = Date.now(), budget = BUDGET, before = [] } = {}) {
  for (const path of before) {
    const found = await lstat(path).catch(() => null)
    if (found?.isDirectory() && found.uid === (process.getuid?.() ?? found.uid)) await remove(path)
  }
  for (const name of await namesOf(dir)) if (LEGACY.test(name)) await remove(join(dir, name))
  for (const kept of ['entries', 'builds']) {
    for (const name of await namesOf(join(dir, kept))) {
      const path = join(dir, kept, name)
      const found = await stat(path).catch(() => null)
      if (found !== null && now - found.mtimeMs > STALE) await remove(path)
    }
  }
  const packs = []
  for (const name of await namesOf(join(dir, 'packs'))) {
    const path = join(dir, 'packs', name)
    const used = await usedOf(path)
    if (used === null) continue
    if (now - used > STALE) await remove(path)
    else packs.push({ path, used, size: await sizeOf(path, now) })
  }
  // The most lately used kept first, as many as the budget takes.
  let total = 0
  for (const { path, used, size } of packs.toSorted((a, b) => b.used - a.used)) {
    if (total + size > budget && now - used > GRACE) await remove(path)
    else total += size
  }
}
