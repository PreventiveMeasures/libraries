// Babel's transforms, off the main thread but for a build's first files:
// each worker loads the project's @babel/core and its config once, and
// transforms what it is sent (babel-transformer.js); asked, gives a
// fingerprint of what its output is of (load-cache.js), which the main
// thread's is of too.

import { once } from 'node:events'
import { enableCompileCache } from 'node:module'
import { availableParallelism } from 'node:os'
import { isAbsolute, relative } from 'node:path'
import { MessageChannel, Worker, parentPort, workerData } from 'node:worker_threads'

import { transformerOf } from './babel-transformer.js'

// How many workers Babel runs in where nothing says: 2, of 4 CPUs or more,
// else 1; not Metro's getMaxWorkers of the CPUs (6 of 8, 8 of 12), which
// made a build slower. The main thread loads, resolves and hands out each
// file, about a sixth of a file's work, which the workers don't share, and
// each worker loads Babel and compiles its code anew (CPU and some 300 MB
// of each): workers the main thread can't keep busy cost that for nothing,
// and the threads, as many more as the CPUs' fast cores, slow it.
export function defaultWorkers(cores = availableParallelism()) {
  return cores >= 4 ? 2 : 1
}

// The files each worker has waiting before one more is made.
const BACKLOG = 8
// The files a build's Babel transforms on the main thread before it makes
// a worker (babelWorkers()): more than a test's fixture has, fewer than
// the main thread does as one loads Babel and the config.
const IN_BAND = 16

