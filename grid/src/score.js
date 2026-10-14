import { call } from './call.js'
import { expectObject, extractJSON } from './json.js'
import { mapLimit } from './pool.js'
import { blocks, candidateBlock, requestBlock, scoreSystem } from './prompts.js'

// Phase 5: the finalists, each in full against the request in full, on an absolute scale. The
// search ranked them on relative judgements over summaries; this is the one reading of the actual
// entries, and the order it produces is the result.
//
// The request is the shared prefix of every call here, so one request against two hundred
// finalists writes it to the prompt cache once and reads it after.

function readScore(text) {
  const json = expectObject(extractJSON(text), 'score and reason')
  const value = Number(json.score)
  if (!Number.isFinite(value)) throw new TypeError('expected a numeric score')
  return { score: Math.min(100, Math.max(0, value)), reason: typeof json.reason === 'string' ? json.reason.trim() : '' }
}

// `candidates` are `{ row, votes, score }` as the search ranks them; the votes come along into the
// result as the tie-break and as a trace of how each finalist got here.
export async function score({ task, request, candidates, model, concurrency = 20, think, effort, tally, ask }) {
  const systemPrompt = scoreSystem(task)
  const scored = await mapLimit(candidates, concurrency, async ({ row, votes }) => {
    const { score: value, reason } = await call({
      type: 'grid.score', model, systemPrompt, userContent: blocks(requestBlock(request), candidateBlock(row)),
      parse: readScore, think, effort, tally, ask, label: `score ${request.id} ${row.id}`,
    })
    return { id: row.id, score: value, reason, votes, summary: row.summary }
  })
  return scored.sort((a, b) => b.score - a.score || b.votes - a.votes || a.id.localeCompare(b.id))
}
