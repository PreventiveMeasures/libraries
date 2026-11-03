// rn-serve's on-disk cache of each file as loadFile() (load.js) loads it, keyed by all its output
// depends on: the file, rn's own code, esbuild and flow-remove-types, the project's Babel config and
// what it loads or reads (src/fingerprint.js), and the loadFile() options that change it (--esm's among them).

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { digest, envOf, fileDigest, fingerprintOf, memo, signatureOf, withDependencies } from '../src/fingerprint.js'
import { createPack, pause, readEntry, touch, writeEntry } from './load-pack.js'

// rn's modules whose code shapes the cached output: loadFile(), Babel's worker, dev module builds, this file.
const CHAIN = ['../src/load.js', '../src/babel-worker.js', 'modules.js', 'load-cache.js']
const RELATIVE = /^(?:import|export)\b[^'"]*['"](\.{1,2}\/[^'"]+)['"]/gmu

// The CHAIN modules and every rn module they import, transitively, as those shape the output too
// (worklets.js's Reanimated gate shapes Babel's, for one).
export function ownModules() {
  const paths = new Set(CHAIN.map((name) => join(import.meta.dirname, name)))
  for (const path of paths) for (const [, specifier] of readFileSync(path, 'utf8').matchAll(RELATIVE)) paths.add(join(dirname(path), specifier))
  return [...paths].toSorted()
}

// The cache in `dir`: (target) => its store, plus settled() for pending pack writes. Keys are salted
// with rn's code, esbuild's version and flow-remove-types'; a target's fingerprint is kept with its
// stats, so a later run reuses it without starting a worker for it.
export function createLoadCache(dir, { esbuild, flow = null }) {
  const salt = digest(JSON.stringify([ownModules().map(fileDigest), esbuild.version, flow === null ? null : withDependencies([flow]).map((path) => [path, fileDigest(path)])]))
  // Other salts' entries are never read again: load-prune.js removes them once unused.
  const entries = join(dir, 'entries', salt)
  touch(entries)
  // Per target, asked for at its first use: its key prefix and the modules its fingerprint covers
  // (null without one), and its pack, named by the prefix, so a config change starts a new pack.
  const targets = new Map()
  const targetOf = (babel) =>
    memo(targets, babel, () => {
      const base = babel === null ? Promise.resolve({ prefix: salt, covered: null }) : fingerprintFor(babel, entries).then((made) => (made === null ? null : { prefix: `${salt}\0${made.fingerprint}`, covered: new Set(made.modules) }))
      return { base, pack: base.then((made) => createPack(join(dir, 'packs', digest(made?.prefix ?? salt)))) }
    })
  // Pack writes in progress; a failed one only loses what it would have cached.
  let writes = Promise.resolve()
  const track = (pending) => {
    const written = pending.catch(() => {})
    writes = Promise.all([writes, written])
    return written
  }
  const storeFor = (babel) => storeOf(babel, () => targetOf(babel), { salt, entries, track })
  return Object.assign(storeFor, { settled: () => writes })
}

// The kept fingerprint if its stats or its digest still match, else a new one from the workers; null if none.
async function fingerprintFor(babel, entries) {
  const key = digest(JSON.stringify(['fingerprint', babel.workerOptions, envOf()]))
  const kept = readEntry(entries, key)
  const signed = (made) => {
    writeEntry(entries, key, { ...made, signature: signatureOf(made) })
    return made
  }
  if (kept !== null && kept.signature === signatureOf(kept)) return kept
  if (kept !== null && fingerprintOf(kept.modules, kept.options, kept.reads) === kept.fingerprint) return signed(kept)
  try {
    return signed(await babel.fingerprint())
  } catch {
    return null
  }
}

const hashOf = (head, parts, text) => createHash('sha256').update(`${head}\0${JSON.stringify(parts)}\0`).update(text).digest('hex')
const newTally = () => ({ hits: 0, misses: 0, memory: 0, unkept: {}, ms: 0 })

// A target's store: its keys, its pack, and a tally per build.
function storeOf(babel, target, { salt, entries, track }) {
  let tally = newTally()
  // Counts the time run() takes as the cache's.
  const timed = (run) => {
    const start = performance.now()
    try {
      return run()
    } finally {
      tally.ms += performance.now() - start
    }
  }
  // The pack, read once, at the first get() or build(), its time counted as the cache's.
  let pack = null
  let reading = null
  const read = async () => {
    const made = await target().pack
    const start = performance.now()
    await made.load()
    tally.ms += performance.now() - start
    pack = made
  }
  // The value kept under `key`, or null; after a hit, the event loop gets its turn where due.
  const take = async (key) => {
    await (reading ??= read())
    const kept = timed(() => pack.get(key))
    if (kept !== null) await pause()
    return kept
  }
  const set = (key, value) => timed(() => pack.set(key, value))
  const keyOf = async (path, contents, variant) => {
    const base = await target().base
    if (base === null) return { key: null, why: 'fingerprint' }
    const config = babel === null ? '' : timed(() => babel.configKey(path, base.covered))
    if (config === null) return { key: null, why: 'config' }
    return { key: timed(() => hashOf(base.prefix, [path, variant, config], contents)) }
  }
  return {
    keyOf,
    get: async (key) => {
      const result = await take(key)
      if (result !== null) tally.hits++
      return result
    },
    set,
    // A dev module's build, by its parts and source alone: no Babel config is involved.
    build: async (parts, text, compute) => {
      const key = timed(() => hashOf(`${salt}\0module`, parts, text))
      const kept = await take(key)
      if (kept !== null) return kept
      const value = await compute()
      set(key, value)
      return value
    },
    // A value compute() derives from the file's config, kept as a loose entry under `kind`.
    keep: async (kind, path, compute) => {
      const { key } = await keyOf(path, '', [kind])
      const kept = key === null ? null : readEntry(entries, key)
      if (kept !== null) return kept
      const value = await compute()
      if (key !== null) writeEntry(entries, key, value)
      return value
    },
    // Counts a file as `memory`, `misses` or `unkept` (with `why`); get() counts `hits`.
    note: (what, why = null) => {
      if (what === 'unkept') tally.unkept[why] = (tally.unkept[why] ?? 0) + 1
      else tally[what]++
    },
    start: () => {
      tally = newTally()
      babel?.configStart()
      void target().pack.then((made) => made.start())
    },
    // The build's tally, and a promise of its pack written.
    finish: () => {
      const was = tally
      tally = newTally()
      return { tally: was, written: track(target().pack.then((made) => made.finish())) }
    },
  }
}
