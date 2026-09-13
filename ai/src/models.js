import assert from 'node:assert/strict'

const DEFAULT_MAX_TOKENS = 64 * 1024

// Reasoning ladders a model row can point `efforts` at. Named by their top
// rung, since the levels below it come along: OpenAI gates the high end per
// model — `max` is gpt-5.6 and gpt-6, `xhigh` reaches back through 5.5 and
// 5.4 — while everything from `low` to `high` is common to every reasoning
// model.
//
// A ladder is the model's, not the route's, which gpt-6-astra strains: it
// takes `max` on the Responses API (what the openai adapter speaks) but only
// through `xhigh` on chat completions, so `--effort max` against it via
// openrouter or a gateway passes this check and 400s on the wire.
//
// 'manual' is deliberately absent from all of them: it is Anthropic's
// fixed-budget marker rather than a wire value any other provider accepts, so
// naming a row's set is also what makes the CLI reject `--effort manual`
// against that model up front instead of throwing mid-run when the request is
// built. A row with no `efforts` takes the full EFFORT_LEVELS ladder.
const EFFORTS_THROUGH_MAX = ['low', 'medium', 'high', 'xhigh', 'max']
const EFFORTS_THROUGH_XHIGH = ['low', 'medium', 'high', 'xhigh']
const EFFORTS_THROUGH_HIGH = ['low', 'medium', 'high']

