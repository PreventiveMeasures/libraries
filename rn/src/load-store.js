// A target's store (load-cache.js's createLoadCache()): its keys, of its
// pack, and what a build takes of it, counted.

import { createHash } from 'node:crypto'

import { pause } from './load-pack.js'

// The store of a target (createLoadCache()'s), its pack and its keys' base.
export function storeOf(babel, { salt, packed, base: baseOf, read, write, track }) {
  // Its pack, once its keys' prefix is known, as each key is of it: asked
  // for as its first build starts.
  let pack = null
  let packing = null
  const settled = () => (packing ??= packed().then((made) => (pack = made)))
  const fresh = () => ({ hits: 0, misses: 0, memory: 0, unkept: {}, ms: 0 })
  let tally = fresh()
  // What run() gives, the time it takes the cache's, as the build's.
  const timed = (run) => {
    const start = performance.now()
    try {
      return run()
    } finally {
      tally.ms += performance.now() - start
    }
  }
  // The pack read, at its first build's first ask, which each of its asks
  // waits for: the time it took, as the build's.
  let reading = null
  const loaded = () =>
    (reading ??= (async () => {
      const start = performance.now()
      await pack.load()
      tally.ms += performance.now() - start
    })())
  const keyOf = async (path, contents, variant) => {
    const base = await baseOf()
    if (base === null) return { key: null, why: 'fingerprint' }
    const { prefix, covered } = base
    const config = babel === null ? '' : timed(() => babel.configKey(path, covered))
    if (config === null) return { key: null, why: 'config' }
    return { key: timed(() => createHash('sha256').update(prefix).update('\0').update(JSON.stringify([path, variant, config])).update('\0').update(contents).digest('hex')) }
  }
  return {
    keyOf,
    get: async (key) => {
      await settled()
      await loaded()
      const result = timed(() => pack.get(key))
      if (typeof result?.contents !== 'string' || typeof result.loader !== 'string') return null
      tally.hits++
      await pause()
      return result
    },
    set: (key, result) => timed(() => pack?.set(key, result)),
    build: async (parts, text, compute) => {
      await settled()
      await loaded()
      const key = timed(() => createHash('sha256').update(salt).update('\0module\0').update(JSON.stringify(parts)).update('\0').update(text).digest('hex'))
      const kept = timed(() => pack.get(key))
      if (kept !== null) {
        await pause()
        return kept
      }
      const value = await compute()
      timed(() => pack.set(key, value))
      return value
    },
    keep: async (kind, path, compute) => {
      const { key } = await keyOf(path, '', [kind])
      const kept = key === null ? null : read(key)
      if (kept !== null && Object.hasOwn(kept, 'value')) return kept.value
      const value = await compute()
      if (key !== null) write(key, { value })
      return value
    },
    note: (what, why = null) => {
      if (what === 'unkept') tally.unkept[why] = (tally.unkept[why] ?? 0) + 1
      else tally[what]++
    },
    start: () => {
      tally = fresh()
      babel?.configStart?.()
      void settled().then(() => pack.start())
    },
    finish: () => {
      const was = tally
      tally = fresh()
      return { tally: was, written: track(settled().then(() => pack.finish())) }
    },
  }
}
