import { newTally } from './call.js'
import { select } from './select.js'

// A run measured against requests whose matches are known. The pipeline has a dozen knobs -- the
// questions, the page size, the pick ceiling, the rounds, the final fraction, which model reads
// what -- and no way to turn one without a number to turn it by. This is the number: for each
// labelled request, how many of its known matches the run returned (recall), how much of what it
// returned was a known match (precision), and how far down the first match came (reciprocal rank),
// at the cut the caller would use.
//
// Each case is a request and the ids that match it. select() runs with no topK cut, so that a
// match the run missed can be told apart by where it was lost: below the cut (it reached the
// finalists and was scored under the ones that made it -- the scorer's or the reranker's loss) or
// dropped (no stage carried it to the finalists at all -- the compaction's, the search's, or a gate
// that asked for too little). The two call for different fixes, and a single recall would hide
// which. A result stands for the ids it holds as duplicates too, so a labelled copy of a returned
// entry counts as found.

const ratio = (part, whole) => (whole === 0 ? 0 : part / whole)

const idsOf = (result) => [result.id, ...result.duplicates]

function judge(request, relevant, results, topK) {
  const top = topK === undefined ? results : results.slice(0, topK)
  const inTop = new Set(top.flatMap(idsOf))
  const inFinal = new Set(results.flatMap(idsOf))
  const wanted = new Set(relevant)
  const hits = relevant.filter((id) => inTop.has(id))
  const belowCut = relevant.filter((id) => !inTop.has(id) && inFinal.has(id))
  const dropped = relevant.filter((id) => !inFinal.has(id))
  const relevantResults = top.filter((result) => idsOf(result).some((id) => wanted.has(id)))
  const first = top.findIndex((result) => idsOf(result).some((id) => wanted.has(id)))
  return {
    id: request.id,
    recall: ratio(hits.length, relevant.length),
    precision: ratio(relevantResults.length, top.length),
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

const mean = (runs, key) => {
  let sum = 0
  for (const run of runs) sum += run[key]
  return sum / runs.length
}

// `cases` are `{ request, relevant }`; `topK` is the cut the measures are taken at (every finalist
// when omitted); everything else is select()'s, with the table. Cases run one after another --
// each one fans out inside -- and `onCase` sees each as it lands. Returns the per-case runs, each
// with the routing and stages its select() took, the means over them, and the one tally.
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
