// Babel transforms in worker threads, each loading the project's @babel/core and config once
// (babel-transformer.js); a build's first files are transformed on the main thread instead.

import { once } from 'node:events'
import { enableCompileCache } from 'node:module'
import { availableParallelism } from 'node:os'
import { isAbsolute, relative } from 'node:path'
import { MessageChannel, Worker, parentPort, workerData } from 'node:worker_threads'

import { transformerOf } from './babel-transformer.js'

// 3 workers with 4+ CPUs, else 1. Metro's getMaxWorkers (6 of 8 CPUs) made builds slower: the main
// thread can't keep more busy, and each worker costs ~300 MB and Babel's startup. On 4 CPUs, a
// React Native build took 0.4-0.7 s less with 3 than with 2, and no less with 4.
export function defaultWorkers(cores = availableParallelism()) {
  return cores >= 4 ? 3 : 1
}

// Files queued on each worker before another is started.
const BACKLOG = 8
// Files transformed on the main thread before a worker is started, and until it is ready:
// its ~300 ms startup doesn't pay off for a few files.
const IN_BAND = 16

// -> async (source, filename, without = []) => { code, imports, uncacheable? }, by the @babel/core at
// corePath, leaving out the config's plugins keyed in `without` (options: transformerOf()). Runs up to
// `max` workers (defaultWorkers() if null), `warm` starting them all now; has fingerprint() and close().
export function babelWorkers(corePath, options, profile = null, max = null, { warm = false } = {}) {
  const most = max ?? defaultWorkers()
  const workers = []
  const made = () => {
    const info = { worker: new Worker(new URL(import.meta.url), { workerData: { babel: { corePath, options, profile: profile !== null } } }), busy: 0, pending: new Set(), ready: false }
    info.worker.once('message', () => (info.ready = true))
    // A dead worker leaves the pool and fails what it was given, which would otherwise wait forever.
    let failure
    info.worker.on('error', (error) => (failure = error))
    info.worker.on('exit', (code) => {
      workers.splice(workers.indexOf(info), 1)
      for (const reject of info.pending) reject(failure ?? new Error(`Babel's worker exited with code ${code}`))
    })
    workers.push(info)
    return info
  }
  const pick = () => {
    const least = workers.reduce((a, b) => (b.busy < a.busy ? b : a), workers[0])
    return least !== undefined && (least.busy < BACKLOG || workers.length >= most) ? least : made()
  }
  let inBand = null
  let handled = 0
  // With keepPlugins (--self-test's second build), nothing runs in band, where the first build's
  // plugins are already gated (resolverGate()); a worker starts at once.
  if (options.keepPlugins) made().worker.unref()
  if (warm) while (workers.length < most) made().worker.unref()
  const inBandOf = () => {
    if (inBand === null) {
      try {
        // A fingerprint is only ever a worker's: the main thread has loaded more than Babel.
        inBand = transformerOf({ corePath, options: { ...options, fingerprint: false }, profile: profile !== null })
      } catch (error) {
        inBand = () => {
          throw error
        }
      }
    }
    return inBand
  }
  const ask = async (message, ofWorker = false) => {
    if (!ofWorker && !options.keepPlugins && (handled < IN_BAND || !workers.some(({ ready }) => ready))) {
      // Past IN_BAND, start a worker if there is none (or it died).
      if (++handled >= IN_BAND && workers.length === 0) made().worker.unref()
      return inBandOf()(message)
    }
    const info = pick()
    const { port1, port2 } = new MessageChannel()
    const { promise: failed, reject } = Promise.withResolvers()
    // Only a busy worker keeps the process alive.
    if (info.busy++ === 0) info.worker.ref()
    info.pending.add(reject)
    try {
      info.worker.postMessage({ port: port1, ...message }, [port1])
      const [answer] = await Promise.race([once(port2, 'message'), failed])
      return answer
    } finally {
      if (--info.busy === 0) info.worker.unref()
      info.pending.delete(reject)
      port2.close()
    }
  }
  const transform = async (source, filename, without = []) => {
    const { code, imports, uncacheable, error, loc, spent } = await ask({ source, filename, without })
    if (error !== undefined) throw Object.assign(new Error(error), loc && { loc })
    if (spent !== undefined) addSpent(profile, spent)
    return { code, imports, ...(uncacheable && { uncacheable }) }
  }
  let fingerprint = null
  transform.fingerprint = () => (fingerprint ??= ask({ fingerprint: true }, true).then((answer) => answer.fingerprint == null ? Promise.reject(new Error('no fingerprint: not asked for one')) : answer))
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
  profile.before.set(name, { files: 0, ms: 0 })
  return (...args) => {
    const start = performance.now()
    try {
      return fn(...args)
    } finally {
      const sum = profile.before.get(name)
      sum.files++
      sum.ms += performance.now() - start
    }
  }
}

function addSpent(profile, { ms, plugins, own }) {
  profile.files++
  profile.ms += ms
  for (const [map, entries] of [[profile.plugins, plugins], [profile.own, own]]) {
    for (const [key, calls, time, worked] of entries) {
      const sum = map.get(key) ?? { files: 0, calls: 0, ms: 0 }
      map.set(key, { files: sum.files + (worked ? 1 : 0), calls: sum.calls + calls, ms: sum.ms + time })
    }
  }
}

// A table of each plugin's time, most first, then Babel's own work and the rest, then main-thread work
// before Babel (no share of Babel's time). Plugin keys that are paths are shown relative to root.
export function profileReport({ files, ms, plugins, own, before = new Map() }, root) {
  const line = (...cells) => cells.map((cell, i) => String(cell).padStart([8, 6, 7, 9, 0][i])).join('  ')
  const row = (time, ...cells) => line(Math.round(time), ms > 0 ? ((100 * time) / ms).toFixed(1) : '0.0', ...cells)
  const sorted = [...plugins].toSorted(([, a], [, b]) => b.ms - a.ms)
  const owned = OWN.map((name) => [name, own.get(name) ?? { files: 0, calls: 0, ms: 0 }])
  const rest = ms - [...sorted, ...owned].reduce((sum, [, entry]) => sum + entry.ms, 0)
  return [
    `Babel: ${files} files, ${Math.round(ms)} ms, summed over its threads`,
    line('ms', '%', 'files', 'calls', 'plugin'),
    ...sorted.map(([key, plugin]) => row(plugin.ms, plugin.files, plugin.calls, isAbsolute(key) ? relative(root, key) : key)),
    line('ms', '%', 'files', 'calls', 'Babel, outside plugins'),
    ...owned.map(([name, entry]) => row(entry.ms, entry.files, entry.calls, name)),
    row(rest, '', '', 'traversal, and the rest'),
    ...(before.size === 0 ? [] : [line('ms', '', 'files', '', 'before Babel, on the main thread'), ...[...before].map(([name, entry]) => line(Math.round(entry.ms), '', entry.files, '', name))]),
    '',
  ].join('\n')
}

if (workerData?.babel !== undefined) {
  // As the bin does: @babel/core and the config's plugins compiled once.
  enableCompileCache()
  const handle = transformerOf(workerData.babel)
  parentPort.on('message', ({ port, ...message }) => {
    port.postMessage(handle(message))
    port.close()
  })
  // Ready: the config is loaded.
  // eslint-disable-next-line unicorn/require-post-message-target-origin -- a worker's port, of no origin
  parentPort.postMessage('ready')
}