// Prices in dollars per million tokens
const MODELS = new Map([
  ['anthropic/claude-fable-5.1', { input: 10, output: 50, cacheReadPrice: 0.25, maxTokens: 128_000, canThink: 'adaptive', noThink: 'unsupported' }],
  ['anthropic/claude-fable-5', { input: 10, output: 50, maxTokens: 128_000, canThink: 'adaptive', noThink: 'unsupported' }],
  ['anthropic/claude-haiku-4.5', { input: 1, output: 5, maxTokens: 64_000, canThink: true }],
  ['anthropic/claude-3.5-haiku', { input: 0.8, output: 4, maxTokens: 8192 }],
  ['anthropic/claude-3-haiku', { input: 0.25, output: 1.25, maxTokens: 4096 }],
  // List price: Sonnet 5 is discounted to 2 / 10 introductory through
  // 2026-08-31, and hardcoding the intro rate would silently understate every
  // run costed after it expires.
  ['anthropic/claude-sonnet-5', { input: 3, output: 15, maxTokens: 128_000, canThink: 'adaptive' }],
  ['anthropic/claude-sonnet-4.6', { input: 3, output: 15, maxTokens: 128_000, canThink: 'adaptive' }],
  ['anthropic/claude-sonnet-4.5', { input: 3, output: 15, maxTokens: 64 * 1024, canThink: true }],
  ['anthropic/claude-sonnet-4', { input: 3, output: 15, maxTokens: 64 * 1024, canThink: true }],
  ['anthropic/claude-opus-5', { input: 5, output: 25, maxTokens: 128_000, canThink: 'adaptive', noThink: 'explicit' }],
  ['anthropic/claude-opus-4.8', { input: 5, output: 25, maxTokens: 128_000, canThink: 'adaptive' }],
  ['anthropic/claude-opus-4.7', { input: 5, output: 25, maxTokens: 128_000, canThink: 'adaptive' }],
  ['anthropic/claude-opus-4.6', { input: 5, output: 25, maxTokens: 128_000, canThink: 'adaptive' }],
  ['anthropic/claude-opus-4.5', { input: 5, output: 25, maxTokens: 64 * 1024, canThink: true }],
  ['openai/gpt-6-astra', { input: 10, output: 50, maxTokens: 128_000, canThink: true, noThink: 'unsupported', efforts: EFFORTS_THROUGH_MAX, cacheBreakpoint: true }],
  ['openai/gpt-6-astra-pro', { input: 10, output: 50, maxTokens: 128_000, canThink: true, noThink: 'unsupported', efforts: EFFORTS_THROUGH_MAX, cacheBreakpoint: true, wireModel: 'openai/gpt-6-astra', reasoningMode: 'pro' }],
  ['openai/gpt-5.6-sol', { input: 5, output: 30, maxTokens: 128_000, canThink: true, efforts: EFFORTS_THROUGH_MAX, cacheBreakpoint: true }],
  ['openai/gpt-5.6-terra', { input: 2.5, output: 15, maxTokens: 128_000, canThink: true, efforts: EFFORTS_THROUGH_MAX, cacheBreakpoint: true }],
  ['openai/gpt-5.6-luna', { input: 1, output: 6, maxTokens: 128_000, canThink: true, efforts: EFFORTS_THROUGH_MAX, cacheBreakpoint: true }],
  ['openai/gpt-5.5', { input: 2.5, output: 15, maxTokens: 128 * 1024, canThink: true, efforts: EFFORTS_THROUGH_XHIGH }],
  ['openai/gpt-5.4', { input: 2.5, output: 15, maxTokens: 128 * 1024, canThink: true, efforts: EFFORTS_THROUGH_XHIGH }],
  ['openai/gpt-5.4-nano', { input: 0.2, output: 1.25, maxTokens: 128 * 1024, canThink: true, efforts: EFFORTS_THROUGH_XHIGH }],
  ['openai/gpt-5.4-mini', { input: 0.75, output: 4.5, maxTokens: 128 * 1024, canThink: true, efforts: EFFORTS_THROUGH_XHIGH }],
  ['openai/gpt-5.4-pro', { input: 30, output: 180, maxTokens: 128 * 1024, canThink: true, efforts: EFFORTS_THROUGH_XHIGH }],
  ['openai/gpt-5.3-codex', { input: 1.75, output: 14, maxTokens: 128 * 1024, canThink: true, efforts: EFFORTS_THROUGH_HIGH }],
  ['openai/gpt-4.1-mini', { input: 0.4, output: 1.6, maxTokens: 32768 }],
  ['openai/gpt-4o-mini', { input: 0.15, output: 0.6, maxTokens: 16384 }],
  ['openai/gpt-oss-120b', { input: 0.039, output: 0.19, maxTokens: 128 * 1024 }],
  ['google/gemma-4-31b-it', { input: 0.14, output: 0.4, maxTokens: 128 * 1024, canThink: true }],
  ['google/gemma-4-26b-a4b-it', { input: 0.13, output: 0.4, maxTokens: 128 * 1024, canThink: true }],
  ['google/gemini-3.1-flash-lite-preview', { input: 0.25, output: 1.5, maxTokens: 64 * 1024 }],
  ['google/gemini-3.1-pro-preview', { input: 2, output: 12, maxTokens: 64 * 1024 }],
  ['nvidia/nemotron-3-super-120b-a12b', { input: 0.1, output: 0.5, maxTokens: 128 * 1024 }],
  // Kimi K3 (1M context). Priced at Moonshot's list rate ($3 / $15 per Mtok,
  // cache hits at 0.1x — exactly calculateCost's cacheRead multiplier).
  // OpenRouter resells the same model slightly cheaper ($2.90 / $14) but
  // reports its own per-request cost, which wins over this table wherever
  // it's present, so one row serves both routes. `maxTokens` is Moonshot's
  // documented `max_completion_tokens` default rather than its 1,048,576
  // ceiling — the cap is an output budget, not a context length.
  ['moonshotai/kimi-k3', { input: 3, output: 15, maxTokens: 131_072, canThink: true, noThink: 'unsupported', efforts: ['low', 'high', 'max'] }],
  // Chrome's built-in on-device models, served by the browser rather than an
  // API — see chrome.js. Zero at every rate: the weights are already on the
  // machine and the compute was paid for with it. NOT `free`, which in this
  // table means a hosted model that may log and train on what it is sent.
  //
  // Ids follow Gemma's published checkpoint names. The other three fields are
  // Chrome's own spellings, each explained where it is used: `baseModel`
  // finds the weights (chrome-model.js), `specNames` matches what the
  // component manifest declares (identifiesAs), `modelVersion` picks which
  // use case answers (enabledFeatures in chrome.js). `maxTokens` is advisory
  // — the Prompt API takes no output cap, the context window binds instead.
  ['chrome/gemini-nano-v3', { input: 0, output: 0, maxTokens: 4096, baseModel: 'nano_v3', specNames: ['v3Nano'], modelVersion: 'v3' }],
  ['chrome/gemma-4-e2b-it', { input: 0, output: 0, maxTokens: 4096, baseModel: 'gemma4_2b', specNames: ['gemma4-2b-it'], modelVersion: 'v4' }],
  ['chrome/gemma-4-e4b-it', { input: 0, output: 0, maxTokens: 4096, baseModel: 'gemma4_4b', specNames: ['gemma-4-E4B-it'], modelVersion: 'v4_4b' }],
  ['chrome/gemma-4-12b-it', { input: 0, output: 0, maxTokens: 4096, baseModel: 'gemma4_12b', modelVersion: 'v4_12b' }],
  // Free models — may log/store/use your data
  ['openai/gpt-oss-120b:free', { input: 0, output: 0, maxTokens: 128 * 1024, free: true }],
  ['openai/gpt-oss-20b:free', { input: 0, output: 0, maxTokens: 128 * 1024, free: true }],
  ['nvidia/nemotron-3-super-120b-a12b:free', { input: 0, output: 0, maxTokens: 128 * 1024, free: true }],
  ['qwen/qwen3-coder:free', { input: 0, output: 0, maxTokens: 128 * 1024, free: true }],
  ['qwen/qwen3.6-plus:free', { input: 0, output: 0, maxTokens: 64 * 1024, free: true }],
  ['google/gemma-3-27b-it:free', { input: 0, output: 0, maxTokens: 8192, free: true }],
])

