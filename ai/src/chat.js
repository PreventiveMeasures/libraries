import { assert } from '#assert'
import { invalidateCacheEntry, setPartial, takePartial } from './cache.js'
import { addUsage, emptyUsage } from './models.js'
import { claimPrefix, prefixKey } from './prefix-gate.js'
import { flattenUserContent } from './prompt-cache.js'
import {
  appendToolResults, buildInitialUserMessage, extractResponseText, extractToolCalls,
  normalizeOneUsage, providerStamp, turnCost,
} from './providers.js'
import { assertToolResult } from './tool-results.js'
import { issueTurn, resolveTaskBudget } from './task-budget.js'

// One conversation with a model, end to end: the first message, a turn per request, the caller's
// tool calls handed back and their results threaded into the next turn, and what the whole thing
// cost. What to ask and how to read the answer belong to the caller — nothing here inspects the
// text.
const DEFAULT_MAX_TOOL_TURNS = 30

export function normalizeUsage(data) {
  // New format: array of { request, response } turns
  if (Array.isArray(data)) {
    const total = emptyUsage()
    let found = false
    for (const turn of data) {
      const usage = normalizeOneUsage(turn.response)
      if (usage) {
        addUsage(total, usage)
        found = true
      }
    }
    return found ? total : null
  }
  // Old format: single response object
  return normalizeOneUsage(data)
}

// Run one conversation to completion and return `{ text, error, usage, history }`. With no `tools`
// it is a single request; with them, the loop keeps going as long as the model keeps calling them.
//
// `maxToolTurns` caps the assistant↔tool round-trips: each turn is one API request whose response
// can include zero or more tool calls (the provider may batch). It is NOT a hard ceiling on total
// tool calls — the model can fan out N calls in a single turn — so callers that need a per-call
// budget have to enforce that separately. The "Max tool call turns reached" exit message matches
// the variable's semantics.
//
// `partial` (optional) is both halves of surviving an interruption: the cache options the running
// history is written under after every completed turn, and the place this call looks before issuing
// its first request. A long tool session killed at turn 20 picks up there instead of paying for 20
// turns again. Without it a conversation starts and ends in one go.
//
// `onStart` (optional) is handed the turns being resumed — `[]` on a fresh run — before the first
// request goes out, for a caller whose tools carry state those turns have to rebuild.
export async function ask({ model, maxTokens, systemPrompt, userContent, think = false, effort, tools, handleToolCall, maxToolTurns = DEFAULT_MAX_TOOL_TURNS, partial, onStart, debug, debugRequests, label, taskBudget = 'never', ...rest }) {
  assert(!('userContentSuffix' in rest), 'userContentSuffix is gone — pass userContent as [preamble, suffix] instead')
  assert(Boolean(tools) === Boolean(handleToolCall), 'tools and handleToolCall must be both provided or both omitted')
  const totalUsage = emptyUsage()
  const history = []
  const texts = []
  // One provider and one model for the whole conversation, so the wire-format stamp every entry
  // carries is resolved once.
  const stamp = providerStamp(model)
  const { always: taskBudgetAlways, onError: taskBudgetOnError } = resolveTaskBudget(model, taskBudget)

  // What the entry is keyed on: the whole user message, so a request that sent its shared part and
  // tail as separate blocks still resumes under the key its final result will be cached at.
  const keyContent = flattenUserContent(userContent)
  // Per-turn partial writes are best-effort resilience: a disk error (permissions, ENOSPC), or a
  // history too large to serialise, must not abort a conversation in progress — so log and carry
  // on, and the final write still gets its chance.
  const savePartial = async () => {
    if (!partial) return
    try {
      await setPartial(keyContent, history, partial)
    } catch (err) {
      if (debug) console.warn(`[chat] partial-cache write failed for ${label}: ${err.message}`)
    }
  }

  const resumed = await resumeFrom(keyContent, partial, stamp, { debug, label })
  await onStart?.(resumed?.history ?? [])

  // Take on the cached turns. Note we deliberately do NOT add their usage into `totalUsage` —
  // those tokens were paid in the prior (interrupted) invocation and are already reflected in that
  // run's cost line; counting them here would inflate the "new" cost reported for this one.
  for (const entry of resumed?.history ?? []) {
    history.push(entry)
    texts.push(extractResponseText(entry.response))
  }
  // No messages to send means the last cached turn called no tool: the previous run had already
  // issued its final assistant message and would have returned at this point. Short-circuit to
  // avoid a redundant API round-trip (and the cost / nondeterministic re-roll that would come with
  // it) when the partial got persisted but the final setCache write didn't (killed mid-finish).
  if (resumed && !resumed.messages) return { text: texts.filter(Boolean).join('\n'), usage: totalUsage, history }
  const messages = resumed?.messages ?? [buildInitialUserMessage(model, userContent)]

  const gateKey = prefixKey(model, tools, systemPrompt)
  for (let turn = history.length; turn < maxToolTurns; turn++) {
    // Snapshot the pre-turn messages array before buildRequestBody — appendToolResults mutates it
    // in place, so a post-hoc capture would leak the next turn's state into this entry.
    const preMessages = [...messages]
    // Head turn only: hold siblings sharing this prefix until the first one replies, so they read
    // the cache entry it writes instead of racing to write their own. Released the moment the reply
    // lands, not held for the rest of the chain — later turns of this conversation are sequential
    // and extend a prefix nobody else shares.
    const release = turn === history.length ? await claimPrefix(gateKey) : null
    const { request, response, error, failedAttemptResponse } = await issueTurn({
      model, maxTokens, systemPrompt, messages, think, effort, tools, label, turn,
      taskBudgetAlways, taskBudgetOnError, debug,
    }).finally(() => release?.())
    // task-budget=error path: the failed attempt's tokens still got paid for, so account for both
    // responses in the running total.
    if (failedAttemptResponse) addUsage(totalUsage, normalizeUsage(failedAttemptResponse))
    addUsage(totalUsage, normalizeUsage(response))

    if (error) {
      history.push({ request, response, messages: preMessages, toolCalls: [], toolResults: [], error, provider: stamp })
      await savePartial()
      return { text: null, error, usage: totalUsage, history }
    }

    texts.push(extractResponseText(response))

    const toolCalls = extractToolCalls(response)
    const malformed = toolCalls.find((tc) => tc.argsError)
    if (malformed) {
      history.push({ request, response, messages: preMessages, toolCalls, toolResults: [], error: malformed.argsError, provider: stamp })
      await savePartial()
      return { text: null, error: malformed.argsError, usage: totalUsage, history }
    }

    if (debugRequests && toolCalls.length > 0) console.log(`[debug] ${label} calling tool: ${JSON.stringify(toolCalls)}`)
    const toolResults = toolCalls.length > 0 && handleToolCall ? await Promise.all(toolCalls.map((tc) => handleToolCall(tc))) : []
    // Judged here rather than at the wire, which is two statements and one disk write too late:
    // an answer the adapters cannot carry would be in the partial before anything looked at it,
    // and every later run would read it back and fail on it. Named, too — the wire knows the
    // value and nothing else about it.
    toolResults.forEach((result, i) => assertToolResult(result, `The result of tool ${toolCalls[i].name}`))
    history.push({ request, response, messages: preMessages, toolCalls, toolResults, provider: stamp })
    await savePartial()

    if (toolCalls.length === 0 || !handleToolCall) {
      return { text: texts.filter(Boolean).join('\n'), usage: totalUsage, history }
    }
    appendToolResults(messages, response, toolCalls, toolResults)
  }

  return { text: null, error: 'Max tool call turns reached', usage: totalUsage, history }
}

