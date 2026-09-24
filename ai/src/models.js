import { assert } from '#assert'
import { EFFORTS_THROUGH_MAX, FREE_MODELS, LOCAL_MODELS, MAIN_MODELS } from './model-table.js'

const DEFAULT_MAX_TOKENS = 64 * 1024

const MODELS = new Map([...MAIN_MODELS, ...LOCAL_MODELS, ...FREE_MODELS])

// The names the price table knows, in its own order: the main list, the local models, then the free
// endpoints. Not a closed set — `--model` takes any string, and an unknown one simply costs nothing
// the table can price — so this is what to OFFER, never what to allow. The server's console builds
// its model suggestions from it.
export const KNOWN_MODELS = [...MODELS.keys()]

const LISTING_PROVIDERS = ['anthropic', 'openai', 'openrouter', 'ollama', 'chrome', 'moonshot']

// The providers that make the models they serve, and the namespace those models carry.
const OWN_NAMESPACE = { anthropic: 'anthropic/', openai: 'openai/', moonshot: 'moonshotai/' }

// The models a provider serves, each with the effort levels it takes there; every model when no
// provider is named. OpenRouter serves the main list, and Anthropic, OpenAI and Moonshot its rows
// under their own namespace, bar the few only OpenRouter still reaches. Ollama serves the rows it
// has a local build for and Chrome its on-device ones, each answered by the lookup its adapter
// makes. `manual` is Anthropic's alone, so no other provider lists it.
//
// `free` works the way validateModel's does: the free endpoints with it, which are OpenRouter's, and
// everything else without, so a listing is exactly what that mode accepts.
function servedRows(provider, free) {
  if (free) return provider === undefined || provider === 'openrouter' ? FREE_MODELS : []
  const rows = [...MAIN_MODELS, ...LOCAL_MODELS]
  if (provider === undefined) return rows
  if (provider === 'openrouter') return MAIN_MODELS
  if (provider === 'ollama') return rows.filter(([id]) => ollamaTagFor(id))
  if (provider === 'chrome') return rows.filter(([id]) => baseModelFor(id))
  return MAIN_MODELS.filter(([id, row]) => id.startsWith(OWN_NAMESPACE[provider]) && !row.openRouterOnly)
}

export function supportedModels({ provider, free = false } = {}) {
  assert(provider === undefined || LISTING_PROVIDERS.includes(provider), `Unknown provider: ${provider}. Use: ${LISTING_PROVIDERS.join(', ')}`)
  const keepsManual = provider === undefined || provider === 'anthropic'
  return servedRows(provider, free).map(([id]) => ({
    id,
    efforts: canEffort(id) ? effortsFor(id).filter((level) => keepsManual || level !== 'manual') : [],
  }))
}

// What a caller gets when it names no model. A row of the model table, so the price, the output cap
// and the thinking rules all resolve for it.
export const DEFAULT_MODEL = 'anthropic/claude-opus-5.5'

const BLOCKED = new Set([
  'anthropic/claude-opus-4.1',
  'anthropic/claude-opus-4',
])

// Provider-side aliases that route to a concrete model. `gpt-5.6` is OpenAI's documented alias for
// gpt-5.6-sol; it's deliberately NOT a registry row so it can't accrue its own cache dir / price
// entry. Resolve it at the input boundary instead, so one run's cache, request, and cost all key
// off the tier it points at rather than splitting across alias and target.
//
// Bare `kimi-k3` gets the same treatment for a different reason: it's the id Moonshot's own docs
// use — and the one the adapter puts on the wire — so operators reach for it, but unresolved it
// matches no registry row. Every lookup would then quietly take its default: canThink false (so
// thinking switches OFF on a model that always reasons and bills for it), a 64k output cap instead
// of 131k, no price, and a cache dir that never shares with the namespaced id.
const MODEL_ALIASES = new Map([
  ['openai/gpt-5.6', 'openai/gpt-5.6-sol'],
  ['kimi-k3', 'moonshotai/kimi-k3'],
])

export function resolveModel(model) {
  return MODEL_ALIASES.get(model) ?? model
}

// Whether the registry recognises the id at all (aliases resolved first, so the bare `kimi-k3`
// counts). Every other lookup in this module answers for an id it has never seen with a silent
// default — canThink false, no narrowed effort ladder, the fallback output cap, a null cost — and
// that tolerance is deliberate: a model the table doesn't carry still routes through OpenRouter or
// a gateway and works. What it costs is that a typo'd id is indistinguishable from a real model
// that simply cannot reason, so every caller about to report a capability as missing asks this
// first and blames the id instead.
//
// Wider than KNOWN_MODELS, deliberately. That list is the table's rows and nothing else, because it
// is what to OFFER; this also recognises a BLOCKED id, because validateModel already turns those
// away by name ("use claude-opus-4.5 or newer") and calling one unrecognised would replace that
// with an invitation to check spelling that is already correct.
export function isRecognizedModel(model) {
  const id = resolveModel(model)
  return MODELS.has(id) || BLOCKED.has(id)
}

