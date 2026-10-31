import { Queue } from '@chalker/queue'
import { refusalOf } from './error.js'

// Sixteen at a time, as pnpm's network-concurrency is by default: a cold
// fetch waits on the registry for each tarball and its version document, a
// warm one on the main thread, which more at once does not speed.
const CONCURRENCY = 16

// A few at a time, so a large lockfile does not start every request at once.
// The first failure is thrown once every started job has ended, so that none
// goes on fetching or writing a cache after the call returns.
export async function eachConcurrently(items, job, whereOf) {
  const queue = new Queue(CONCURRENCY)
  let failure
  await Promise.all([...items].map(async (item) => {
    await queue.claim()
    try {
      if (failure === undefined) await job(item)
    } catch (error) {
      failure ??= { error: whereOf === undefined ? error : refusalOf(error, whereOf(item)) }
    } finally {
      queue.release()
    }
  }))
  if (failure !== undefined) throw failure.error
}

// A job a few at a time across calls, as eachConcurrently runs them within
// one: what a lazy tree fetches as each package is asked for.
export function limited() {
  const queue = new Queue(CONCURRENCY)
  return async (job) => {
    await queue.claim()
    try {
      return await job()
    } finally {
      queue.release()
    }
  }
}

// Each of `values` awaited at once, the first failure by position thrown once
// all have ended, as eachConcurrently throws one.
export async function settled(values) {
  const results = await Promise.allSettled(values)
  const failed = results.find(({ status }) => status === 'rejected')
  if (failed !== undefined) throw failed.reason
  return results.map(({ value }) => value)
}
