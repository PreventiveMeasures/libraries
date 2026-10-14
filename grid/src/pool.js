// A bounded fan-out: `fn` over every item, at most `limit` in flight, results in input order. The
// transport under the model calls has its own global ceiling (ai's setFetchConcurrency), so this
// one is about what sits in memory and open on disk at once -- a compaction fans out over twenty
// thousand entries, and twenty thousand pending cache reads is not a concurrency, it is a leak.
//
// The first failure stops the pool: workers finish the item they hold and take no more, so an
// aborted run does not go on spending requests behind an error nobody will read the results of.
export async function mapLimit(items, limit, fn) {
  const results = Array.from({ length: items.length })
  let next = 0
  let failed = false
  const worker = async () => {
    while (next < items.length && !failed) {
      const index = next++
      try {
        results[index] = await fn(items[index], index)
      } catch (err) {
        failed = true
        throw err
      }
    }
  }
  const workers = Math.max(1, Math.min(limit, items.length))
  await Promise.all(Array.from({ length: workers }, worker))
  return results
}
