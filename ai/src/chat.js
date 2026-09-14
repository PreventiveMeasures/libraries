import { assert } from '#assert'
import { invalidateCacheEntry, setPartial, takePartial } from './cache.js'
import { addUsage, emptyUsage } from './models.js'
import { claimPrefix, prefixKey } from './prefix-gate.js'
import { flattenUserContent } from './prompt-cache.js'
import {
  appendToolResults, buildInitialUserMessage, extractResponseText, extractToolCalls,
  normalizeOneUsage, providerStamp, turnCost,
} from './providers.js'
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
  // Per-turn partial writes are best-effort resilience: a disk error (permissions, ENOSPC) must not
  // abort a conversation in progress, so log and carry on — the final write still gets its chance.
  // setPartial recovers an oversized history's JSON.stringify overflow internally.
  const savePartial = async () => {
    if (!partial) return
    try {
      await setPartial(keyContent, history, partial)
    } catch (err) {
      if (debug) console.warn(`[chat] partial-cache write failed for ${label}: ${err.message}`)
    }
  }

  const previous = await resumeFrom(keyContent, partial, stamp, { debug, label })
  await onStart?.(previous ?? [])

  let messages
  // Replay the cached turns: history and texts are repopulated, and `messages` is rebuilt from the
  // last entry's snapshot. Note we deliberately do NOT add cached-entry usage into `totalUsage` —
  // those tokens were paid in the prior (interrupted) invocation and are already reflected in that
  // run's cost line; counting them here would inflate the "new" cost reported for this invocation.
  // The `messages` snapshot is stored per-entry (not reconstructed from request.messages) because
  // requests are provider-shaped (OpenAI Responses uses `request.input`; OpenRouter prepends its
  // own system message); the provider check in resumeFrom already gated us into a matching shape.
  // Tail `appendToolResults` is only applied when the last entry actually had tool calls — a
  // terminal-turn entry has nothing to append.
  if (previous) {
    for (const entry of previous) {
      history.push(entry)
      texts.push(extractResponseText(entry.response))
    }
    const last = previous.at(-1)
    // Last cached turn produced no tool calls — the previous run had already issued its final
    // assistant message and would have returned at this point. Short-circuit to avoid a redundant
    // API round-trip (and the cost / nondeterministic re-roll that would come with it) when the
    // partial got persisted but the final setCache write didn't make it (process killed
    // mid-finish).
    if (!Array.isArray(last.toolCalls) || last.toolCalls.length === 0) {
      return { text: texts.filter(Boolean).join('\n'), usage: totalUsage, history }
    }
    messages = [...last.messages]
    appendToolResults(messages, last.response, last.toolCalls, last.results)
  } else {
    messages = [buildInitialUserMessage(model, userContent)]
  }

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
      history.push({ request, response, messages: preMessages, toolCalls: [], results: [], error, provider: stamp })
      await savePartial()
      return { text: null, error, usage: totalUsage, history }
    }

    texts.push(extractResponseText(response))

    const toolCalls = extractToolCalls(response)
    const malformed = toolCalls.find((tc) => tc.argsError)
    if (malformed) {
      history.push({ request, response, messages: preMessages, toolCalls, results: [], error: malformed.argsError, provider: stamp })
      await savePartial()
      return { text: null, error: malformed.argsError, usage: totalUsage, history }
    }

    if (debugRequests && toolCalls.length > 0) console.log(`[debug] ${label} calling tool: ${JSON.stringify(toolCalls)}`)
    const results = toolCalls.length > 0 && handleToolCall ? await Promise.all(toolCalls.map((tc) => handleToolCall(tc))) : []
    history.push({ request, response, messages: preMessages, toolCalls, results, provider: stamp })
    await savePartial()

    if (toolCalls.length === 0 || !handleToolCall) {
      return { text: texts.filter(Boolean).join('\n'), usage: totalUsage, history }
    }
    appendToolResults(messages, response, toolCalls, results)
  }

  return { text: null, error: 'Max tool call turns reached', usage: totalUsage, history }
}

// The partial this run picks up from, or null for a fresh start. Reading it here rather than taking
// one from the caller keeps the shape check, the provider check and the disposal of a bad one in
// one place, where no caller can skip them.
async function resumeFrom(keyContent, partial, stamp, { debug, label }) {
  if (!partial) return null
  const history = await takePartial(keyContent, partial)
  if (!history) return null
  if (!isResumableHistory(history, { provider: stamp })) {
    if (debug) console.warn(`[chat] partial for ${label} is malformed or cross-provider; starting fresh`)
    // Out of service, so the next process doesn't load it under a wrong shape too.
    await invalidateCacheEntry(keyContent, partial)
    return null
  }
  if (debug) console.debug(`[chat] resuming ${label} from ${history.length} cached turn(s)`)
  return history
}

// Validate a cached partial history is safe to replay. Resume needs every entry to be an object
// with both a `response` (extractResponseText reads it) and a `messages` array (the pre-turn
// snapshot chat rebuilds the loop state from). One bad entry invalidates the whole partial —
// resumeFrom invalidates it and starts fresh rather than risking a mid-replay crash.
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
  if (!Array.isArray(history) || history.length === 0) return false
  if (!history.every((e) => e && typeof e === 'object' && e.response && typeof e.response === 'object' && Array.isArray(e.messages))) return false
  if (provider !== undefined && !history.every((e) => e.provider === provider)) return false
  const last = history.at(-1)
  if (last.error) return false
  const tc = Array.isArray(last.toolCalls) ? last.toolCalls : []
  const rs = Array.isArray(last.results) ? last.results : []
  return tc.length === 0 || tc.length === rs.length
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
