import { DEFAULT_MODEL } from '@preventive/ai'
import { newTally } from './call.js'
import { compact } from './compact.js'
import { rerank } from './rerank.js'
import { gate } from './schema.js'
import { score } from './score.js'
import { narrow } from './search.js'

// The pipeline for one request against a shared table: the gate, the extra columns or full-text pass it
// asks for, the search, the full-text scoring and the listwise ordering. `strong` reads the request and
// the finalists, `search` the pages, `cheap` whatever goes over the whole dataset again.

const resolveModels = ({ strong = DEFAULT_MODEL, search = strong, cheap = search } = {}) => ({ strong, search, cheap })

// `final` of the table, never under `minFinal`: a small table at one percent would be one row
const finalTarget = (count, final, minFinal) => Math.min(count, Math.max(minFinal, Math.ceil(count * final)))

// The request's extra answers after each row's own, on copies, as the table is shared
async function supplement({ task, rows, extraQuestions, model, ...rest }) {
  const entries = rows.map((row) => ({ id: row.id, text: row.entry }))
  const extra = await compact({ task, questions: extraQuestions, entries, model, summarize: false, ...rest })
  const byId = new Map(extra.map((row) => [row.id, row.answers]))
  return rows.map((row) => ({ ...row, answers: [...row.answers, ...byId.get(row.id)] }))
}

// The two lists ranked on different evidence, so nothing is summed: a row in both keeps the reading with
// more votes, then the higher mean score
export function union(first, second) {
  const byId = new Map(first.map((entry) => [entry.row.id, entry]))
  for (const entry of second) {
    const held = byId.get(entry.row.id)
    const stronger = !held || entry.votes > held.votes || (entry.votes === held.votes && entry.score > held.score)
    if (stronger) byId.set(entry.row.id, entry)
  }
  return [...byId.values()]
}

// A copy (`dupOf` set, whatever its value, as an id can be '') is never searched or scored: its original
// is, and carries its id out in the result
export async function select({ task, focus, questions, rows, request, models, topK, final = 0.01, minFinal = 20, useGate = true, search: searchOpts = {}, rerank: rerankOpts = {}, concurrency = 20, think, effort, tally = newTally(), ask }) {
  const { strong, search: searchModel, cheap } = resolveModels(models)
  const shared = { task, request, concurrency, think, effort, tally, ask }
  const live = rows.filter((row) => row.dupOf === undefined)
  const target = finalTarget(live.length, final, minFinal)

  const routing = useGate
    ? await gate({ task, focus, questions, request, model: strong, think, effort, tally, ask })
    : { extraQuestions: [], fullScan: false, reason: 'gate skipped' }

  const extra = routing.extraQuestions.length > 0
  const columns = extra ? [...questions, ...routing.extraQuestions] : questions
  const table = extra ? await supplement({ task, rows: live, extraQuestions: routing.extraQuestions, model: cheap, concurrency, think, effort, tally, ask }) : live

  // Extra columns make every page this request's own, so the request leads from the first stage on
  const narrowed = await narrow({
    ...shared, ...searchOpts, requestFirst: searchOpts.requestFirst ?? extra,
    rows: table, columns, model: searchModel, target, mode: 'summary', label: 'search',
  })
  const full = routing.fullScan
    ? await narrow({ ...shared, ...searchOpts, rows: table, model: cheap, target, mode: 'full', requestFirst: true, label: 'full' })
    : { candidates: [], stages: [] }

  const ranked = await score({ ...shared, candidates: union(narrowed.candidates, full.candidates), model: strong })
  const listed = rerankOpts === false
    ? { results: ranked, reranked: 0 }
    : await rerank({ ...shared, ...rerankOpts, results: ranked, rows: live, model: strong })
  return {
    results: topK === undefined ? listed.results : listed.results.slice(0, topK),
    reranked: listed.reranked,
    gate: routing,
    stages: narrowed.stages,
    fullStages: full.stages,
    tally,
  }
}
