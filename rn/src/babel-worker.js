// Babel's transforms, off the main thread: each worker loads the project's
// @babel/core and its config once, and transforms what it is sent.

import { once } from 'node:events'
import { createRequire } from 'node:module'
import { availableParallelism } from 'node:os'
import { isAbsolute, relative } from 'node:path'
import { MessageChannel, Worker, parentPort, workerData } from 'node:worker_threads'

// (corePath, options, profile) => async (source, filename, without = []) =>
// code, by the @babel/core at corePath, with options (all but the filename)
// for each file, its config's plugins of the keys in without left out. Where
// profile is newProfile()'s, the time of each transform is added to it, and
// that of each plugin: its visitors' and hooks', by its key.
export function babelWorkers(corePath, options, profile = null) {
  const max = availableParallelism() >= 4 ? 2 : 1
  const workers = []
  const pick = () => {
    const idle = workers.find(({ busy }) => busy === 0)
    if (idle !== undefined || workers.length >= max) return idle ?? workers.reduce((a, b) => (b.busy < a.busy ? b : a))
    const info = { worker: new Worker(new URL(import.meta.url), { workerData: { babel: { corePath, options, profile: profile !== null } } }), busy: 0, pending: new Set() }
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
  return async (source, filename, without = []) => {
    const info = pick()
    const { port1, port2 } = new MessageChannel()
    const { promise: failed, reject } = Promise.withResolvers()
    // Busy, a worker keeps the process alive; idle, it doesn't.
    if (info.busy++ === 0) info.worker.ref()
    info.pending.add(reject)
    try {
      info.worker.postMessage({ port: port1, source, filename, without }, [port1])
      const [{ code, error, spent }] = await Promise.race([once(port2, 'message'), failed])
      if (error !== undefined) throw new Error(error)
      if (spent !== undefined) addSpent(profile, spent)
      return code
    } finally {
      if (--info.busy === 0) info.worker.unref()
      info.pending.delete(reject)
      port2.close()
    }
  }
}

// { files, ms, plugins: Map<key, { files, calls, ms }> }, which babelWorkers adds to.
export function newProfile() {
  return { files: 0, ms: 0, plugins: new Map() }
}

function addSpent(profile, { ms, plugins }) {
  profile.files++
  profile.ms += ms
  for (const [key, calls, time] of plugins) {
    const plugin = profile.plugins.get(key) ?? { files: 0, calls: 0, ms: 0 }
    profile.plugins.set(key, { files: plugin.files + 1, calls: plugin.calls + calls, ms: plugin.ms + time })
  }
}

// A table of the time each plugin took, most first, and that outside them.
// Keys that are paths, of plugins with no name, are made relative to root.
export function profileReport({ files, ms, plugins }, root) {
  const line = (...cells) => cells.map((cell, i) => String(cell).padStart([8, 6, 7, 9, 0][i])).join('  ')
  const row = (time, ...cells) => line(Math.round(time), ms > 0 ? ((100 * time) / ms).toFixed(1) : '0.0', ...cells)
  const sorted = [...plugins].toSorted(([, a], [, b]) => b.ms - a.ms)
  const outside = ms - sorted.reduce((sum, [, plugin]) => sum + plugin.ms, 0)
  return [
    `Babel: ${files} files, ${Math.round(ms)} ms, summed over its workers`,
    line('ms', '%', 'files', 'calls', 'plugin'),
    ...sorted.map(([key, plugin]) => row(plugin.ms, plugin.files, plugin.calls, isAbsolute(key) ? relative(root, key) : key)),
    row(outside, '', '', 'outside plugins: config, parsing, traversal, printing'),
    '',
  ].join('\n')
}

if (workerData?.babel !== undefined) {
  const { corePath, options, profile } = workerData.babel
  const core = createRequire(corePath)(corePath)
  // By plugin key, the calls and own time of its visitors and hooks, in the
  // file being transformed: a call's own, not that of a plugin it calls.
  let spent = new Map()
  let inner = 0
  const timed = (key, fn) =>
    function (...args) {
      const start = performance.now()
      const before = inner
      try {
        return fn.apply(this, args)
      } finally {
        const elapsed = performance.now() - start
        const [calls, ms] = spent.get(key) ?? [0, 0]
        spent.set(key, [calls + 1, ms + elapsed - (inner - before)])
        inner = before + elapsed
      }
    }
  const hooked = new WeakSet()
  const timeHooks = (plugin) => {
    if (hooked.has(plugin)) return
    hooked.add(plugin)
    for (const hook of ['pre', 'post', 'parserOverride', 'generatorOverride']) if (typeof plugin[hook] === 'function') plugin[hook] = timed(plugin.key, plugin[hook])
  }
  // Sync: a worker transforms one file at a time.
  const transform = (source, filename, without) => {
    if (without.length === 0 && !profile) return core.transformSync(source, { ...options, filename })
    // The config's plugins, loaded, which transformSync takes as they are.
    const config = core.loadOptionsSync({ ...options, filename })
    const plugins = config.plugins.filter(({ key }) => !without.includes(key))
    if (!profile) return core.transformSync(source, { ...config, plugins })
    plugins.forEach(timeHooks)
    for (const { key } of plugins) spent.set(key, [0, 0])
    return core.transformSync(source, { ...config, plugins, wrapPluginVisitorMethod: (key, type, fn) => timed(key, fn) })
  }
  parentPort.on('message', ({ port, source, filename, without }) => {
    const start = performance.now()
    spent = new Map()
    try {
      const { code } = transform(source, filename, without)
      port.postMessage(profile ? { code, spent: { ms: performance.now() - start, plugins: [...spent].map(([key, [calls, ms]]) => [key, calls, ms]) } } : { code })
    } catch (error) {
      port.postMessage({ error: error.message })
    }
    port.close()
  })
}
