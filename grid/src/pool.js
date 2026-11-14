// `fn` over every item, at most `limit` in flight, results in input order. The first failure stops the
// pool, which rejects with it once every started item has settled: no call then writes the cache or the
// tally behind a caller that has moved on. The transport has its own ceiling; this one bounds memory.
export async function mapLimit(items, limit, fn) {
  const results = Array.from({ length: items.length })
  let next = 0
  let failure
  const worker = async () => {
    while (next < items.length && failure === undefined) {
      const index = next++
      try {
        results[index] = await fn(items[index], index)
      } catch (err) {
        failure ??= { err }
      }
    }
  }
  // At least one worker: a limit that is not a positive number would otherwise make none, doing nothing
  const workers = Math.max(1, Math.min(Math.floor(limit) || 0, items.length))
  await Promise.all(Array.from({ length: workers }, worker))
  if (failure) throw failure.err
  return results
}
