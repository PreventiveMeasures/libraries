// A target's store (load-cache.js's createLoadCache()): its keys, its pack, and a tally per build.

import { createHash } from 'node:crypto'

import { pause } from './load-pack.js'

const hashOf = (head, parts, text) => createHash('sha256').update(head).update('\0').update(JSON.stringify(parts)).update('\0').update(text).digest('hex')

// packed() and base() give the target's pack and its keys' { prefix, covered } (null without a
// fingerprint), asked for lazily; read() and write() are loose entries; track() follows a pack's write.
export function storeOf(babel, { salt, packed, base, read, write, track }) {
  let pack = null
  let packing = null
  const settled = () => (packing ??= packed().then((made) => (pack = made)))
  const fresh = () => ({ hits: 0, misses: 0, memory: 0, unkept: {}, ms: 0 })
  let tally = fresh()
  // Counts the time run() takes as the cache's.
  const timed = (run) => {
    const start = performance.now()
    try {
      return run()
    } finally {
      tally.ms += performance.now() - start
    }
  }
  // The pack is read once, at the first get() or build(), its time counted as the cache's.
  let reading = null
  const ready = () =>
    (reading ??= (async () => {
      await settled()
      const start = performance.now()
      await pack.load()
      tally.ms += performance.now() - start
    })())
  const keyOf = async (path, contents, variant) => {
    const made = await base()
    if (made === null) return { key: null, why: 'fingerprint' }
    const config = babel === null ? '' : timed(() => babel.configKey(path, made.covered))
    if (config === null) return { key: null, why: 'config' }
    return { key: timed(() => hashOf(made.prefix, [path, variant, config], contents)) }
  }
  return {
    keyOf,
    get: async (key) => {
      await ready()
      const result = timed(() => pack.get(key))
      if (typeof result?.contents !== 'string' || typeof result.loader !== 'string') return null
      tally.hits++
      await pause()
      return result
    },
    set: (key, result) => timed(() => pack?.set(key, result)),
    // A dev module's build, by its parts and source alone: no Babel config is involved.
    build: async (parts, text, compute) => {
      await ready()
      const key = timed(() => hashOf(`${salt}\0module`, parts, text))
      const kept = timed(() => pack.get(key))
      if (kept !== null) {
        await pause()
        return kept
      }
      const value = await compute()
      timed(() => pack.set(key, value))
      return value
    },
    // A value compute() derives from the file's config, kept as a loose entry under `kind`.
    keep: async (kind, path, compute) => {
      const { key } = await keyOf(path, '', [kind])
      const kept = key === null ? null : read(key)
      if (kept !== null && Object.hasOwn(kept, 'value')) return kept.value
      const value = await compute()
      if (key !== null) write(key, { value })
      return value
    },
    // Counts a file as `memory`, `misses` or `unkept` (with `why`); get() counts `hits`.
    note: (what, why = null) => {
      if (what === 'unkept') tally.unkept[why] = (tally.unkept[why] ?? 0) + 1
      else tally[what]++
    },
    start: () => {
      tally = fresh()
      babel?.configStart?.()
      void settled().then(() => pack.start())
    },
    // The build's tally, and a promise of its pack written.
    finish: () => {
      const was = tally
      tally = fresh()
      return { tally: was, written: track(settled().then(() => pack.finish())) }
    },
  }
}
