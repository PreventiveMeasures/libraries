// Babel transforms in worker threads, each loading the project's @babel/core and config once
// (babel-transformer.js); a build's first files are transformed on the main thread instead.

import { enableCompileCache } from 'node:module'
import { availableParallelism } from 'node:os'
import { isAbsolute, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Worker, parentPort, workerData } from 'node:worker_threads'

import { transformerOf } from './babel-transformer.js'

// 3 workers with 4+ CPUs, else 1. Metro's getMaxWorkers (6 of 8 CPUs) made builds slower: the main
// thread can't keep more busy, and each worker costs ~300 MB and Babel's startup. On 4 CPUs, a
// React Native build took 0.4-0.7 s less with 3 than with 2, and no less with 4.
export function defaultWorkers(cores = availableParallelism()) {
  return cores >= 4 ? 3 : 1
}

// Files queued on each worker before another is started.
const BACKLOG = 8
// Configuration and transform setup give even tiny files some work, in source-character units.
const FILE_COST = 1024
// Files transformed on the main thread before a worker is started, and until it is ready:
// its ~300 ms startup doesn't pay off for a few files.
const IN_BAND = 16
// A worker's first message: its config is loaded.
const READY = 'ready'
// Each worker's young generation, in MB: 16 MB semi-spaces. Node's default with 16 GB of RAM, 192 MB
// (64 MB semi-spaces), let 3 workers hold ~400 MB more for no faster a build: Babel's garbage is a
// file's, and dies with its transform. A --max-semi-space-size given to Node still takes precedence.
const YOUNG_MB = 48

// esbuild's inline map can be larger than the code it maps, but adds no nodes for Babel to transform.
const sourceSize = (source = '') => {
  const map = source.lastIndexOf('\n//# sourceMappingURL=data:')
  return map < 0 ? source.length : map
}

// -> async (source, filename, without = []) => { code, imports, uncacheable? }, on up to `max` workers
// (defaultWorkers() if null). `warm` starts them all now; `eager` starts them all once a build passes
// IN_BAND files, rather than one per BACKLOG. Has close(), and fingerprint() with a fingerprinter.
// options.processEnv, where given, is what of process.env the workers run with (NODE_ENV, BABEL_ENV), as
// the config and its plugins read it; where this process's differs, nothing is transformed in band.
export function babelWorkers(corePath, options, profile = null, max = null, { warm = false, eager = false } = {}) {
  const most = max ?? defaultWorkers()
  const env = options.processEnv ?? null
  const inBandOk = !options.keepPlugins && (env === null || Object.entries(env).every(([name, value]) => process.env[name] === value))
  const bySize = options.oneBuild && !options.sourceMaps
  const workers = []
  const made = () => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { babel: { corePath, options, profile: profile !== null } }, resourceLimits: { maxYoungGenerationSizeMb: YOUNG_MB }, ...(env !== null && { env: { ...process.env, ...env } }) })
    // `asked`: the answers it owes, in order.
    const info = { worker, asked: [], ready: false, load: 0 }
    worker.on('message', (answer) => {
      // READY is its first message, so any means it is ready.
      info.ready = true
      if (answer !== READY) {
        const task = info.asked.shift()
        info.load -= task.cost
        task.resolve(answer)
      }
      // Only a busy worker keeps the process alive.
      if (info.asked.length === 0) worker.unref()
    })
    // A dead worker leaves the pool and fails what it owes, which would otherwise wait forever.
    let failure
    worker.on('error', (error) => (failure = error))
    worker.on('exit', (code) => {
      workers.splice(workers.indexOf(info), 1)
      for (const { reject } of info.asked) reject(failure ?? new Error(`Babel's worker exited with code ${code}`))
    })
    worker.unref()
    workers.push(info)
    return info
  }
  // Cold builds without output maps account for source size as well as per-file work. Counting files
  // alone queues small files behind a large transform while another worker can finish its queue.
  const inWorker = (message) => {
    const least = workers.reduce((a, b) => (b.load < a.load ? b : a), workers[0])
    const chosen = least !== undefined && (least.asked.length < BACKLOG || workers.length >= most) ? least : made()
    const { worker, asked } = chosen
    const answer = { ...Promise.withResolvers(), cost: bySize ? FILE_COST + sourceSize(message.source) : 1 }
    chosen.load += answer.cost
    if (asked.push(answer) === 1) worker.ref()
    // eslint-disable-next-line unicorn/require-post-message-target-origin -- a worker, of no origin
    worker.postMessage(message)
    return answer.promise
  }
  // keepPlugins (--self-test's second build) runs nothing in band, where the first build gated the plugins.
  if (options.keepPlugins) made()
  if (warm) while (workers.length < most) made()
  let inBand = null
  let handled = 0
  const ask = async (message) => {
    if (!inBandOk || (handled >= IN_BAND && workers.some(({ ready }) => ready))) return inWorker(message)
    // Past IN_BAND, start a worker if there is none (or it died); `eager`, each.
    if (++handled >= IN_BAND) while (workers.length < (eager ? most : 1)) made()
    // No fingerprint: the main thread has loaded more than Babel. A failure to load is each file's.
    inBand ??= Promise.try(() => transformerOf({ corePath, options, profile: profile !== null }))
    return (await inBand).transform(message)
  }
  const transform = async (source, filename, without = []) => {
    const { error, loc, spent, ...result } = await ask({ source, filename, without })
    if (error !== undefined) throw Object.assign(new Error(error), loc && { loc })
    if (spent !== undefined) addSpent(profile, spent)
    return result
  }
  if (options.fingerprinter != null) {
    let fingerprint = null
    transform.fingerprint = () => (fingerprint ??= inWorker({ fingerprint: true }))
  }
  // For a process that goes on after the build (an embedder's, a test's): idle workers keep their memory.
  transform.close = () => Promise.all(workers.map(({ worker }) => worker.terminate()))
  return transform
}

