// The resolutions a bundler keeps in memory across the builds its watcher causes (serve/bundler.js,
// serve/modules.js), as build-host.js's newState() takes them (run.resolution).

import { basename, dirname } from 'node:path'

import { lookups, metroResolverOf } from '../src/build-host.js'

const plainFile = (entry) => entry != null && entry.isFile() && !entry.isSymbolicLink()

// buildHost() kept across a bundler's watcher-caused builds (resolutionOf()), noting each path it looked up
// or read, in each build's `read` too (attach(read)). keeps(changes) -> whether what it knows still holds
// after a watcher's changes ({ path, event }): not after a package.json changed, nor a path it looked up was
// added, removed or made another kind, nor one it looked up paths under was; a file's contents changing, or
// an editor's save by rename (still a plain file, not a link's), leave it; a path it never looked up, added
// or removed, its directory's listing alone.
export function keptLookups(host) {
  const seen = new Set()
  const under = new Set()
  let read = null
  const made = lookups(host, {
    add(path) {
      if (!seen.has(path)) {
        seen.add(path)
        for (let dir = dirname(path); !under.has(dir); dir = dirname(dir)) {
          under.add(dir)
          if (dirname(dir) === dir) break
        }
      }
      read?.add(path)
    },
  })
  const keeps = ({ path, event }) => {
    if (basename(path) === 'package.json') return false
    if (event === 'change') return true
    if (under.has(path)) return false
    const before = made.entry(path)
    made.forget(dirname(path))
    if (!seen.has(path)) return true
    return plainFile(before) && plainFile(made.entry(path)) && made.known('isFile', path) === true && (made.known('realpath', path) ?? path) === path
  }
  return {
    host: made.host,
    attach(buildRead) {
      read = buildRead
      for (const path of seen) buildRead.add(path)
    },
    keeps: (changes) => changes.every(keeps),
  }
}

// A bundler's resolver, kept in memory across its watcher-caused builds: (changes, read) => Metro's resolver,
// each resolution made once, its lookups (keptLookups()) noted in `read`; made anew of a full build (`changes`
// null: a bundle's first, or one `r` asks for) or of changes after which what it looked up no longer holds.
export function resolutionOf(run) {
  let kept = null
  return (changes, read) => {
    if (kept === null || changes === null || !kept.lookups.keeps(changes)) {
      const keptLooked = keptLookups(run.host)
      const resolveModule = metroResolverOf({ ...run, host: keptLooked.host })
      const made = new Map()
      kept = {
        lookups: keptLooked,
        resolveModule: (importer, specifier, options) => {
          const key = `${importer}\0${specifier}\0${JSON.stringify(options ?? null)}`
          if (!made.has(key)) made.set(key, resolveModule(importer, specifier, options))
          return made.get(key)
        },
      }
    }
    kept.lookups.attach(read)
    return kept.resolveModule
  }
}
