import { call } from './call.js'
import { distinctOrdinals, expectObject, extractJSON, numberOf } from './json.js'
import { mapLimit } from './pool.js'
import { blocks, pageBlock, requestBlock, searchSystem } from './prompts.js'
import { hashSeed, paginate, random, shuffle } from './random.js'

// Phases 2 to 4: pages of rows against the request over several shuffles, repeated on the survivors.
// A page is a relative judgement, so a row survives on votes across the rounds' page contexts: one that
// looks good only beside junk is picked in one shuffle and not the next, a true match in every one.

// A pick with no readable score is still a pick, at the middle of the range
function clampScore(value) {
  const score = numberOf(value)
  return score === undefined ? 5 : Math.min(10, Math.max(1, score))
}

// The best `cap` picks where the model picked past its limit; as the call's parse, cached responses too
function readPicks(size, cap) {
  return (text) => {
    const json = expectObject(extractJSON(text), 'picks')
    if (!Array.isArray(json.picks)) throw new TypeError('expected {"picks":[...]}')
    const picks = distinctOrdinals(json.picks, size, (pick) => pick?.n).map(([n, pick]) => ({ n, score: clampScore(pick.score) }))
    picks.sort((a, b) => b.score - a.score)
    return { picks: picks.slice(0, cap) }
  }
}

// What a full-text row costs beyond its entry, generously: its ordinal line and the blank after it
const FULL_ROW_FRAME = 16

// The shared prompt-cache prefix: the page while every request renders the same pages, as in the first
// stage, and the request once the pages are this request's own
const layout = (page, request, requestFirst) => (requestFirst ? blocks(requestBlock(request), page) : blocks(page, requestBlock(request)))

// One stage: `rounds` shuffles of the rows, paged, every page asked once, by count and in full mode also
// by characters. `minVotes` is a majority of the rounds, never more than them. `fill` hands on the best
// of the rows picked at all, up to it, when fewer reach the threshold: rounds can each pick another set.
export async function search({ task, request, rows, columns = [], model, mode = 'summary', pageSize = 200, pageChars = 80_000, pick = 0.2, rounds = 3, minVotes = Math.ceil(rounds / 2), fill, seed = 0, requestFirst = false, concurrency = 20, think, effort, tally, ask, label = 'search' }) {
  const systemPrompt = searchSystem({ task, mode })
  const needed = Math.max(1, Math.min(minVotes, rounds))
  const tallies = new Map(rows.map((row) => [row.id, { row, votes: 0, total: 0 }]))
  const paging = mode === 'full' ? { size: pageSize, maxWeight: pageChars, weigh: (row) => row.entry.length + FULL_ROW_FRAME } : { size: pageSize }
  let pages = 0
  for (let round = 0; round < rounds; round++) {
    const ordered = shuffle(rows, random(hashSeed(`${seed}\u0000${round}`)))
    const paged = paginate(ordered, paging)
    pages += paged.length
    await mapLimit(paged, concurrency, async (page, index) => {
      const cap = Math.max(1, Math.ceil(page.length * pick))
      const { picks } = await call({
        type: 'grid.search', model, systemPrompt, userContent: layout(pageBlock({ page, columns, mode, cap }), request, requestFirst),
        parse: readPicks(page.length, cap), think, effort, tally, ask, label: `${label} round ${round} page ${index}`,
      })
      for (const { n, score } of picks) {
        const entry = tallies.get(page[n - 1].id)
        entry.votes += 1
        entry.total += score
      }
    })
  }
  // Every row picked at all, best first: the survivors are a prefix, and the fill follows them
  const ranked = [...tallies.values()]
    .filter((entry) => entry.votes > 0)
    .map(({ row, votes, total }) => ({ row, votes, score: total / votes }))
    .sort((a, b) => b.votes - a.votes || b.score - a.score || a.row.id.localeCompare(b.row.id))
  const reached = ranked.filter((entry) => entry.votes >= needed).length
  const survivors = ranked.slice(0, Math.max(reached, fill ?? 0))
  return { survivors, pages }
}

// Stages until at most `target` rows are left or one stops shrinking the set, seeded from the task and
// the rows, never the request. The pick ceiling rises to what keeping `target` rows needs, and a later
// stage picking nothing keeps what it was handed: only a first stage picking nothing means nothing.
export async function narrow({ rows, target, maxStages = 6, requestFirst = false, pick = 0.2, ...opts }) {
  const stages = []
  let current = rows.map((row) => ({ row, votes: 0, score: 0 }))
  for (let stage = 0; stage < maxStages && current.length > target; stage++) {
    const ids = current.map((entry) => entry.row.id)
    const seed = hashSeed(`${opts.task.id}\u0000${stage}\u0000${ids.join('\u0000')}`)
    const { survivors, pages } = await search({
      ...opts, rows: current.map((entry) => entry.row), seed, pick: Math.max(pick, target / current.length), fill: target,
      requestFirst: requestFirst || stage > 0, label: `${opts.label ?? 'search'} stage ${stage}`,
    })
    stages.push({ stage, rows: current.length, survivors: survivors.length, pages })
    if (survivors.length === 0) {
      if (stage === 0) current = []
      break
    }
    const shrank = survivors.length < current.length
    current = survivors
    if (!shrank) break
  }
  return { candidates: current.slice(0, target), stages }
}
