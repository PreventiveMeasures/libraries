import { call } from './call.js'
import { expectObject, extractJSON, numberOf } from './json.js'
import { mapLimit } from './pool.js'
import { blocks, listBlock, requestBlock, rerankSystem } from './prompts.js'
import { hashSeed, random, shuffle } from './random.js'

// Phase 5b: the top of the pointwise ranking read once more, as a list, and ordered.
//
// A pointwise score is given with no other finalist in view, and two calls do not share a scale:
// the 85 one finalist got and the 85 another got are two readings, not a tie, and the order among
// close finalists -- the part of the result a caller actually uses -- is where that noise lands.
// A listwise reading has the finalists side by side, so it ranks them against each other rather
// than against a number (RankGPT, Sun et al. 2023). It has a bias of its own, though: what sits
// first in the list is favoured whatever it says ("lost in the middle", Liu et al. 2023), so the
// list is shuffled `rounds` times and the orders aggregated by mean position -- permutation
// self-consistency (Tang et al. 2023), which is the remedy the search already applies to its pages.
//
// Only the top `window` finalists are read this way: the pointwise pass decided who is in
// contention, this pass decides the order among them, and a window of twenty full entries is one
// call's worth of context where the whole finalist pool would be several windows that cannot see
// each other. The rest keep their pointwise order after the window. The request is the shared
// prompt-cache prefix of every round; the shuffled list follows it.

// The order as ordinals on the list, under the same rules as a page's picks: unknown, repeated and
// out-of-range ordinals dropped, and an ordinal that is not a number refused rather than coerced.
// An order naming no row at all is re-asked; a partial one is kept, and the rows it left out follow
// the ones it named.
function readOrder(size) {
  return (text) => {
    const json = expectObject(extractJSON(text), 'order')
    if (!Array.isArray(json.order)) throw new TypeError('expected {"order":[...]}')
    const seen = new Set()
    const order = []
    for (const item of json.order) {
      const n = numberOf(item)
      if (n === undefined || !Number.isInteger(n) || n < 1 || n > size || seen.has(n)) continue
      seen.add(n)
      order.push(n)
    }
    if (order.length === 0) throw new TypeError('expected the order to name at least one candidate')
    return { order }
  }
}

// One round's position for every finalist of the window: the ones the model listed at the places
// it listed them, then the ones it left out in the order they came in -- their pointwise rank --
// after the last it named. Leaving a row out is read as ranking it below the rows named, not as a
// verdict of nothing.
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

// `results` as score() ranks them; `rows` the table the ids are read from, since a result carries
// the summary and not the entry. Returns the results with the window ordered by mean position over
// the rounds, ties broken by the pointwise score, each carrying its mean as `listRank`, and the
// rest after them unchanged; and how many were ordered this way.
export async function rerank({ task, request, results, rows, model, window = 20, rounds = 3, concurrency = 20, think, effort, tally, ask }) {
  const head = results.slice(0, window)
  if (head.length < 2 || rounds < 1) return { results, reranked: 0 }
  const byId = new Map(rows.map((row) => [row.id, row]))
  for (const result of head) {
    if (!byId.has(result.id)) throw new Error(`rerank: no row for finalist ${result.id}`)
  }
  const systemPrompt = rerankSystem(task)
  const sums = new Map(head.map((result) => [result.id, 0]))
  const roundsOf = Array.from({ length: rounds }, (_, round) => round)
  await mapLimit(roundsOf, concurrency, async (round) => {
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
