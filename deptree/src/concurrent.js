import { Queue } from '@chalker/queue'
import { refusalOf } from './error.js'

const CONCURRENCY = 8

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

// Each of `values` awaited at once, the first failure by position thrown once
// all have ended, as eachConcurrently throws one.
export async function settled(values) {
  const results = await Promise.allSettled(values)
  const failed = results.find(({ status }) => status === 'rejected')
  if (failed !== undefined) throw failed.reason
  return results.map(({ value }) => value)
}
