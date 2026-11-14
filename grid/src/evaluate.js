import { newTally } from './call.js'
import { select } from './select.js'

// A run measured against requests whose matches are known: recall, precision and reciprocal rank at the
// cut. A miss is `belowCut` where it reached the finalists and was scored under it, `dropped` where no
// stage carried it there, as the two call for different fixes; a result counts for its copies too.

const ratio = (part, whole) => (whole === 0 ? 0 : part / whole)

const idsOf = (result) => [result.id, ...result.duplicates]

function judge(request, relevant, results, topK) {
  const top = topK === undefined ? results : results.slice(0, topK)
  const inTop = new Set(top.flatMap(idsOf))
  const inFinal = new Set(results.flatMap(idsOf))
  const wanted = new Set(relevant)
  const isMatch = (result) => idsOf(result).some((id) => wanted.has(id))
  const hits = relevant.filter((id) => inTop.has(id))
  const belowCut = relevant.filter((id) => !inTop.has(id) && inFinal.has(id))
  const dropped = relevant.filter((id) => !inFinal.has(id))
  const first = top.findIndex(isMatch)
  return {
    id: request.id,
    recall: ratio(hits.length, relevant.length),
    precision: ratio(top.filter(isMatch).length, top.length),
    reciprocalRank: first < 0 ? 0 : 1 / (first + 1),
    returned: top.length,
    hits,
    belowCut,
    dropped,
  }
}

function checkCases(cases) {
  if (!Array.isArray(cases) || cases.length === 0) throw new TypeError('evaluate: expected at least one case')
  for (const [index, item] of cases.entries()) {
    const request = item?.request
    if (typeof request?.id !== 'string' || typeof request?.text !== 'string') throw new TypeError(`evaluate: case ${index} has no request`)
    if (!Array.isArray(item.relevant) || !item.relevant.every((id) => typeof id === 'string')) throw new TypeError(`evaluate: case ${request.id} has no relevant ids`)
  }
}

const mean = (runs, key) => runs.reduce((sum, run) => sum + run[key], 0) / runs.length

// Cases one after another, each fanning out inside, select() with no cut so that a miss can be placed
export async function evaluate({ cases, topK, onCase, tally = newTally(), ...options }) {
  checkCases(cases)
  const runs = []
  for (const { request, relevant } of cases) {
    const { results, gate, stages, fullStages, reranked } = await select({ ...options, request, tally })
    const run = { ...judge(request, relevant, results, topK), gate, stages, fullStages, reranked }
    onCase?.(run)
    runs.push(run)
  }
  return { runs, recall: mean(runs, 'recall'), precision: mean(runs, 'precision'), mrr: mean(runs, 'reciprocalRank'), tally }
}