// The field was `results` until it grew a `toolCalls` sibling to be confused with. A partial
// written under the old name still resumes.
const toolResultsOf = (entry) => entry.toolResults ?? entry.results

// The messages array a run held after `upTo` of its turns — entry 0's seed plus what each of those
// turns appended. Every appendToolResults is a pure function of the turn it is given, so this
// reproduces exactly the array the run held, which is why no snapshot of it is stored past the
// seed. Not rebuilt from the requests instead: those are provider-shaped (OpenAI Responses uses
// `request.input`; OpenRouter prepends its own system message) and dropped after the first anyway.
// Replaying under another provider's adapter would build the wrong shapes, which is what the stamp
// check in resumeFrom — and the assertion in normalizeCacheFile — is for.
export function replayMessages(history, upTo = history.length) {
  const messages = [...history[0].messages]
  for (let i = 0; i < upTo; i++) appendTurn(messages, history[i])
  return messages
}

// One turn of that walk, for a caller stepping through a history rather than rebuilding a prefix of
// it — which is the difference between one pass and one per entry.
export function appendTurn(messages, entry) {
  appendToolResults(messages, entry.response, entry.toolCalls, toolResultsOf(entry))
}

// The partial this run picks up from — its turns, and the messages array they rebuild to — or null
// for a fresh start. Everything that decides whether a partial can be used is here, where no caller
// can skip it, and rebuilding is part of deciding: isResumableHistory judges shape, not every value
// a turn holds, so a result no adapter can carry gets past it and surfaces as a throw from the
// replay. That would throw identically in every later process, which makes it the same kind of
// unusable as a malformed one — taken out of service, and the conversation paid for again.
//
// A history whose last turn called nothing comes back with no `messages`: the answer is already in
// it, no request follows, and there is nothing to rebuild.
async function resumeFrom(keyContent, partial, stamp, { debug, label }) {
  if (!partial) return null
  const history = await takePartial(keyContent, partial)
  if (!history) return null
  // Out of service, so the next process doesn't load it under a wrong shape too.
  const unusable = async (why) => {
    if (debug) console.warn(`[chat] partial for ${label} ${why}; starting fresh`)
    await invalidateCacheEntry(keyContent, partial)
    return null
  }
  if (!isResumableHistory(history, { provider: stamp })) return await unusable('is malformed or cross-provider')
  if (debug) console.debug(`[chat] resuming ${label} from ${history.length} cached turn(s)`)
  if (!(history.at(-1).toolCalls?.length > 0)) return { history }
  try {
    return { history, messages: replayMessages(history) }
  } catch (err) {
    return await unusable(`does not replay (${err.message})`)
  }
}

