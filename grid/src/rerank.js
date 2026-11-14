import { call } from './call.js'
import { distinctOrdinals, expectObject, extractJSON } from './json.js'
import { mapLimit } from './pool.js'
import { blocks, listBlock, requestBlock, rerankSystem } from './prompts.js'
import { hashSeed, random, shuffle } from './random.js'

// Phase 5b: the top `window` of the pointwise ranking read side by side, as two pointwise readings share
// no scale (RankGPT, Sun et al. 2023). What a list puts first is favoured, so it is shuffled `rounds`
// times and ranked by mean position (permutation self-consistency, Tang et al. 2023).

// An order naming no candidate is re-asked; the ones a partial order leaves out follow those it names
function readOrder(size) {
  return (text) => {
    const json = expectObject(extractJSON(text), 'order')
    if (!Array.isArray(json.order)) throw new TypeError('expected {"order":[...]}')
    const order = distinctOrdinals(json.order, size).map(([n]) => n)
    if (order.length === 0) throw new TypeError('expected the order to name at least one candidate')
    return { order }
  }
}

// One round's position for each finalist: as listed, then those left out in their pointwise order
function positions(listed, head, order) {
  const places = new Map()
  for (const [index, n] of order.entries()) places.set(listed[n - 1].id, index + 1)
  let next = order.length
  for (const result of head) {
    if (places.has(result.id)) continue
    next += 1
    places.set(result.id, next)
  }
  return places
}

// `rows` give the entries, which a result does not carry. The window is ordered by mean position, then
// pointwise score, each carrying its mean as `listRank`; the rest follow unchanged.
export async function rerank({ task, request, results, rows, model, window = 20, rounds = 3, concurrency = 20, think, effort, tally, ask }) {
  const head = results.slice(0, window)
  if (head.length < 2 || rounds < 1) return { results, reranked: 0 }
  const byId = new Map(rows.map((row) => [row.id, row]))
  const missing = head.find((result) => !byId.has(result.id))
  if (missing) throw new Error(`rerank: no row for finalist ${missing.id}`)
  const systemPrompt = rerankSystem(task)
  const sums = new Map(head.map((result) => [result.id, 0]))
  await mapLimit(Array.from({ length: rounds }, (_, round) => round), concurrency, async (round) => {
    const listed = shuffle(head, random(hashSeed(`${task.id}\u0000${request.id}\u0000rerank\u0000${round}`)))
    const { order } = await call({
      type: 'grid.rerank', model, systemPrompt,
      userContent: blocks(requestBlock(request), listBlock(listed.map((result) => byId.get(result.id)))),
      parse: readOrder(listed.length), think, effort, tally, ask, label: `rerank ${request.id} round ${round}`,
    })
    for (const [id, place] of positions(listed, head, order)) sums.set(id, sums.get(id) + place)
  })
  const ordered = head
    .map((result) => ({ ...result, listRank: sums.get(result.id) / rounds }))
    .sort((a, b) => a.listRank - b.listRank || b.score - a.score || a.id.localeCompare(b.id))
  return { results: [...ordered, ...results.slice(head.length)], reranked: head.length }
}
