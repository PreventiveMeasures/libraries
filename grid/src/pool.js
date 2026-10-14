// A bounded fan-out: `fn` over every item, at most `limit` in flight, results in input order. The
// transport under the model calls has its own global ceiling (ai's setFetchConcurrency), so this
// one is about what sits in memory and open on disk at once -- a compaction fans out over twenty
// thousand entries, and twenty thousand pending cache reads is not a concurrency, it is a leak.
//
// The first failure stops the pool: workers finish the item they hold and take no more, and the
// pool rejects with that first error only once every started item has settled. Rejecting sooner
// would hand control back while sibling calls are still writing the cache and the tally behind a
// caller that has moved on -- or, in the CLI, closing the provider under them.
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
  const workers = Math.max(1, Math.min(limit, items.length))
  await Promise.all(Array.from({ length: workers }, worker))
  if (failure) throw failure.err
  return results
}