// Validate a cached partial history is safe to replay. Every entry has to be an object with a
// `response` (extractResponseText reads it, and the replay feeds it back to appendToolResults),
// entry 0 has to carry a non-empty `messages` seed — the only snapshot serializeHistory keeps, and
// now the sole record of how the conversation opened, so an empty one replays a request with no
// question in it — and every entry before the last has to be a completed tool round, since
// that is what the replay treats it as and a turn that called nothing is where the loop stopped.
// One bad entry invalidates the whole partial — resumeFrom invalidates it and starts fresh rather
// than risking a mid-replay crash.
//
// `provider` (optional): require every entry's `provider` stamp to match. `messages` content blocks
// are adapter-shaped (Anthropic's `tool_use` blocks, OpenAI's tool_call arrays, etc.) so replaying
// an Anthropic-written partial under OpenRouter would feed the wrong shape to the next request.
// Per-entry stamps make the mismatch catchable. Legacy partials predating the stamp have
// `provider === undefined` and will fail the equality check when a provider is configured, which is
// the safe default.
//
// The last entry must additionally be a clean continuation point: either a terminal turn (no tool
// calls) or a tool-round with matching results, and it must NOT be flagged with an `error`. chat
// stamps `error` on entries persisted because of an API error or malformed tool args; resuming back
// into that state would just re-surface the same failure (or, for the short-circuit path, silently
// return empty text and mask the error).
export function isResumableHistory(history, { provider } = {}) {
  if (!isStoredHistory(history)) return false
  if (provider !== undefined && !history.every((e) => e.provider === provider)) return false
  if (!Array.isArray(history[0].messages) || history[0].messages.length === 0) return false
  const answered = (e) => {
    const rs = toolResultsOf(e)
    return Array.isArray(e.toolCalls) && Array.isArray(rs) && e.toolCalls.length === rs.length
  }
  if (!history.slice(0, -1).every((e) => answered(e) && e.toolCalls.length > 0)) return false
  const last = history.at(-1)
  if (last.error) return false
  return !(last.toolCalls?.length > 0) || answered(last)
}

// A stored history, as against whatever else a `.json` under a cache root might be — a config, a
// fixture, an export. Every entry an object carrying a response object: the field the replay reads,
// and the one no unrelated file happens to have on every element. The weakest thing every reader
// of a history needs, which is why the normalizer gates on it before rewriting a file.
export function isStoredHistory(history) {
  return Array.isArray(history) && history.length > 0 && history.every(
    (entry) => entry !== null && typeof entry === 'object' && !Array.isArray(entry)
      && entry.response !== null && typeof entry.response === 'object',
  )
}

// Per-attempt cost log, for every caller that drives a conversation. OpenRouter ships its own
// per-request cost number; everyone else relies on the local price table. `?? 0` is the
// unknown-model fallback so logging doesn't crash when calculateCost returns null.
//
// `pass` (optional) names the caller in the line — `[debug] Post-process tokens for …` — so several
// passes over the same `label` stay legible apart from each other and from the plain
// `[debug] Tokens for …`.
export function logTurnCost(label, model, usage, pass) {
  const cost = usage.cost > 0 ? usage.cost : (turnCost(model, usage) ?? 0)
  const what = pass ? `${pass} tokens` : 'Tokens'
  console.debug(`[debug] ${what} for ${label}: input=${usage.input} output=${usage.output} cacheRead=${usage.cacheRead} cacheWrite5m=${usage.cacheWrite5m} cacheWrite1h=${usage.cacheWrite1h} cost=$${cost.toFixed(4)}`)
}
