import {
  addUsage, ask as askModel, buildCacheOpts, emptyUsage, getCached, getMaxTokens, normalizeThinkEffort,
  setCache, setInvalid,
} from '@preventive/ai'
import { extractJSON } from './json.js'

// One model call, the way every phase here makes one: looked up in the response cache first, asked
// through the layer on a miss, parsed by the caller's reader, and written back. A compaction is
// twenty thousand of these and a search a few hundred per request, so what this gets right is what
// makes a run resumable and a re-run free.
//
// The cache directory is the caller's to set (ai's setCacheDir), and there is no default here
// either: a run of this size without a cache is a mistake worth one clear error at the first call.

// What a run spent, across every call it made: the usage sum, and how many calls hit the disk
// cache against how many went to the model. One object threaded through the phases rather than a
// return value each, so a pipeline sums once and a caller driving the phases by hand sums the same.
export function newTally() {
  return { usage: emptyUsage(), calls: 0, hits: 0, misses: 0 }
}

// Appended to the message on the one re-ask a malformed response gets. The response was kept for
// inspection; the re-ask is under a different key, so it cannot read the bad entry back.
const NUDGE = '\n\nReturn only the JSON asked for, with no other text before or after it.'

// `parse` reads the model's text into the value the caller wants, and throws on one it cannot
// use: a response that is not JSON, or JSON of the wrong shape. The same reader judges a cache
// entry, so an entry written under a reader since made stricter reads as a miss rather than as an
// answer the run then chokes on.
//
// `userContent` is one string or ai's block list, passed through as is: which block is the shared
// prefix is the caller's call, and the cache key is the blocks joined either way.
//
// `ask` (optional) stands in for the layer's: the tests drive every phase with a scripted one, and
// the cache and the parse around it are still the real thing.
export async function call({ type, model, systemPrompt, userContent, parse = extractJSON, think = false, effort, maxTokens, label = type, retries, tally, ask = askModel }) {
  const { useThink, useEffort } = normalizeThinkEffort(model, think, effort)
  const opts = buildCacheOpts(type, { model, systemPrompt, useThink, useEffort })
  const key = Array.isArray(userContent) ? userContent.join('') : userContent
  const read = (text) => {
    try {
      return { value: parse(text) }
    } catch (err) {
      return { error: err }
    }
  }
  // Wrapped, so a parsed value that is itself falsy still counts as a hit.
  const hit = await getCached(key, opts, { validate: (entry) => { const got = read(entry.text); return got.error ? null : got } })
  if (hit) {
    tally.hits += 1
    return hit.value.value
  }
  tally.misses += 1

  const request = { model, maxTokens: maxTokens ?? getMaxTokens(model), systemPrompt, think: useThink, effort: useEffort, label, retries }
  const first = await issue(ask, { ...request, userContent }, tally)
  const parsed = read(first.text)
  if (!parsed.error) {
    await setCache(key, first.text, first.history, opts)
    return parsed.value
  }

  // Kept where a person can read it, then asked once more with the nudge. A second malformed answer
  // is the model's answer; nothing here guesses at a shape it was twice asked for and twice refused.
  await setInvalid(key, first.history, opts, { reason: parsed.error.message, text: first.text })
  const nudged = Array.isArray(userContent) ? [...userContent.slice(0, -1), userContent.at(-1) + NUDGE] : userContent + NUDGE
  const second = await issue(ask, { ...request, userContent: nudged }, tally)
  const reparsed = read(second.text)
  if (reparsed.error) throw new Error(`${label}: malformed response after a retry: ${reparsed.error.message}`)
  // Under the ORIGINAL key, so the next run reads this answer instead of re-spending the first
  // request on an entry the model mangles every time.
  await setCache(key, second.text, second.history, opts)
  return reparsed.value
}

async function issue(ask, request, tally) {
  const result = await ask(request)
  tally.calls += 1
  addUsage(tally.usage, result.usage)
  if (result.error || typeof result.text !== 'string') throw new Error(`${request.label}: ${result.error ?? 'empty response'}`)
  return result
}
