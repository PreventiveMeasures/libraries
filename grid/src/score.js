import { call } from './call.js'
import { expectObject, extractJSON, numberOf, textOf } from './json.js'
import { mapLimit } from './pool.js'
import { blocks, candidateBlock, requestBlock, scoreSystem } from './prompts.js'

// Phase 5: each finalist in full against the request in full, on an absolute scale a caller cuts by.
// The request is the shared prefix of every call.

// A score that is no number is re-asked rather than coerced, and so is a missing reason or evidence,
// which once cached would stay missing
function readScore(text) {
  const json = expectObject(extractJSON(text), 'score, reason and evidence')
  const value = numberOf(json.score)
  if (value === undefined) throw new TypeError('expected a numeric score')
  const reason = textOf(json.reason)
  if (!reason) throw new TypeError('expected a reason for the score')
  const evidence = textOf(json.evidence)
  if (!evidence) throw new TypeError('expected the evidence quoted from the candidate')
  return { score: Math.min(100, Math.max(0, value)), reason, evidence }
}

// Whether the evidence is in the entry word for word, folded for case, quotes and spaces, the quote
// shorn of its wrapping marks and final stop alone (so `C++` keeps its pluses), and each span of a quote
// with an ellipsis there in turn: a quote that is not there was reasoned about something unsaid
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

// Best first: by score, a grounded reading ahead of an ungrounded one, then the search's votes
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
