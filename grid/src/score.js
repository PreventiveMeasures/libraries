import { call } from './call.js'
import { expectObject, extractJSON, numberOf } from './json.js'
import { mapLimit } from './pool.js'
import { blocks, candidateBlock, requestBlock, scoreSystem } from './prompts.js'

// Phase 5: the finalists, each in full against the request in full, on an absolute scale. The
// search ranked them on relative judgements over summaries; this is the first reading of the actual
// entries, and its score is what a caller cuts by. The order among the top of them is then read
// once more as a list (rerank.js), since an absolute scale given one finalist at a time is noisy
// exactly there.
//
// The request is the shared prefix of every call here, so one request against two hundred
// finalists writes it to the prompt cache once and reads it after.

// A score that is not a number is re-asked, not coerced: null or a boolean would read as 0 or 1
// and be cached as the finalist's verdict. The reason and the evidence are re-asked too when
// missing or not text: they are what the result carries for the score, and an empty one, once
// cached, would stay empty for every later run.
function readScore(text) {
  const json = expectObject(extractJSON(text), 'score, reason and evidence')
  const value = numberOf(json.score)
  if (value === undefined) throw new TypeError('expected a numeric score')
  const reason = typeof json.reason === 'string' ? json.reason.trim() : ''
  if (!reason) throw new TypeError('expected a reason for the score')
  const evidence = typeof json.evidence === 'string' ? json.evidence.trim() : ''
  if (!evidence) throw new TypeError('expected the evidence quoted from the candidate')
  return { score: Math.min(100, Math.max(0, value)), reason, evidence }
}

// Whether the evidence is in the entry word for word. The model was asked to copy a span, and
// whether it did is the one check on the score's reasoning that costs no model call: a quote that
// is not there was reasoned about something the entry does not say. Both sides are folded to lower
// case, straight quotes and single spaces; the quote loses the quotation marks a model wraps it in
// and the stop it ends it with, and nothing else -- a `#1`, a `--flag` or a `C++` keeps the
// characters that make it what it is, or the check would pass on the bare word -- and a quote with
// an ellipsis is several spans, each of which has to be there.
const fold = (text) => text.toLowerCase().replace(/[‘’]/gu, "'").replace(/[“”]/gu, '"').replace(/\s+/gu, ' ')
const WRAPPING = /^[\s"'`«»]+|[\s"'`«»]+$/gu
const STOP = /[.,;:!?]+$/u

function unwrap(span) {
  let current = span
  for (;;) {
    const next = current.replace(WRAPPING, '').replace(STOP, '')
    if (next === current) return current
    current = next
  }
}

export function isQuoted(evidence, entry) {
  const haystack = fold(entry)
  const spans = fold(evidence).split(/\.{3}|…/u).map(unwrap).filter(Boolean)
  return spans.length > 0 && spans.every((span) => haystack.includes(span))
}

// `candidates` are `{ row, votes, score }` as the search ranks them; the votes come along into the
// result as a tie-break and as a trace of how each finalist got here, the row's duplicates as the
// ids the result stands for. Best first: by score, a grounded reading ahead of one whose evidence
// was not found at the same score, then votes.
export async function score({ task, request, candidates, model, concurrency = 20, think, effort, tally, ask }) {
  const systemPrompt = scoreSystem(task)
  const scored = await mapLimit(candidates, concurrency, async ({ row, votes }) => {
    const { score: value, reason, evidence } = await call({
      type: 'grid.score', model, systemPrompt, userContent: blocks(requestBlock(request), candidateBlock(row)),
      parse: readScore, think, effort, tally, ask, label: `score ${request.id} ${row.id}`,
    })
    return { id: row.id, score: value, reason, evidence, grounded: isQuoted(evidence, row.entry), votes, summary: row.summary, duplicates: row.duplicates ?? [] }
  })
  return scored.sort((a, b) => b.score - a.score || Number(b.grounded) - Number(a.grounded) || b.votes - a.votes || a.id.localeCompare(b.id))
}
