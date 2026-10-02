import { Queue } from '@chalker/queue'
import { refusalOf } from './error.js'

const CONCURRENCY = 8

// Runs `job` on each of `items`, a few at a time, so that a large lockfile
// does not start a request for each at once. The first failure stops the
// rest from starting, and is thrown once every started job has ended, so
// that none goes on fetching or writing a cache after the call returns.
// `whereOf(item)`, where given, is the `where` for refusalOf.
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
