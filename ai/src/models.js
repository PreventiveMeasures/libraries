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
  // Two unrelated things wear `-pro` here. A row carrying wireModel is an
  // OPENROUTER ALIAS for reasoning.mode=pro on the model it names: same
  // weights, same rate, more tokens spent. A row without one — gpt-5.5-pro,
  // gpt-5.4-pro — is an OPENAI MODEL NAME, priced six times its namesake
  // because it is a different model. Adding a new `-pro` means deciding
  // which, and the rate says it: same as its base, or not.
  ['openai/gpt-6-astra', { input: 10, output: 50, maxTokens: 128_000, canThink: true, noThink: 'unsupported', efforts: EFFORTS_THROUGH_MAX, cacheBreakpoint: true }],
  ['openai/gpt-6-astra-pro', { input: 10, output: 50, maxTokens: 128_000, canThink: true, noThink: 'unsupported', efforts: EFFORTS_THROUGH_MAX, cacheBreakpoint: true, wireModel: 'openai/gpt-6-astra', reasoningMode: 'pro' }],
  ['openai/gpt-5.6-sol', { input: 5, output: 30, maxTokens: 128_000, canThink: true, efforts: EFFORTS_THROUGH_MAX, cacheBreakpoint: true }],
  ['openai/gpt-5.6-sol-pro', { input: 5, output: 30, maxTokens: 128_000, canThink: true, noThink: 'unsupported', efforts: EFFORTS_THROUGH_MAX, cacheBreakpoint: true, wireModel: 'openai/gpt-5.6-sol', reasoningMode: 'pro' }],
  ['openai/gpt-5.6-terra', { input: 2.5, output: 15, maxTokens: 128_000, canThink: true, efforts: EFFORTS_THROUGH_MAX, cacheBreakpoint: true }],
  ['openai/gpt-5.6-terra-pro', { input: 2.5, output: 15, maxTokens: 128_000, canThink: true, noThink: 'unsupported', efforts: EFFORTS_THROUGH_MAX, cacheBreakpoint: true, wireModel: 'openai/gpt-5.6-terra', reasoningMode: 'pro' }],
  ['openai/gpt-5.6-luna', { input: 1, output: 6, maxTokens: 128_000, canThink: true, efforts: EFFORTS_THROUGH_MAX, cacheBreakpoint: true }],
  ['openai/gpt-5.6-luna-pro', { input: 1, output: 6, maxTokens: 128_000, canThink: true, noThink: 'unsupported', efforts: EFFORTS_THROUGH_MAX, cacheBreakpoint: true, wireModel: 'openai/gpt-5.6-luna', reasoningMode: 'pro' }],
  ['openai/gpt-5.5', { input: 2.5, output: 15, maxTokens: 128 * 1024, canThink: true, efforts: EFFORTS_THROUGH_XHIGH }],
  ['openai/gpt-5.5-pro', { input: 30, output: 180, maxTokens: 128 * 1024, canThink: true, efforts: EFFORTS_THROUGH_XHIGH }],
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
  ['nvidia/nemotron-3-super-120b-a12b', { input: 0.1, output: 0.5, maxTokens: 128 * 1024, canThink: true }],
  ['nvidia/nemotron-3-ultra-550b-a55b', { input: 0.625, output: 3.125, maxTokens: 128 * 1024, canThink: true }],
  ['nvidia/nemotron-3.5-lightning', { input: 0.08, output: 0.2, maxTokens: 128 * 1024, canThink: true }],
  ['qwen/qwen3.6-27b', { input: 0.3, output: 2, maxTokens: 64 * 1024, canThink: true }],
  ['qwen/qwen3.6-35b-a3b', { input: 0.1, output: 0.9, maxTokens: 64 * 1024, canThink: true }],
  ['qwen/qwen3.8-27b', { input: 0.214, output: 2.55, maxTokens: 64 * 1024, canThink: true }],
  ['qwen/qwen3.8-2.4t-a95b', { input: 2, output: 6, maxTokens: 64 * 1024, canThink: true }],
  // Kimi K3 (1M context) at Moonshot's list rate. OpenRouter resells it a
  // little cheaper but reports its own per-request cost, which wins over this
  // table, so one row serves both routes. `maxTokens` is the output default.
  ['moonshotai/kimi-k3', { input: 3, output: 15, maxTokens: 131_072, canThink: true, noThink: 'unsupported', efforts: ['low', 'high', 'max'] }],
  // Chrome's built-in on-device models. Unpriced like every other local row:
  // nobody sells them, and the provider says a local run costs nothing.
  // `baseModel`/`specNames`/`modelVersion`/`component` are Chrome's own
  // spellings, read in src/chrome/.
  ['chrome/gemini-nano-v3', { maxTokens: 4096, baseModel: 'nano_v3', specNames: ['v3Nano'], modelVersion: 'v3', component: 'nano_v3_gpu_component' }],
  ['chrome/gemma-4-e2b-it', { maxTokens: 4096, baseModel: 'gemma4_2b', specNames: ['gemma4-2b-it'], modelVersion: 'v4', component: 'gemma4_component' }],
  ['chrome/gemma-4-e4b-it', { maxTokens: 4096, baseModel: 'gemma4_4b', specNames: ['gemma-4-E4B-it'], modelVersion: 'v4_4b', component: 'gemma4_4b_component' }],
  ['chrome/gemma-4-12b-it', { maxTokens: 4096, baseModel: 'gemma4_12b', modelVersion: 'v4_12b', component: 'gemma4_12b_component' }],
  // Local builds Ollama serves. No price: nobody sells them today, and a
  // zero would quietly become wrong the day one of them is listed. One id per
  // build, because the weights differ and so do the answers.
  ['google/gemma-4-e2b-it', { maxTokens: 128 * 1024, canThink: true }],
  ['google/gemma-4-e2b-it-q8_0', { maxTokens: 128 * 1024, canThink: true }],
  ['google/gemma-4-e2b-it-q4_k_m', { maxTokens: 128 * 1024, canThink: true }],
  ['google/gemma-4-e2b-it-qat', { maxTokens: 128 * 1024, canThink: true }],
  ['google/gemma-4-e4b-it', { maxTokens: 128 * 1024, canThink: true }],
  ['google/gemma-4-e4b-it-q8_0', { maxTokens: 128 * 1024, canThink: true }],
  ['google/gemma-4-e4b-it-q4_k_m', { maxTokens: 128 * 1024, canThink: true }],
  ['google/gemma-4-e4b-it-qat', { maxTokens: 128 * 1024, canThink: true }],
  ['google/gemma-4-12b-it', { maxTokens: 128 * 1024, canThink: true }],
  ['google/gemma-4-12b-it-q8_0', { maxTokens: 128 * 1024, canThink: true }],
  ['google/gemma-4-12b-it-q4_k_m', { maxTokens: 128 * 1024, canThink: true }],
  ['google/gemma-4-12b-it-qat', { maxTokens: 128 * 1024, canThink: true }],
  ['google/gemma-4-26b-a4b-it-q8_0', { maxTokens: 128 * 1024, canThink: true }],
  ['google/gemma-4-26b-a4b-it-q4_k_m', { maxTokens: 128 * 1024, canThink: true }],
  ['google/gemma-4-26b-a4b-it-mtp-q4_k_m', { maxTokens: 128 * 1024, canThink: true }],
  ['google/gemma-4-26b-a4b-it-qat', { maxTokens: 128 * 1024, canThink: true }],
  ['google/gemma-4-31b-it-q8_0', { maxTokens: 128 * 1024, canThink: true }],
  ['google/gemma-4-31b-it-q4_k_m', { maxTokens: 128 * 1024, canThink: true }],
  ['google/gemma-4-31b-it-qat', { maxTokens: 128 * 1024, canThink: true }],
  ['qwen/qwen3.6-27b-bf16', { maxTokens: 64 * 1024, canThink: true }],
  ['qwen/qwen3.6-27b-q4_k_m', { maxTokens: 64 * 1024, canThink: true }],
  ['qwen/qwen3.6-35b-a3b-bf16', { maxTokens: 64 * 1024, canThink: true }],
  ['qwen/qwen3.6-35b-a3b-q4_k_m', { maxTokens: 64 * 1024, canThink: true }],
  ['qwen/qwen3.8-27b-bf16', { maxTokens: 64 * 1024, canThink: true }],
  ['qwen/qwen3.8-27b-q4_k_m', { maxTokens: 64 * 1024, canThink: true }],
  ['nvidia/nemotron-3.5-lightning-q8_0', { maxTokens: 128 * 1024, canThink: true }],
  ['nvidia/nemotron-3.5-lightning-q4_k_m', { maxTokens: 128 * 1024, canThink: true }],
  ['nvidia/nemotron-3-super-120b-a12b-q8_0', { maxTokens: 128 * 1024, canThink: true }],
  ['nvidia/nemotron-3-super-120b-a12b-q4_k_m', { maxTokens: 128 * 1024, canThink: true }],
  // Free models — may log/store/use your data
  ['openai/gpt-oss-120b:free', { input: 0, output: 0, maxTokens: 128 * 1024, free: true }],
  ['openai/gpt-oss-20b:free', { input: 0, output: 0, maxTokens: 128 * 1024, free: true }],
  ['nvidia/nemotron-3-super-120b-a12b:free', { input: 0, output: 0, maxTokens: 128 * 1024, canThink: true, free: true }],
  ['nvidia/nemotron-3-ultra-550b-a55b:free', { input: 0, output: 0, maxTokens: 128 * 1024, canThink: true, free: true }],
  ['nvidia/nemotron-3.5-lightning:free', { input: 0, output: 0, maxTokens: 128 * 1024, canThink: true, free: true }],
  ['qwen/qwen3-coder:free', { input: 0, output: 0, maxTokens: 128 * 1024, free: true }],
  ['qwen/qwen3.6-plus:free', { input: 0, output: 0, maxTokens: 64 * 1024, free: true }],
  ['google/gemma-4-31b-it:free', { input: 0, output: 0, maxTokens: 128 * 1024, canThink: true, free: true }],
  ['google/gemma-4-26b-a4b-it:free', { input: 0, output: 0, maxTokens: 128 * 1024, canThink: true, free: true }],
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

