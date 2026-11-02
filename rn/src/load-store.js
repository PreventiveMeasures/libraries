// A target's store (load-cache.js's createLoadCache()): its keys, of its
// pack, and what a build takes of it, by part, counted.

import { createHash } from 'node:crypto'
import { PerformanceObserver } from 'node:perf_hooks'

import { pause } from './load-pack.js'

// The time V8 has taken collecting garbage, so far, of the process: a
// build's, of its start and finish, which the cache's records make the
// more of.
let gcTime = 0
let observing = false
const collected = () => {
  if (!observing) {
    observing = true
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) gcTime += entry.duration
    }).observe({ entryTypes: ['gc'] })
  }
  return gcTime
}

// -> (part, run): what run() gives, the time it takes the cache's, as the
// build's (tallied()'s tally), and of its `part`.
const timer = (tallied) => (part, run) => {
  const start = performance.now()
  try {
    return run()
  } finally {
    const ms = performance.now() - start
    tallied().ms += ms
    tallied().parts[part] += ms
  }
}

// The store of a target (createLoadCache()'s), its pack and its keys' base.
export function storeOf(babel, { salt, packed, base: baseOf, read, write, track }) {
  // Its pack, once its keys' prefix is known, as each key is of it: asked
  // for as its first build starts.
  let pack = null
  let packing = null
  const settled = () => (packing ??= packed().then((made) => (pack = made)))
  const fresh = () => ({ hits: 0, misses: 0, memory: 0, unkept: {}, ms: 0, parts: { config: 0, hashing: 0, records: 0, pack: 0 }, pack: null, gc: 0 })
  let tally = fresh()
  let gcAt = 0
  const timed = timer(() => tally)
  // The pack read, at its first build's first ask, which each of its asks
  // waits for: the time it took, as the build's, and what it read.
  let reading = null
  const loaded = () =>
    (reading ??= (async () => {
      const start = performance.now()
      const was = await pack.load()
      const ms = performance.now() - start
      tally.ms += ms
      tally.parts.pack += ms
      if (was !== null) tally.pack = was
    })())
  const keyOf = async (path, contents, variant) => {
    const base = await baseOf()
    if (base === null) return { key: null, why: 'fingerprint' }
    const { prefix, covered } = base
    const config = babel === null ? '' : timed('config', () => babel.configKey(path, covered))
    if (config === null) return { key: null, why: 'config' }
    return { key: timed('hashing', () => createHash('sha256').update(prefix).update('\0').update(JSON.stringify([path, variant, config])).update('\0').update(contents).digest('hex')) }
  }
  return {
    keyOf,
    get: async (key) => {
      await settled()
      await loaded()
      const result = timed('records', () => pack.get(key))
      if (typeof result?.contents !== 'string' || typeof result.loader !== 'string') return null
      tally.hits++
      await pause()
      return result
    },
    set: (key, result) => timed('records', () => pack?.set(key, result)),
    build: async (parts, text, compute) => {
      await settled()
      await loaded()
      const key = timed('hashing', () => createHash('sha256').update(salt).update('\0module\0').update(JSON.stringify(parts)).update('\0').update(text).digest('hex'))
      const kept = timed('records', () => pack.get(key))
      if (kept !== null) {
        await pause()
        return kept
      }
      const value = await compute()
      timed('records', () => pack.set(key, value))
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
      gcAt = collected()
      babel?.configStart?.()
      void settled().then(() => pack.start())
    },
    finish: () => {
      const was = { ...tally, gc: collected() - gcAt }
      tally = fresh()
      return { tally: was, written: track(settled().then(() => pack.finish())) }
    },
  }
}