// The names the price table knows, in its own order (families together,
// free models last). Not a closed set — `--model` takes any string, and an
// unknown one simply costs nothing the table can price — so this is what to
// OFFER, never what to allow. The server's console builds its model
// suggestions from it.
export const KNOWN_MODELS = [...MODELS.keys()]

// What a caller gets when it names no model. A row of the table above, so
// the price, the output cap and the thinking rules all resolve for it.
export const DEFAULT_MODEL = 'anthropic/claude-opus-5'

const BLOCKED = new Set([
  'anthropic/claude-opus-4.1',
  'anthropic/claude-opus-4',
])

// Provider-side aliases that route to a concrete model. `gpt-5.6` is OpenAI's
// documented alias for gpt-5.6-sol; it's deliberately NOT a registry row so it
// can't accrue its own cache dir / price entry. Resolve it at the input
// boundary instead, so one run's cache, request, and cost all key off the
// tier it points at rather than splitting across alias and target.
//
// Bare `kimi-k3` gets the same treatment for a different reason: it's the id
// Moonshot's own docs use — and the one the adapter puts on the wire — so
// operators reach for it, but unresolved it matches no registry row. Every
// lookup would then quietly take its default: canThink false (so thinking
// switches OFF on a model that always reasons and bills for it), a 64k
// output cap instead of 131k, no price, and a cache dir that never shares
// with the namespaced id.
const MODEL_ALIASES = new Map([
  ['openai/gpt-5.6', 'openai/gpt-5.6-sol'],
  ['kimi-k3', 'moonshotai/kimi-k3'],
])

export function resolveModel(model) {
  return MODEL_ALIASES.get(model) ?? model
}

// Whether the registry recognises the id at all (aliases resolved first, so
// the bare `kimi-k3` counts). Every other lookup in this module answers for
// an id it has never seen with a silent default — canThink false, no
// narrowed effort ladder, the fallback output cap, a null cost — and that
// tolerance is deliberate: a model the table doesn't carry still routes
// through OpenRouter or a gateway and works. What it costs is that a typo'd
// id is indistinguishable from a real model that simply cannot reason, so
// every caller about to report a capability as missing asks this first and
// blames the id instead.
//
// Wider than KNOWN_MODELS, deliberately. That list is the table's rows and
// nothing else, because it is what to OFFER; this also recognises a BLOCKED
// id, because validateModel already turns those away by name ("use
// claude-opus-4.5 or newer") and calling one unrecognised would replace that
// with an invitation to check spelling that is already correct.
export function isRecognizedModel(model) {
  const id = resolveModel(model)
  return MODELS.has(id) || BLOCKED.has(id)
}

// What to say when a --think / --effort request names an id the registry
// doesn't recognise. `flag` is the part of the request that was refused,
// since that is the half of the command line to change if the id is right.
export function unknownModelMessage(model, flag) {
  return `Unknown model ${model} — it is not in the model registry, so ${flag} cannot be applied to it. Check the spelling, or add a row for it to MODELS in \`ai/\`.`
}

export function validateModel(model, { free = false } = {}) {
  assert.ok(!BLOCKED.has(model), `Model ${model} is not supported. Use claude-opus-4.5 or newer.`)
  const info = MODELS.get(model)
  const isFree = info ? info.free : model.endsWith(':free')
  if (free) {
    assert.ok(isFree, `Model ${model} is not free. Use a :free model with --free.`)
  } else {
    assert.ok(!isFree, `Model ${model} requires --free flag.`)
  }
}

export function getMaxTokens(model) {
  return MODELS.get(model)?.maxTokens ?? DEFAULT_MAX_TOKENS
}

// canThink entries:
//   true        — supports extended thinking ({ type: 'enabled', budget_tokens })
//   'adaptive'  — supports adaptive thinking ({ type: 'adaptive' })
export function canThink(model) {
  return Boolean(MODELS.get(model)?.canThink)
}

export function canAdaptive(model) {
  return MODELS.get(model)?.canThink === 'adaptive'
}