// What to say when a --think / --effort request names an id the registry doesn't recognise. `flag`
// is the part of the request that was refused, since that is the half of the command line to change
// if the id is right.
export function unknownModelMessage(model, flag) {
  return `Unknown model ${model} — it is not in the model registry, so ${flag} cannot be applied to it. Check the spelling, or add a row for it to the model table in \`ai/src/model-table.js\`.`
}

export function validateModel(model, { free = false } = {}) {
  assert(!BLOCKED.has(model), `Model ${model} is not supported. Use claude-opus-4.5 or newer.`)
  const info = MODELS.get(model)
  const isFree = info ? info.free : model.endsWith(':free')
  if (free) {
    assert(isFree, `Model ${model} is not free. Use a :free model with --free.`)
  } else {
    assert(!isFree, `Model ${model} requires --free flag.`)
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

// `noThink` — how a think=false request turns thinking off. One field with three states rather than
// two booleans, so a row can't claim a contradictory pair:
//
//   (absent)        omit the field; that already means no thinking.
//   'explicit'      omitting leaves thinking ON, so the off switch is sent:
//                   `{ type: 'disabled' }` on the Messages API (accepted at
//                   effort <= high, which the no-think path satisfies by
//                   never sending an effort at all), `effort: 'none'` on
//                   Responses, `reasoning: { enabled: false }` through
//                   OpenRouter. A gateway's chat route has no common
//                   spelling for it and sends nothing.
//   'unsupported'   no opt-out exists — either the disabled form 400s at
//                   any effort (the fable 5 family) or the API has no off
//                   switch at all (kimi-k3, the gpt-6 astra rows, which
//                   reject `reasoning_effort: 'none'` and floor at `low`,
//                   and every model OpenRouter marks reasoning-mandatory).
//                   Omitting is the only legal request, even though thinking
//                   stays on.
export function needsExplicitNoThink(model) {
  return MODELS.get(model)?.noThink === 'explicit'
}

export function canDisableThink(model) {
  return MODELS.get(model)?.noThink !== 'unsupported'
}

// Anthropic `task-budgets-2026-03-13` beta gate: the models that accept the beta header + the
// `output_config.task_budget` body field. Callers gate on this before flipping the option on
// per-request so a global `--task-budget=always` against a mixed-model run silently no-ops on
// unsupported passes instead of 400ing the API.
//
// Exported because a caller's --help text renders it — one set to read, rather than prose about
// the membership that has to be kept in step with this table.
//
// Fable 5.1 is here on the strength of the docs listing it, which hedge the entry pending launch.
// Unlike the fallback registry's unverified row, a wrong guess here is not free: this gate is what
// a caller checks before accepting a task-budget request, so a model wrongly listed is waved
// through and 400s on every request instead of being refused up front. Drop the row if the beta
// turns out not to cover it.
export const TASK_BUDGET_MODELS = new Set([
  'anthropic/claude-opus-5.5',
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

// Every effort level the CLI accepts. 'manual' is Anthropic's fixed-budget marker rather than a
// rung on the ladder — the non-Anthropic adapters reject it. Exported so the CLI's option check and
// the server's request validation read one array instead of mirroring a literal that can drift.
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'manual']

// The levels a model's reasoning knob takes: the row's own `efforts`, or EFFORTS_THROUGH_MAX for a
// row that names none. Undefined only for an id the registry doesn't carry, which is left to the
// provider. Keyed by model rather than by provider because the narrowing is the model's: K3 is
// reachable through Moonshot direct and through any OpenAI-compatible gateway as
// moonshotai/kimi-k3, and takes the same three levels either way.
//
// Aliases resolve first, so the bare `kimi-k3` a caller may pass narrows the same as the namespaced
// id. Tolerates a non-string so the server can check effort before it has validated the model
// field's type.
export function effortsFor(model) {
  const row = MODELS.get(resolveModel(model))
  return row && (row.efforts ?? EFFORTS_THROUGH_MAX)
}

// `wireModel` / `reasoningMode` — a row the direct API serves as a MODE on another model rather
// than as a model of its own. Astra Pro is astra run with `reasoning.mode: 'pro'`; the two
// spellings are the same thing, so which one a route needs depends on how it names models:
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
// Separate rows rather than an alias, deliberately: the two produce different answers, so they want
// separate cache dirs (modelSubdir keys off the raw id) even though they share a price and a token
// rate.
export function wireModelFor(model) {
  return MODELS.get(resolveModel(model))?.wireModel ?? model
}

// Undefined for every hosted row, which is what tells the adapter a model is not one of Chrome's.
export function baseModelFor(model) {
  return MODELS.get(resolveModel(model))?.baseModel
}

// Keyed by base model rather than registry id, so the adapter can look one up from what it already
// carries.
const BY_BASE_MODEL = new Map([...MODELS.values()].filter((r) => r.baseModel).map((r) => [r.baseModel, r]))

export function specNamesFor(baseModel) {
  return BY_BASE_MODEL.get(baseModel)?.specNames ?? []
}

export function modelVersionFor(baseModel) {
  return BY_BASE_MODEL.get(baseModel)?.modelVersion
}

// What Chrome calls the row's weights where it records having them: the asset_id of its entry in
// the manifest ledger.
export function componentFor(baseModel) {
  return BY_BASE_MODEL.get(baseModel)?.component
}

// Which local build answers a row on Ollama. Separate from the model table because it is Ollama's
// naming, not the model's: a hosted row and a local one are the same model, and only the tag
// differs.
//
// A bare id is the hosted model, so on Ollama it maps to the build closest to what the hosted route
// actually runs — which is not the same answer per family. Gemma-4 is served bf16, so a bare gemma
// id takes bf16 and the two match. Every qwen endpoint that names a quantization serves fp8, and no
// GGUF build is fp8 — q8_0 is int8 with a scale per block, the same width in a different number
// system — so a bare qwen id takes q8_0 as the closest thing that runs anywhere, and is near rather
// than equal to its hosted route. Every other build is its own id, since a 4-bit answer is not an
// 8-bit one and a run should not have to guess which it got.
//
// Tag names are Ollama's own and not always literal — several `-bf16` tags hold F16. Ours follow
// the tag, since the tag is what gets pulled.
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
  // Hosted one each at fp8 and bf16, so no majority to match: bf16 is the reference, and never
  // worse than the route it stands in for.
  ['nvidia/nemotron-3-super-120b-a12b', 'nemotron-3-super:120b-a12b-bf16'], // 247GB
  ['nvidia/nemotron-3-super-120b-a12b-q8_0', 'nemotron-3-super:120b-a12b-q8_0'], // 132GB
  ['nvidia/nemotron-3-super-120b-a12b-q4_k_m', ['nemotron-3-super:120b-a12b-q4_K_M', 'nemotron-3-super:120b-a12b', 'nemotron-3-super:120b']], // 87GB
])

// Undefined for a model Ollama has no mapping for, which is what tells the adapter to refuse rather
// than post a registry id no local server knows. A row names one tag, or several when the same
// build is published under more than one name. The first is the one the id claims.
const namesOf = (entry) => (Array.isArray(entry) ? entry : [entry])

export function ollamaTagFor(model) {
  const entry = OLLAMA_TAGS.get(resolveModel(model))
  return entry && namesOf(entry)[0]
}

// Every name for a row's build, most-canonical first: the tag its id claims, then any that ARE that
// tag. A `-mtp-` twin is the same weights with speculative decoding switched on; a shorter tag is
// the same manifest under the name most people actually pull, since `ollama pull gemma4:e4b` leaves
// nothing named gemma4:e4b-it-q4_K_M on the machine. Listing them together is the claim that they
// answer alike, which is what lets them share one id and one cache entry.
//
// `:latest` is deliberately absent everywhere. Every tag here can be re-pointed at a new build, but
// that one is re-pointed across model SIZES — gemma4:latest is e4b today — so trusting it would
// eventually serve a different model rather than a different build.
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

// Whether the model reads OpenAI's explicit `prompt_cache_breakpoint` marker. Version-gated rather
// than namespace-wide, so it lives on the row like `efforts` does: the field arrived with gpt-5.6,
// and every earlier model rejects a request carrying it with a 400 rather than ignoring it.
export function readsCacheBreakpoint(model) {
  return Boolean(MODELS.get(resolveModel(model))?.cacheBreakpoint)
}

// Whether the model exposes an effort knob. All thinking-capable models EXCEPT non-adaptive
// Anthropic — that branch takes a fixed budget_tokens instead of an effort string, so passing
// 'high' / 'low' / etc. there is meaningless. Adaptive Anthropic, OpenAI Responses, OpenRouter,
// Google, etc. all read effort verbatim.
export function canEffort(model) {
  const info = MODELS.get(model)
  if (!info?.canThink) return false
  if (model.startsWith('anthropic/') && info.canThink !== 'adaptive') return false
  return true
}

// Resolve the actual think/effort values that will hit the wire for a given model + user request.
// Folding the defaults in here means every cache key reflects the request shape — a no-effort run
// and an effort=high run can't accidentally share a slot just because one path applied the default
// later than the other.
export function normalizeThinkEffort(model, think, effort) {
  const useThink = Boolean(think) && canThink(model)
  const useEffort = useThink && canEffort(model) ? (effort ?? 'high') : undefined
  return { useThink, useEffort }
}

// normalizeThinkEffort for a request that is about to go out: same resolution, but a model that
// dropped what the caller asked for is an error here rather than a silent downgrade. Every request
// path takes this one, so a single wording serves them all.
//
// The unknown-model branch is why that wording is worth centralising: for an id with no row,
// normalizeThinkEffort drops think and effort exactly as it does for a registered model that
// genuinely cannot reason, so without it a mistyped --model surfaces as
// `--effort is not supported by model or --think is not enabled` — a sentence that sends you
// reading a model's capabilities instead of the id you typed.
export function resolveThinkEffort(model, think, effort) {
  const { useThink, useEffort } = normalizeThinkEffort(model, think, effort)
  const known = isRecognizedModel(model)
  if (useThink !== Boolean(think)) {
    throw new Error(known ? '--think is not supported by model' : unknownModelMessage(model, '--think'))
  }
  if (effort && useEffort !== effort) {
    throw new Error(known ? '--effort is not supported by model or --think is not enabled' : unknownModelMessage(model, '--effort'))
  }
  const allowed = effortsFor(model)
  if (useEffort && allowed && !allowed.includes(useEffort)) {
    throw new Error(`--effort ${useEffort} is not supported by model. Use: ${allowed.join(', ')}`)
  }
  return { useThink, useEffort }
}

// Canonical usage-accumulator shape — what the provider adapters' normalizeOneUsage emits and
// calculateCost consumes. They live here, next to the price table, so a caller can sum usage
// without pulling in the conversation loop.
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
// The read multiplier is not universal — a row can name a flat `cacheReadPrice` in dollars per Mtok
// instead — and nor is the 5m write's: a row can name a flat `cacheWritePrice` for that leg.
//
// Prices ONE request. The long-context tier is chosen from the prompt `usage` itself carries, so
// handed a sum of several requests it would read their combined prompt as one long one and bill
// every token at the tier. A caller holding a sum prices each request as it lands instead, which
// is what normalizeUsage does when given the model.
export function calculateCost(model, usage) {
  const prices = MODELS.get(model)
  if (!prices) return null
  // A row the table knows without knowing a rate: a local build nobody sells. Null rather than
  // zero, which would be a claim, and the wrong one as soon as somebody lists it.
  if (prices.input == null || prices.output == null) return null
  const cacheReadTokens = usage.cacheRead ?? 0
  const cacheWrite5mTokens = usage.cacheWrite5m ?? 0
  const cacheWrite1hTokens = usage.cacheWrite1h ?? 0
  const prompt = usage.input + cacheReadTokens + cacheWrite5mTokens + cacheWrite1hTokens
  const tier = prices.longContext && prompt > prices.longContext.above ? prices.longContext : undefined
  // Multiplied through last rather than folded into the rates, for the reason below: at the base
  // tier every term is then the exact expression it was before tiers existed.
  const inputTier = tier?.input ?? 1
  const outputTier = tier?.output ?? 1
  const inputCost = (usage.input * prices.input * inputTier) / 1_000_000
  // Branch instead of resolving one rate up front: folding `input * 0.10` first rounds differently
  // from multiplying the tokens through, moving every unoverridden row's price in the last bits (3
  // * 0.10 !== 0.3).
  const cacheReadCost = prices.cacheReadPrice == null
    ? (cacheReadTokens * prices.input * 0.10 * inputTier) / 1_000_000
    : (cacheReadTokens * prices.cacheReadPrice * inputTier) / 1_000_000
  const cacheWrite5mCost = prices.cacheWritePrice == null
    ? (cacheWrite5mTokens * prices.input * 1.25 * inputTier) / 1_000_000
    : (cacheWrite5mTokens * prices.cacheWritePrice * inputTier) / 1_000_000
  const cacheWrite1hCost = (cacheWrite1hTokens * prices.input * 2.00 * inputTier) / 1_000_000
  const outputCost = (usage.output * prices.output * outputTier) / 1_000_000
  return inputCost + cacheReadCost + cacheWrite5mCost + cacheWrite1hCost + outputCost
}
