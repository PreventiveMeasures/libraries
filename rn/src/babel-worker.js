// Babel's transforms, off the main thread: each worker loads the project's
// @babel/core and its config once, and transforms what it is sent.

import { once } from 'node:events'
import { createRequire } from 'node:module'
import { availableParallelism } from 'node:os'
import { MessageChannel, Worker, parentPort, workerData } from 'node:worker_threads'

// (corePath, options) => async (source, filename) => code, by the
// @babel/core at corePath, with options (all but the filename) for each file.
export function babelWorkers(corePath, options) {
  const max = availableParallelism() >= 4 ? 2 : 1
  const workers = []
  const pick = () => {
    const idle = workers.find(({ busy }) => busy === 0)
    if (idle !== undefined || workers.length >= max) return idle ?? workers.reduce((a, b) => (b.busy < a.busy ? b : a))
    const info = { worker: new Worker(new URL(import.meta.url), { workerData: { babel: { corePath, options } } }), busy: 0, pending: new Set() }
    info.worker.unref()
    // A worker that dies fails what it was given, which would wait forever.
    info.worker.on('error', (error) => {
      for (const reject of info.pending) reject(error)
    })
    workers.push(info)
    return info
  }
  return async (source, filename) => {
    const info = pick()
    const { port1, port2 } = new MessageChannel()
    const { promise: failed, reject } = Promise.withResolvers()
    info.busy++
    info.pending.add(reject)
    try {
      info.worker.postMessage({ port: port1, source, filename }, [port1])
      const [{ code, error }] = await Promise.race([once(port2, 'message'), failed])
      if (error !== undefined) throw new Error(error)
      return code
    } finally {
      info.busy--
      info.pending.delete(reject)
      port2.close()
    }
  }
}

if (workerData?.babel !== undefined) {
  const { corePath, options } = workerData.babel
  const core = createRequire(corePath)(corePath)
  parentPort.on('message', async ({ port, source, filename }) => {
    try {
      port.postMessage({ code: (await core.transformAsync(source, { ...options, filename })).code })
    } catch (error) {
      port.postMessage({ error: error.message })
    }
    port.close()
  })
}