// `noThink` — how a think=false request turns thinking off. One field
// with three states rather than two booleans, so a row can't claim a
// contradictory pair:
//
//   (absent)        omit the field; that already means no thinking.
//   'explicit'      omit means ADAPTIVE, so send `{ type: 'disabled' }`.
//                   Accepted at effort <= high, which the no-think path
//                   satisfies by never sending an effort at all.
//   'unsupported'   no opt-out exists — either the disabled form 400s at
//                   any effort (the fable 5 family) or the API has no off
//                   switch at all (kimi-k3, and the gpt-6 astra rows, which
//                   reject `reasoning_effort: 'none'` and floor at `low`).
//                   Omitting is the only legal request, even though thinking
//                   stays on.
export function needsExplicitNoThink(model) {
  return MODELS.get(model)?.noThink === 'explicit'
}

export function canDisableThink(model) {
  return MODELS.get(model)?.noThink !== 'unsupported'
}

// Anthropic `task-budgets-2026-03-13` beta gate: the models that accept the
// beta header + the `output_config.task_budget` body field. Callers gate on
// this before flipping the option on per-request so a global
// `--task-budget=always` against a mixed-model run silently no-ops on
// unsupported passes instead of 400ing the API.
//
// Exported because a caller's --help text renders it. Three comments used
// to spell the membership out in prose instead, and all three were wrong
// about sonnet 5 for months.
//
// Fable 5.1 is here on the strength of the docs listing it, which hedge the
// entry pending launch. Unlike the fallback registry's unverified row, a
// wrong guess here is not free: this gate is what a caller checks before
// accepting a task-budget request, so a model wrongly listed is waved
// through and 400s on every request instead of being refused up front.
// Drop the row if the beta turns out not to cover it.
export const TASK_BUDGET_MODELS = new Set([
  'anthropic/claude-fable-5.1',
  'anthropic/claude-fable-5',
  'anthropic/claude-opus-5',
  'anthropic/claude-sonnet-5',
  'anthropic/claude-opus-4.7',
  'anthropic/claude-opus-4.8',
])

export function canTaskBudget(model) {
  return TASK_BUDGET_MODELS.has(model)
}

export const TASK_BUDGET_MODES = ['never', 'always', 'error']

// Every effort level the CLI accepts. 'manual' is Anthropic's fixed-budget
// marker rather than a rung on the ladder — the non-Anthropic adapters reject
// it. Exported so the CLI's option check and the server's request validation
// read one array instead of mirroring a literal that can drift.
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'manual']

// The narrowed set for a model whose reasoning knob takes fewer levels than
// EFFORT_LEVELS, or undefined for one that takes them all. Keyed by model
// rather than by provider because the narrowing is the model's: K3 is
// reachable through Moonshot direct and through any OpenAI-compatible
// gateway as moonshotai/kimi-k3, and takes the same three levels either way.
//
// Aliases resolve first, so the bare `kimi-k3` a caller may pass narrows the
// same as the namespaced id. Tolerates a non-string so the server can check
// effort before it has validated the model field's type.
export function effortsFor(model) {
  return MODELS.get(resolveModel(model))?.efforts
}

// `wireModel` / `reasoningMode` — a row the direct API serves as a MODE on
// another model rather than as a model of its own. Astra Pro is astra run
// with `reasoning.mode: 'pro'`; the two spellings are the same thing, so
// which one a route needs depends on how it names models:
//
//   Responses (the openai adapter)  resolves the id to a bare name the API
//                                   must know, and `reasoning.mode` exists
//                                   only here — so it sends the BASE model
//                                   plus the mode.
//   chat completions (openrouter,   pass the registry id through untouched,
//   a gateway)                      where it is OpenRouter's own slug or the
//                                   operator's routing key. Chat Completions
//                                   has no `reasoning.mode` at all, so the
//                                   slug is the only way to ask for pro.
//
// Separate rows rather than an alias, deliberately: the two produce different
// answers, so they want separate cache dirs (modelSubdir keys off the raw id)
// even though they share a price and a token rate.
export function wireModelFor(model) {
  return MODELS.get(resolveModel(model))?.wireModel ?? model
}

// Undefined for every hosted row, which is what tells the adapter a model is
// not one of Chrome's.
export function baseModelFor(model) {
  return MODELS.get(resolveModel(model))?.baseModel
}

// Keyed by base model rather than registry id, so the adapter can look one up
// from what it already carries.
const BY_BASE_MODEL = new Map([...MODELS.values()].filter((r) => r.baseModel).map((r) => [r.baseModel, r]))

export function specNamesFor(baseModel) {
  return BY_BASE_MODEL.get(baseModel)?.specNames ?? []
}