// What Chrome calls the row's weights where it records having them: the
// asset_id of its entry in the manifest ledger.
export function componentFor(baseModel) {
  return BY_BASE_MODEL.get(baseModel)?.component
}

// Which local build answers a row on Ollama. Separate from the table above
// because it is Ollama's naming, not the model's: a hosted row and a local
// one are the same model, and only the tag differs.
//
// A bare id is the hosted model, so on Ollama it maps to the build closest to
// what the hosted route actually runs — which is not the same answer per
// family. Gemma-4 is served bf16, so a bare gemma id takes bf16 and the two
// match. Every qwen endpoint that names a quantization serves fp8, and no
// GGUF build is fp8 — q8_0 is int8 with a scale per block, the same width in
// a different number system — so a bare qwen id takes q8_0 as the closest
// thing that runs anywhere, and is near rather than equal to its hosted
// route. Every other build is its own id, since a 4-bit answer is not an
// 8-bit one and a run should not have to guess which it got.
//
// Tag names are Ollama's own and not always literal — several `-bf16` tags
// hold F16. Ours follow the tag, since the tag is what gets pulled.
const OLLAMA_TAGS = new Map([
  ['google/gemma-4-e2b-it', 'gemma4:e2b-it-bf16'], // 10GB
  ['google/gemma-4-e2b-it-q8_0', 'gemma4:e2b-it-q8_0'], // 8.1GB
  ['google/gemma-4-e2b-it-q4_k_m', ['gemma4:e2b-it-q4_K_M', 'gemma4:e2b']], // 7.2GB
  ['google/gemma-4-e2b-it-qat', 'gemma4:e2b-it-qat'], // 4.3GB
  ['google/gemma-4-e4b-it', 'gemma4:e4b-it-bf16'], // 16GB
  ['google/gemma-4-e4b-it-q8_0', 'gemma4:e4b-it-q8_0'], // 12GB
  ['google/gemma-4-e4b-it-q4_k_m', ['gemma4:e4b-it-q4_K_M', 'gemma4:e4b']], // 9.6GB
  ['google/gemma-4-e4b-it-qat', 'gemma4:e4b-it-qat'], // 6.1GB
  ['google/gemma-4-12b-it', 'gemma4:12b-it-bf16'], // 24GB
  ['google/gemma-4-12b-it-q8_0', 'gemma4:12b-it-q8_0'], // 13GB
  ['google/gemma-4-12b-it-q4_k_m', ['gemma4:12b-it-q4_K_M', 'gemma4:12b']], // 7.6GB
  ['google/gemma-4-12b-it-qat', 'gemma4:12b-it-qat'], // 7.2GB
  ['google/gemma-4-26b-a4b-it', 'gemma4:26b-a4b-it-bf16'], // 52GB
  ['google/gemma-4-26b-a4b-it-q8_0', 'gemma4:26b-a4b-it-q8_0'], // 28GB
  ['google/gemma-4-26b-a4b-it-q4_k_m', 'gemma4:26b-a4b-it-q4_K_M'], // 18GB, worse than -mtp: 4-bit attention where that is 8-bit
  ['google/gemma-4-26b-a4b-it-mtp-q4_k_m', ['gemma4:26b-a4b-it-mtp-q4_K_M', 'gemma4:26b']], // 19GB
  ['google/gemma-4-26b-a4b-it-qat', 'gemma4:26b-a4b-it-qat'], // 16GB
  ['google/gemma-4-31b-it', 'gemma4:31b-it-bf16'], // 63GB
  ['google/gemma-4-31b-it-q8_0', 'gemma4:31b-it-q8_0'], // 34GB
  ['google/gemma-4-31b-it-q4_k_m', ['gemma4:31b-it-q4_K_M', 'gemma4:31b']], // 20GB
  ['google/gemma-4-31b-it-qat', 'gemma4:31b-it-qat'], // 19GB
  ['qwen/qwen3.6-27b', ['qwen3.6:27b-q8_0', 'qwen3.6:27b-mtp-q8_0']], // 30GB
  ['qwen/qwen3.6-27b-bf16', ['qwen3.6:27b-bf16', 'qwen3.6:27b-mtp-bf16']], // 56GB
  ['qwen/qwen3.6-27b-q4_k_m', ['qwen3.6:27b-q4_K_M', 'qwen3.6:27b-mtp-q4_K_M', 'qwen3.6:27b']], // 17GB
  ['qwen/qwen3.6-35b-a3b', ['qwen3.6:35b-a3b-q8_0', 'qwen3.6:35b-a3b-mtp-q8_0']], // 39GB
  ['qwen/qwen3.6-35b-a3b-bf16', ['qwen3.6:35b-a3b-bf16', 'qwen3.6:35b-a3b-mtp-bf16']], // 71GB
  ['qwen/qwen3.6-35b-a3b-q4_k_m', ['qwen3.6:35b-a3b-q4_K_M', 'qwen3.6:35b-a3b-mtp-q4_K_M', 'qwen3.6:35b-a3b']], // 24GB
  ['qwen/qwen3.8-27b', ['qwen3.8:27b-q8_0', 'qwen3.8:27b-mtp-q8_0']], // 30GB
  ['qwen/qwen3.8-27b-bf16', ['qwen3.8:27b-bf16', 'qwen3.8:27b-mtp-bf16']], // 56GB
  ['qwen/qwen3.8-27b-q4_k_m', ['qwen3.8:27b-q4_K_M', 'qwen3.8:27b-mtp-q4_K_M', 'qwen3.8:27b']], // 18GB
  ['nvidia/nemotron-3.5-lightning', 'nemotron-3.5-lightning:30b-a3b-bf16'], // 66GB
  ['nvidia/nemotron-3.5-lightning-q8_0', 'nemotron-3.5-lightning:30b-a3b-q8_0'], // 35GB
  ['nvidia/nemotron-3.5-lightning-q4_k_m', ['nemotron-3.5-lightning:30b-a3b-q4_K_M', 'nemotron-3.5-lightning:30b-a3b', 'nemotron-3.5-lightning:30b']], // 25GB
  // Hosted one each at fp8 and bf16, so no majority to match: bf16 is the
  // reference, and never worse than the route it stands in for.
  ['nvidia/nemotron-3-super-120b-a12b', 'nemotron-3-super:120b-a12b-bf16'], // 247GB
  ['nvidia/nemotron-3-super-120b-a12b-q8_0', 'nemotron-3-super:120b-a12b-q8_0'], // 132GB
  ['nvidia/nemotron-3-super-120b-a12b-q4_k_m', ['nemotron-3-super:120b-a12b-q4_K_M', 'nemotron-3-super:120b-a12b', 'nemotron-3-super:120b']], // 87GB
])