// (corePath, options, profile, max) => async (source, filename, without = []) =>
// { code, imports }, by the @babel/core at corePath, with options (all but
// the filename) for each file, its config's plugins of the keys in without
// left out; with options.refresh, react-refresh's Babel plugin at that path
// for each file outside node_modules, as Metro's transformer adds it for Fast
// Refresh; with options.keepPlugins, module-resolver as its plugin has it
// (gateResolver()); with options.inlineRequires, metroOptions()'s, each
// file's requires inlined after its config's plugins, as Metro's transform
// worker inlines them (inlining()). `imports`, the specifiers of the file's import and
// export-from declarations (IMPORTS); `uncacheable` where a plugin's output
// is of files it names (its addExternalDependency), which may change. With
// options.fingerprint, the function's fingerprint() -> (a promise of) {
// fingerprint, options, modules, reads }: what its output is of but a
// file's own config and its source (load-cache.js's fingerprintOf()), as
// its workers have it once they load the config, and what it is a digest
// of. With options.oneBuild, of one build, whose files don't change as it
// runs, Babel's .babelrc lookup of each file left out where it would find
// none (babelrcFinder()), as its directories are read once. Where profile
// is newProfile()'s, the time of each
// transform is added to it, and that of each plugin: its visitors' and
// hooks', by its key. At most `max` workers (defaultWorkers() where null),
// one more made only as files wait: as each has BACKLOG of them or more. One
// starting costs some 300 ms of CPU, loading Babel and the config, which a
// few files, done by one in less, don't make up for: the first IN_BAND files,
// and those till a worker is ready, are transformed in band, on the main
// thread, as a worker would (but with keepPlugins). The fingerprint is a
// worker's alone, one made for it where none is: what the main thread has
// loaded is the process's, not Babel's alone, and the config it has loaded
// (in band, configKeyOf(), babelPlugins()) reads nothing anew. With `warm`,
// of a build of many files (cli.js's bigBuild()), each of the `max` is made
// at once, loading Babel and the config as the build starts, the main
// thread transforming in band till one is ready, as it does till then.
export function babelWorkers(corePath, options, profile = null, max = null, { warm = false } = {}) {
  const most = max ?? defaultWorkers()
  const workers = []
  const pick = () => {
    const least = workers.reduce((a, b) => (a === undefined || b.busy < a.busy ? b : a), undefined)
    return least !== undefined && (least.busy < BACKLOG || workers.length >= most) ? least : made()
  }
  const made = () => {
    const info = { worker: new Worker(new URL(import.meta.url), { workerData: { babel: { corePath, options, profile: profile !== null } } }), busy: 0, pending: new Set(), ready: false }
    info.worker.once('message', () => (info.ready = true))
    // A worker that dies leaves the pool, failing what it was given, which
    // would wait forever; one more is made where needed.
    let failure
    info.worker.on('error', (error) => (failure = error))
    info.worker.on('exit', (code) => {
      workers.splice(workers.indexOf(info), 1)
      for (const reject of info.pending) reject(failure ?? new Error(`Babel's worker exited with code ${code}`))
    })
    workers.push(info)
    return info
  }
  // The first IN_BAND files transformed in band, on the main thread, which
  // has @babel/core and the config loaded (cli.js's babelPlugins()): a
  // worker loads them anew, which a build of a few files doesn't make up
  // for. Then a worker's made, the main thread transforming until one is
  // ready. With a cache's fingerprint too (rn-serve's), which a worker gives
  // where the one kept is no longer (load-cache.js): a run whose files the
  // cache has makes none. But with keepPlugins (--self-test's build after
  // another, in band of plugins the first's gated: babel-transformer.js's
  // resolverGate()): then one made at once, which loads Babel and the
  // config as the build starts; idle, it keeps the process alive no more
  // than one made for a file.
  let inBand = options.keepPlugins ? null : undefined
  let handled = 0
  if (inBand === null) pick().worker.unref()
  // Idle, as one made for a file is.
  if (warm) while (workers.length < most) made().worker.unref()
  const inBandOf = () => {
    if (inBand === undefined) {
      try {
        // Of no fingerprint: the main thread's is not a worker's.
        inBand = transformerOf({ corePath, options: { ...options, fingerprint: false }, profile: profile !== null })
      } catch (error) {
        inBand = () => {
          throw error
        }
      }
    }
    return inBand
  }
  // -> a worker's answer to the message, or the main thread's, but `ofWorker`.
  const ask = async (message, ofWorker = false) => {
    if (!ofWorker && inBand !== null && (handled < IN_BAND || !workers.some(({ ready }) => ready))) {
      // One made, past IN_BAND, where none is (or one died).
      if (++handled >= IN_BAND && workers.length === 0) pick().worker.unref()
      return inBandOf()(message)
    }
    const info = pick()
    const { port1, port2 } = new MessageChannel()
    const { promise: failed, reject } = Promise.withResolvers()
    // Busy, a worker keeps the process alive; idle, it doesn't.
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
    // Babel's error, with where in the file Babel says, if it does.
    if (error !== undefined) throw Object.assign(new Error(error), loc === undefined ? {} : { loc })
    if (spent !== undefined) addSpent(profile, spent)
    return { code, imports, ...(uncacheable && { uncacheable }) }
  }
  let fingerprint = null
  return Object.assign(transform, { fingerprint: () => (fingerprint ??= ask({ fingerprint: true }, true).then((answer) => answer.fingerprint == null ? Promise.reject(new Error('no fingerprint: not asked for one')) : answer)) })
}

// Babel's own work, outside its plugins, by what it is.
const OWN = ['config', 'parsing', 'scopes', 'printing']

// { files, ms, plugins, own }, which babelWorkers adds to: plugins a
// Map<key, { files, calls, ms }>, `files` those a plugin's visitors (or its
// parser or printer) ran in, not all it is in; own one by each of OWN.
export function newProfile() {
  return { files: 0, ms: 0, plugins: new Map(), own: new Map() }
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

// A table of the time each plugin took, most first, then Babel's own, by
// what it is, and the rest. Keys that are paths, of plugins with no name,
// are made relative to root.
export function profileReport({ files, ms, plugins, own }, root) {
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
    '',
  ].join('\n')
}

if (workerData?.babel !== undefined) {
  // A thread's own, as the bin's: @babel/core and the config's plugins compiled once.
  enableCompileCache()
  const handle = transformerOf(workerData.babel)
  parentPort.on('message', ({ port, ...message }) => {
    port.postMessage(handle(message))
    port.close()
  })
  // Ready for files, the config loaded.
  // eslint-disable-next-line unicorn/require-post-message-target-origin -- a worker's port, of no origin
  parentPort.postMessage('ready')
}
