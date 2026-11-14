import {
  addUsage, ask as askModel, buildCacheOpts, emptyUsage, getCached, getMaxTokens, normalizeThinkEffort,
  setCache, setInvalid,
} from '@preventive/ai'
import { extractJSON } from './json.js'

// The usage summed over a run's calls, how many went to the model, and the disk cache's hits and misses
export function newTally() {
  return { usage: emptyUsage(), calls: 0, hits: 0, misses: 0 }
}

// Appended on the one re-ask a malformed response gets, which is under a key of its own
const NUDGE = '\n\nReturn only the JSON asked for, with no other text before or after it.'

// One model call: the disk cache (its directory set by the caller, through ai's setCacheDir), the layer on
// a miss, and the cache written. `parse` throws on text it cannot use, and judges a cached entry the same
// way, so one written under a laxer reader reads as a miss. `ask` stands in for the layer's in tests.
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
  // Wrapped, so a parsed value that is itself falsy still counts as a hit
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

  // Kept for a person to read, then asked once more; a second malformed answer is the model's answer
  await setInvalid(key, first.history, opts, { reason: parsed.error.message, text: first.text })
  const nudged = Array.isArray(userContent) ? [...userContent.slice(0, -1), userContent.at(-1) + NUDGE] : userContent + NUDGE
  const second = await issue(ask, { ...request, userContent: nudged }, tally)
  const reparsed = read(second.text)
  if (reparsed.error) throw new Error(`${label}: malformed response after a retry: ${reparsed.error.message}`)
  // Under the original key, so the next run reads this answer rather than re-spend the first request
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