// Undefined for a model Ollama has no mapping for, which is what tells the
// adapter to refuse rather than post a registry id no local server knows.
// A row names one tag, or several when the same build is published under
// more than one name. The first is the one the id claims.
const namesOf = (entry) => (Array.isArray(entry) ? entry : [entry])

export function ollamaTagFor(model) {
  const entry = OLLAMA_TAGS.get(resolveModel(model))
  return entry && namesOf(entry)[0]
}

// Every name for a row's build, most-canonical first: the tag its id claims,
// then any that ARE that tag. A `-mtp-` twin is the same weights with
// speculative decoding switched on; a shorter tag is the same manifest under
// the name most people actually pull, since `ollama pull gemma4:e4b` leaves
// nothing named gemma4:e4b-it-q4_K_M on the machine. Listing them together is
// the claim that they answer alike, which is what lets them share one id and
// one cache entry.
//
// `:latest` is deliberately absent everywhere. Every tag here can be
// re-pointed at a new build, but that one is re-pointed across model SIZES —
// gemma4:latest is e4b today — so trusting it would eventually serve a
// different model rather than a different build.
const BY_TAG = new Map([...OLLAMA_TAGS.values()].map((names) => [namesOf(names)[0], namesOf(names)]))

export function ollamaEquivalents(tag) {
  return BY_TAG.get(tag) ?? [tag]
}

export function ollamaModels() {
  return [...OLLAMA_TAGS.keys()]
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
  // A row the table knows without knowing a rate: a local build nobody sells.
  // Null rather than zero, which would be a claim, and the wrong one as soon
  // as somebody lists it.
  if (prices.input == null || prices.output == null) return null
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
