import { call } from './call.js'
import { expectObject, extractJSON } from './json.js'
import { mapLimit } from './pool.js'
import { blocks, pageBlock, requestBlock, searchSystem } from './prompts.js'
import { hashSeed, paginate, random, shuffle } from './random.js'

// Phases 2 to 4: the rows against the request, a page at a time, interlaced over several shuffles
// and repeated on the survivors until few enough are left for the full-text stage.
//
// A page call is a RELATIVE judgement -- a row is picked against the rows beside it -- and that is
// the bias the rounds exist to average out: a row that looks good only beside junk is picked in
// one shuffle and not the next, while a true match is picked in every one. So a row survives a
// stage on VOTES, picked in at least `minVotes` of `rounds` page contexts, and is ranked by its
// votes and then its mean score. The cap per page is a ceiling, stated on the page: the model may
// pick fewer, and a page of nothing yields nothing.

// Scores are kept inside the asked range; a pick with no readable score is still a pick, at the
// middle of it.
function clampScore(value) {
  const score = Number(value)
  return Number.isFinite(score) ? Math.min(10, Math.max(1, score)) : 5
}

// The picks as ordinals on this page: unknown, repeated and out-of-range ones dropped, and the
// best `cap` kept when the model picked past its limit. Run as the call's parse, so a cached
// response is read under the same rules as a fresh one.
function readPicks(size, cap) {
  return (text) => {
    const json = expectObject(extractJSON(text), 'picks')
    if (!Array.isArray(json.picks)) throw new TypeError('expected {"picks":[...]}')
    const seen = new Set()
    const picks = []
    for (const pick of json.picks) {
      const n = Number(pick?.n)
      if (!Number.isInteger(n) || n < 1 || n > size || seen.has(n)) continue
      seen.add(n)
      picks.push({ n, score: clampScore(pick.score) })
    }
    picks.sort((a, b) => b.score - a.score)
    return { picks: picks.slice(0, cap) }
  }
}

// What a full-text row costs on the page beyond its entry: the ordinal line and the blank line
// after it. Generous, so a page of short entries is bounded by what is actually sent.
const FULL_ROW_FRAME = 16

// Which block is the shared prompt-cache prefix. The page first when many requests will read the
// same pages -- the first stage, whose shuffles are seeded from the rows alone so every request
// renders the same pages -- and the request first once the pages are this request's own.
const layout = (page, request, requestFirst) => (requestFirst ? blocks(requestBlock(request), page) : blocks(page, requestBlock(request)))

// One stage: `rounds` shuffles of the rows, paged, every page asked once; returns the rows that
// gathered enough votes, best first. `seed` fixes the shuffles; `mode` is 'summary' for the table
// and 'full' for a pass over the entries themselves, paged by characters as well as by count --
// the count bound alone would put a hundred pages of text on one page, and the character bound
// alone would put thousands of empty entries there.
export async function search({ task, request, rows, columns = [], model, mode = 'summary', pageSize = 200, pageChars = 80_000, pick = 0.2, rounds = 3, minVotes = 2, seed = 0, requestFirst = false, concurrency = 20, think, effort, tally, ask, label = 'search' }) {
  const systemPrompt = searchSystem({ task, mode })
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
  const survivors = [...tallies.values()]
    .filter((entry) => entry.votes >= minVotes)
    .map(({ row, votes, total }) => ({ row, votes, score: total / votes }))
    .sort((a, b) => b.votes - a.votes || b.score - a.score || a.row.id.localeCompare(b.row.id))
  return { survivors, pages }
}

// Stages until at most `target` rows are left, or no stage shrinks the set. Each stage's shuffles
// are seeded from the task and the rows it starts from -- not from the request -- so two requests
// against one table see the same first-stage pages, and a re-run sees them all again.
//
// A stage's pick ceiling is `pick` of each page, or what retaining `target` rows needs if that is
// more: the ceiling is there to stop a page of nothing from promoting its least bad rows, not to
// cut a stage below the number the full-text reading is owed. Left at `pick` alone, a table just
// above the target would be cut to a fifth of a page's worth on its way to it.
//
// A later stage that picks nothing does not empty the result: the survivors it was handed are the
// best the earlier stages found, ranked, and the full-text stage will judge them. Only a FIRST
// stage picking nothing means nothing: there is no earlier ranking to fall back on.
export async function narrow({ rows, target, maxStages = 6, requestFirst = false, pick = 0.2, ...opts }) {
  const stages = []
  let current = rows.map((row) => ({ row, votes: 0, score: 0 }))
  for (let stage = 0; stage < maxStages && current.length > target; stage++) {
    const ids = current.map((entry) => entry.row.id)
    const seed = hashSeed(`${opts.task.id}\u0000${stage}\u0000${ids.join('\u0000')}`)
    const { survivors, pages } = await search({
      ...opts, rows: current.map((entry) => entry.row), seed, pick: Math.max(pick, target / current.length),
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