// Babel's own work outside its plugins.
const OWN = ['config', 'parsing', 'scopes', 'printing']

// plugins and own map a key to { files, calls, ms }, `files` counting those where a plugin's visitors
// (or parser or printer) ran; before maps main-thread work before Babel to { files, ms }.
export function newProfile() {
  return { files: 0, ms: 0, plugins: new Map(), own: new Map(), before: new Map() }
}

// fn, with each call timed in profile.before under name (main-thread work before Babel, such as
// stripping Flow); fn itself where profile or fn is null.
export function timedBefore(profile, name, fn) {
  if (profile === null || fn === null) return fn
  const sum = { files: 0, ms: 0 }
  profile.before.set(name, sum)
  return (...args) => {
    const start = performance.now()
    try {
      return fn(...args)
    } finally {
      sum.files++
      sum.ms += performance.now() - start
    }
  }
}

// Adds a file's times (profilerOf() in babel-transformer.js) to the profile.
function addSpent(profile, { ms, plugins, own }) {
  profile.files++
  profile.ms += ms
  for (const [map, spent] of [[profile.plugins, plugins], [profile.own, own]]) {
    for (const [key, [calls, time, worked]] of spent) {
      const sum = map.get(key) ?? { files: 0, calls: 0, ms: 0 }
      map.set(key, { files: sum.files + (worked ? 1 : 0), calls: sum.calls + calls, ms: sum.ms + time })
    }
  }
}

// A table of each plugin's time, most first, then Babel's own work and the rest, then main-thread work
// before Babel (no share of Babel's time). Plugin keys that are paths are shown relative to root.
export function profileReport({ files, ms, plugins, own, before = new Map() }, root) {
  const line = (...cells) => cells.map((cell, i) => String(cell).padStart([8, 6, 7, 9, 0][i])).join('  ')
  const row = (name, entry) => line(Math.round(entry.ms), ms > 0 ? ((100 * entry.ms) / ms).toFixed(1) : '0.0', entry.files ?? '', entry.calls ?? '', name)
  const sorted = [...plugins].toSorted(([, a], [, b]) => b.ms - a.ms)
  const owned = OWN.map((name) => [name, own.get(name) ?? { files: 0, calls: 0, ms: 0 }])
  const rest = ms - [...sorted, ...owned].reduce((sum, [, entry]) => sum + entry.ms, 0)
  return [
    `Babel: ${files} files, ${Math.round(ms)} ms, summed over its threads`,
    line('ms', '%', 'files', 'calls', 'plugin'),
    ...sorted.map(([key, entry]) => row(isAbsolute(key) ? relative(root, key) : key, entry)),
    line('ms', '%', 'files', 'calls', 'Babel, outside plugins'),
    ...owned.map(([name, entry]) => row(name, entry)),
    row('traversal, and the rest', { ms: rest }),
    ...(before.size === 0 ? [] : [line('ms', '', 'files', '', 'before Babel, on the main thread'), ...before.entries().map(([name, entry]) => line(Math.round(entry.ms), '', entry.files, '', name))]),
    '',
  ].join('\n')
}

if (workerData?.babel !== undefined) {
  // Only serve reuses compiled code on disk; a one-off bundle keeps nothing across runs.
  if (!workerData.babel.options.oneBuild) enableCompileCache()
  // options.fingerprinter: the path of a module whose workerFingerprint() makes the worker's fingerprint
  // (@preventive/rn-serve's src/fingerprint.js), as the worker loads its config.
  const { fingerprinter = null } = workerData.babel.options
  const fingerprintOf = fingerprinter === null ? null : (await import(pathToFileURL(fingerprinter).href)).workerFingerprint
  const { transform, fingerprint } = transformerOf({ ...workerData.babel, fingerprintOf })
  // eslint-disable-next-line unicorn/require-post-message-target-origin -- a worker's port, of no origin
  const post = (message) => parentPort.postMessage(message)
  parentPort.on('message', (message) => post(message.fingerprint ? fingerprint : transform(message)))
  post(READY)
}