export function modelVersionFor(baseModel) {
  return BY_BASE_MODEL.get(baseModel)?.modelVersion
}

export function reasoningModeFor(model) {
  return MODELS.get(resolveModel(model))?.reasoningMode
}

// Whether the model reads OpenAI's explicit `prompt_cache_breakpoint` marker.
// Version-gated rather than namespace-wide, so it lives on the row like
// `efforts` does: the field arrived with gpt-5.6, and every earlier model
// rejects a request carrying it with a 400 rather than ignoring it.
export function readsCacheBreakpoint(model) {
  return Boolean(MODELS.get(resolveModel(model))?.cacheBreakpoint)
}

// Whether the model exposes an effort knob. All thinking-capable models
// EXCEPT non-adaptive Anthropic — that branch takes a fixed budget_tokens
// instead of an effort string, so passing 'high' / 'low' / etc. there is
// meaningless. Adaptive Anthropic, OpenAI Responses, OpenRouter, Google,
// etc. all read effort verbatim.
export function canEffort(model) {
  const info = MODELS.get(model)
  if (!info?.canThink) return false
  if (model.startsWith('anthropic/') && info.canThink !== 'adaptive') return false
  return true
}

// Resolve the actual think/effort values that will hit the wire for a
// given model + user request. Folding the defaults in here means every
// cache key reflects the request shape — a no-effort run and an
// effort=high run can't accidentally share a slot just because one path
// applied the default later than the other.
export function normalizeThinkEffort(model, think, effort) {
  const useThink = Boolean(think) && canThink(model)
  const useEffort = useThink && canEffort(model) ? (effort ?? 'high') : undefined
  return { useThink, useEffort }
}

// normalizeThinkEffort for a request that is about to go out: same
// resolution, but a model that dropped what the caller asked for is an error
// here rather than a silent downgrade. Every request path takes this one,
// so a single wording serves them all.
//
// The unknown-model branch is why that wording is worth centralising: for an
// id with no row, normalizeThinkEffort drops think and effort exactly as it
// does for a registered model that genuinely cannot reason, so a mistyped
// --model used to surface as `--effort is not supported by model or --think
// is not enabled` — a sentence that sends you reading a model's capabilities
// instead of the id you typed.
export function resolveThinkEffort(model, think, effort) {
  const { useThink, useEffort } = normalizeThinkEffort(model, think, effort)
  const known = isRecognizedModel(model)
  if (useThink !== Boolean(think)) {
    throw new Error(known ? '--think is not supported by model' : unknownModelMessage(model, '--think'))
  }
  if (effort && useEffort !== effort) {
    throw new Error(known ? '--effort is not supported by model or --think is not enabled' : unknownModelMessage(model, '--effort'))
  }
  return { useThink, useEffort }
}

// Canonical usage-accumulator shape — what the provider adapters'
// normalizeOneUsage emits and calculateCost consumes. They live here, next
// to the price table, so a caller can sum usage without pulling in the
// conversation loop.
export function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cost: 0 }
}

export function addUsage(total, usage) {
  if (!usage) return
  total.input += usage.input
  total.output += usage.output
  total.cacheRead += usage.cacheRead
  total.cacheWrite5m += usage.cacheWrite5m
  total.cacheWrite1h += usage.cacheWrite1h
  total.cost += usage.cost
}

// Anthropic prompt-cache multipliers on base input price:
//   read:        0.10x
//   write 5m:    1.25x
//   write 1h:    2.00x
// The read multiplier is not universal — a row can name a flat
// `cacheReadPrice` in dollars per Mtok instead.
export function calculateCost(model, usage) {
  const prices = MODELS.get(model)
  if (!prices) return null
  const inputCost = (usage.input * prices.input) / 1_000_000
  // Branch instead of resolving one rate up front: folding `input * 0.10`
  // first rounds differently from multiplying the tokens through, moving
  // every unoverridden row's price in the last bits (3 * 0.10 !== 0.3).
  const cacheReadTokens = usage.cacheRead ?? 0
  const cacheReadCost = prices.cacheReadPrice == null
    ? (cacheReadTokens * prices.input * 0.10) / 1_000_000
    : (cacheReadTokens * prices.cacheReadPrice) / 1_000_000
  const cacheWrite5mCost = ((usage.cacheWrite5m ?? 0) * prices.input * 1.25) / 1_000_000
  const cacheWrite1hCost = ((usage.cacheWrite1h ?? 0) * prices.input * 2.00) / 1_000_000
  const outputCost = (usage.output * prices.output) / 1_000_000
  return inputCost + cacheReadCost + cacheWrite5mCost + cacheWrite1hCost + outputCost
}
