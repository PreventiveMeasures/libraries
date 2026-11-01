// Babel's transforms, off the main thread: each worker loads the project's
// @babel/core and its config once, and transforms what it is sent.

import { once } from 'node:events'
import { createRequire } from 'node:module'
import { availableParallelism } from 'node:os'
import { MessageChannel, Worker, parentPort, workerData } from 'node:worker_threads'

// (corePath, options) => async (source, filename, without = []) => code, by
// the @babel/core at corePath, with options (all but the filename) for each
// file, its config's plugins of the keys in without left out.
export function babelWorkers(corePath, options) {
  const max = availableParallelism() >= 4 ? 2 : 1
  const workers = []
  const pick = () => {
    const idle = workers.find(({ busy }) => busy === 0)
    if (idle !== undefined || workers.length >= max) return idle ?? workers.reduce((a, b) => (b.busy < a.busy ? b : a))
    const info = { worker: new Worker(new URL(import.meta.url), { workerData: { babel: { corePath, options } } }), busy: 0, pending: new Set() }
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
      const [{ code, error }] = await Promise.race([once(port2, 'message'), failed])
      if (error !== undefined) throw new Error(error)
      return code
    } finally {
      if (--info.busy === 0) info.worker.unref()
      info.pending.delete(reject)
      port2.close()
    }
  }
}

if (workerData?.babel !== undefined) {
  const { corePath, options } = workerData.babel
  const core = createRequire(corePath)(corePath)
  const transform = async (source, filename, without) => {
    if (without.length === 0) return core.transformAsync(source, { ...options, filename })
    // The config's plugins, loaded, which transformAsync takes as they are.
    const config = await core.loadOptionsAsync({ ...options, filename })
    return core.transformAsync(source, { ...config, plugins: config.plugins.filter(({ key }) => !without.includes(key)) })
  }
  parentPort.on('message', async ({ port, source, filename, without }) => {
    try {
      port.postMessage({ code: (await transform(source, filename, without)).code })
    } catch (error) {
      port.postMessage({ error: error.message })
    }
    port.close()
  })
}
