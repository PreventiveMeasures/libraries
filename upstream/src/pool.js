// `fn` over `items`, at most `limit` at a time; results in `items` order.
export async function pool(items, limit, fn) {
  const results = []
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  }))
  return results
}
