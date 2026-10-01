// The packages a tree is built of are fetched and unpacked a few at a
// time, so that a large lockfile does not start a request for each at
// once.

const CONCURRENCY = 8

// Runs `job` on each of `items`, a few at a time. The first failure stops
// the rest from starting, and is thrown once every job started has ended,
// so that none goes on, fetching or writing a cache, after the call has.
export async function eachConcurrently(items, job) {
  const queue = [...items]
  let failure
  const worker = async () => {
    while (queue.length > 0 && failure === undefined) {
      try {
        await job(queue.shift())
      } catch (error) {
        failure ??= { error }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker))
  if (failure !== undefined) throw failure.error
}
