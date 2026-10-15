import { DEFAULT_MODEL } from '@preventive/ai'
import { newTally } from './call.js'
import { compact } from './compact.js'
import { gate } from './schema.js'
import { score } from './score.js'
import { narrow } from './search.js'

// The whole pipeline for one request against one table: the gate, the extra columns or the
// full-text pass it asked for, the narrowing search over summaries, and the full-text scoring of
// what is left. The table (`rows`, with the `questions` and `focus` it was compacted under) comes
// from buildTable and is shared by every request; everything here is per request.
//
// Three models, because three kinds of work: `strong` reads the request and the finalists, and
// decides the schema; `search` reads pages of summaries, hundreds of them per request; `cheap`
// does whatever the gate sends over the WHOLE dataset again, which is the one place volume rules.
// Each defaults to the one before it, so naming only `strong` runs everything on it.

const resolveModels = ({ strong = DEFAULT_MODEL, search = strong, cheap = search } = {}) => ({ strong, search, cheap })

// How many rows the full-text stage reads: `final` of the table, but never under `minFinal`, since
// a small table narrowed to one percent would hand the last stage a single row.
const finalTarget = (count, final, minFinal) => Math.min(count, Math.max(minFinal, Math.ceil(count * final)))

// Extra columns for this request, appended to every row's answers behind the task's own, under the
// `x` ids the gate gave them; the row's own fields are untouched, since the table is shared.
async function supplement({ task, rows, extraQuestions, model, ...rest }) {
  const entries = rows.map((row) => ({ id: row.id, text: row.entry }))
  const extra = await compact({ task, questions: extraQuestions, entries, model, summarize: false, ...rest })
  const byId = new Map(extra.map((row) => [row.id, row.answers]))
  return rows.map((row) => ({ ...row, answers: [...row.answers, ...byId.get(row.id)] }))
}

// Two candidate lists into one, by id. The lists are ranked on different evidence (summaries by one
// model, entries by a cheaper one), so nothing is summed: a row in both keeps whichever reading
// gave it more votes, then the higher mean score, since that is the tie-break the scoring stage
// reads back. The scoring stage ranks the union on its own scale either way.
export function union(first, second) {
  const byId = new Map(first.map((entry) => [entry.row.id, entry]))
  for (const entry of second) {
    const held = byId.get(entry.row.id)
    const stronger = !held || entry.votes > held.votes || (entry.votes === held.votes && entry.score > held.score)
    if (stronger) byId.set(entry.row.id, entry)
  }
  return [...byId.values()]
}

export async function select({ task, focus, questions, rows, request, models, topK, final = 0.01, minFinal = 20, useGate = true, search: searchOpts = {}, concurrency = 20, think, effort, tally = newTally(), ask }) {
  const { strong, search: searchModel, cheap } = resolveModels(models)
  const shared = { task, request, concurrency, think, effort, tally, ask }
  const target = finalTarget(rows.length, final, minFinal)

  const routing = useGate
    ? await gate({ task, focus, questions, request, model: strong, think, effort, tally, ask })
    : { extraQuestions: [], fullScan: false, reason: 'gate skipped' }

  let columns = questions
  let table = rows
  if (routing.extraQuestions.length > 0) {
    columns = [...questions, ...routing.extraQuestions]
    table = await supplement({ task, rows, extraQuestions: routing.extraQuestions, model: cheap, concurrency, think, effort, tally, ask })
  }

  // Extra columns make every page this request's own, so there is no shared page prefix left to
  // keep and the request is the prefix from the first stage on; a caller's explicit choice still wins.
  const supplemented = table !== rows
  const narrowed = await narrow({
    ...shared, ...searchOpts, requestFirst: searchOpts.requestFirst ?? supplemented,
    rows: table, columns, model: searchModel, target, mode: 'summary', label: 'search',
  })
  let candidates = narrowed.candidates
  let fullStages = []
  if (routing.fullScan) {
    const full = await narrow({ ...shared, ...searchOpts, rows: table, model: cheap, target, mode: 'full', requestFirst: true, label: 'full' })
    candidates = union(candidates, full.candidates)
    fullStages = full.stages
  }

  const ranked = await score({ ...shared, candidates, model: strong })
  return {
    results: topK === undefined ? ranked : ranked.slice(0, topK),
    gate: routing,
    stages: narrowed.stages,
    fullStages,
    tally,
  }
}
