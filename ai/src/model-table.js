// Reasoning ladders a model row can point `efforts` at. Named by their top rung, since the levels
// below it come along: OpenAI gates the high end per model — `max` is gpt-5.6 and gpt-6, `xhigh`
// reaches back through 5.5, 5.4 and 5.3-codex.
//
// A ladder is the model's, not the route's. OpenRouter lists `max` for gpt-6-astra just as OpenAI
// does, and the openai adapter and a gateway both send openai/ rows to the Responses API, so no
// route here narrows a model's ladder.
//
// 'manual' is deliberately absent from both: it is Anthropic's fixed-budget marker rather than a
// wire value any other provider accepts, and even there only a model that still takes
// `budget_tokens` has a form for it. A row with no `efforts` takes EFFORTS_THROUGH_MAX, so
// `manual` is offered only where a row names it, and rejected up front everywhere else instead of
// failing on the wire.
export const EFFORTS_THROUGH_MAX = ['low', 'medium', 'high', 'xhigh', 'max']
const EFFORTS_THROUGH_XHIGH = ['low', 'medium', 'high', 'xhigh']

// Long-context tiers a row can point `longContext` at. A request whose prompt — fresh input plus
// every cache leg, since OpenAI's input count takes in the cached tokens too — runs past `above`
// tokens is billed at `input` times the row's input and cache rates and `output` times its output
// rate, on the WHOLE request rather than only the tokens past the line. A row with no
// `longContext` bills every request at its base rates.
//
// OpenAI's is one tier across every model that has one: 2x and 1.5x past 272K, on gpt-6-astra,
// the gpt-5.6 trio, gpt-5.5 and gpt-5.4, and every -pro row of those. The minis, nano and codex
// have none.
//
// No Anthropic row takes one, and that is the published price rather than a gap: Claude 4.6 and
// later bill the full 1M window at standard rates, and every older row here either has a 200k
// window, with nothing past it to charge more for, or has been retired from the first-party API.
const OPENAI_LONG_CONTEXT = { above: 272_000, input: 2, output: 1.5 }

// Prices in dollars per million tokens. The main list is every paid model OpenRouter serves; its free
// endpoints have a list of their own, and the local models run on this machine.
export const MAIN_MODELS = [
  ['anthropic/claude-fable-5.1', { input: 10, output: 50, cacheReadPrice: 0.25, maxTokens: 128_000, canThink: 'adaptive', noThink: 'unsupported' }],
  ['anthropic/claude-fable-5', { input: 10, output: 50, maxTokens: 128_000, canThink: 'adaptive', noThink: 'unsupported' }],
  ['anthropic/claude-haiku-4.5', { input: 1, output: 5, maxTokens: 64_000 }],
  ['anthropic/claude-3-haiku', { input: 0.25, output: 1.25, maxTokens: 4096, canThink: false, openRouterOnly: true }],
  ['anthropic/claude-sonnet-5', { input: 2, output: 10, maxTokens: 128_000, canThink: 'adaptive', noThink: 'explicit' }],
  ['anthropic/claude-sonnet-4.6', { input: 3, output: 15, maxTokens: 128_000, canThink: 'adaptive', efforts: ['low', 'medium', 'high', 'max', 'manual'] }],
  ['anthropic/claude-sonnet-4.5', { input: 3, output: 15, maxTokens: 64 * 1024 }],
  ['anthropic/claude-sonnet-4', { input: 3, output: 15, maxTokens: 64 * 1024, openRouterOnly: true }],
  // Thinking is always on: `disabled` and a manual `budget_tokens` both 400. Cache reads are 0.05x
  // input rather than the usual 0.10x, so the row names them.
  ['anthropic/claude-opus-5.5', { input: 4, output: 20, cacheReadPrice: 0.2, maxTokens: 128_000, canThink: 'adaptive', noThink: 'unsupported' }],
  ['anthropic/claude-opus-5', { input: 5, output: 25, maxTokens: 128_000, canThink: 'adaptive', noThink: 'explicit' }],
  ['anthropic/claude-opus-4.8', { input: 5, output: 25, maxTokens: 128_000, canThink: 'adaptive' }],
  ['anthropic/claude-opus-4.7', { input: 5, output: 25, maxTokens: 128_000, canThink: 'adaptive' }],
  ['anthropic/claude-opus-4.6', { input: 5, output: 25, maxTokens: 128_000, canThink: 'adaptive', efforts: ['low', 'medium', 'high', 'max', 'manual'] }],
  ['anthropic/claude-opus-4.5', { input: 5, output: 25, maxTokens: 64 * 1024 }],
  // Two unrelated things wear `-pro` here. A row carrying wireModel is an OPENROUTER ALIAS for
  // reasoning.mode=pro on the model it names: same weights, same rate, more tokens spent. A row
  // without one — gpt-5.5-pro, gpt-5.4-pro — is an OPENAI MODEL NAME, priced six times its namesake
  // because it is a different model. Adding a new `-pro` means deciding which, and the rate says
  // it: same as its base, or not.
  ['openai/gpt-6-astra', { input: 10, output: 50, longContext: OPENAI_LONG_CONTEXT, maxTokens: 128_000, noThink: 'unsupported', cacheBreakpoint: true }],
  ['openai/gpt-6-astra-pro', { input: 10, output: 50, longContext: OPENAI_LONG_CONTEXT, maxTokens: 128_000, noThink: 'unsupported', cacheBreakpoint: true, wireModel: 'openai/gpt-6-astra', reasoningMode: 'pro' }],
  ['openai/gpt-6-sol', { input: 2, output: 10, longContext: OPENAI_LONG_CONTEXT, maxTokens: 128_000, noThink: 'explicit', cacheBreakpoint: true }],
  ['openai/gpt-6-sol-pro', { input: 2, output: 10, longContext: OPENAI_LONG_CONTEXT, maxTokens: 128_000, noThink: 'unsupported', cacheBreakpoint: true, wireModel: 'openai/gpt-6-sol', reasoningMode: 'pro' }],
  ['openai/gpt-6-luna', { input: 0.1, output: 0.5, longContext: OPENAI_LONG_CONTEXT, maxTokens: 128_000, noThink: 'explicit', cacheBreakpoint: true }],
  ['openai/gpt-6-luna-pro', { input: 0.1, output: 0.5, longContext: OPENAI_LONG_CONTEXT, maxTokens: 128_000, noThink: 'unsupported', cacheBreakpoint: true, wireModel: 'openai/gpt-6-luna', reasoningMode: 'pro' }],
  // 4 / 20 is Sol's PROMOTIONAL rate, which OpenAI's pricing page publishes as its table price and
  // says holds at least through 2026-11-21 — the one promotion in the openai rows. Recheck after
  // that date: the rate it reverts to is not published, so a lapse cannot be priced in advance.
  ['openai/gpt-5.6-sol', { input: 4, output: 20, longContext: OPENAI_LONG_CONTEXT, maxTokens: 128_000, noThink: 'explicit', cacheBreakpoint: true }],
  ['openai/gpt-5.6-sol-pro', { input: 4, output: 20, longContext: OPENAI_LONG_CONTEXT, maxTokens: 128_000, noThink: 'unsupported', cacheBreakpoint: true, wireModel: 'openai/gpt-5.6-sol', reasoningMode: 'pro' }],
  ['openai/gpt-5.6-terra', { input: 2, output: 12, longContext: OPENAI_LONG_CONTEXT, maxTokens: 128_000, noThink: 'explicit', cacheBreakpoint: true }],
  ['openai/gpt-5.6-terra-pro', { input: 2, output: 12, longContext: OPENAI_LONG_CONTEXT, maxTokens: 128_000, noThink: 'unsupported', cacheBreakpoint: true, wireModel: 'openai/gpt-5.6-terra', reasoningMode: 'pro' }],
  ['openai/gpt-5.6-luna', { input: 0.2, output: 1.2, longContext: OPENAI_LONG_CONTEXT, maxTokens: 128_000, noThink: 'explicit', cacheBreakpoint: true }],
  ['openai/gpt-5.6-luna-pro', { input: 0.2, output: 1.2, longContext: OPENAI_LONG_CONTEXT, maxTokens: 128_000, noThink: 'unsupported', cacheBreakpoint: true, wireModel: 'openai/gpt-5.6-luna', reasoningMode: 'pro' }],
  // From gpt-5.5 down to gpt-4o-mini, OpenAI bills a cache write as ordinary input — the 1.25x
  // write arrived with GPT-5.6 — so each of these rows names its input rate as `cacheWritePrice`.
  ['openai/gpt-5.5', { input: 5, output: 30, cacheWritePrice: 5, longContext: OPENAI_LONG_CONTEXT, maxTokens: 128 * 1024, noThink: 'explicit', efforts: EFFORTS_THROUGH_XHIGH }],
  ['openai/gpt-5.5-pro', { input: 30, output: 180, cacheWritePrice: 30, longContext: OPENAI_LONG_CONTEXT, maxTokens: 128 * 1024, noThink: 'unsupported', efforts: ['medium', 'high', 'xhigh'] }],
  ['openai/gpt-5.4', { input: 2.5, output: 15, cacheWritePrice: 2.5, longContext: OPENAI_LONG_CONTEXT, maxTokens: 128 * 1024, efforts: EFFORTS_THROUGH_XHIGH }],
  ['openai/gpt-5.4-nano', { input: 0.2, output: 1.25, cacheWritePrice: 0.2, maxTokens: 128 * 1024, efforts: EFFORTS_THROUGH_XHIGH }],
  ['openai/gpt-5.4-mini', { input: 0.75, output: 4.5, cacheWritePrice: 0.75, maxTokens: 128 * 1024, efforts: EFFORTS_THROUGH_XHIGH }],
  ['openai/gpt-5.4-pro', { input: 30, output: 180, cacheWritePrice: 30, longContext: OPENAI_LONG_CONTEXT, maxTokens: 128 * 1024, noThink: 'unsupported', efforts: ['medium', 'high', 'xhigh'] }],
  ['openai/gpt-5.3-codex', { input: 1.75, output: 14, cacheWritePrice: 1.75, maxTokens: 128 * 1024, noThink: 'unsupported', efforts: EFFORTS_THROUGH_XHIGH }],
  ['openai/gpt-4.1-mini', { input: 0.4, output: 1.6, cacheReadPrice: 0.1, cacheWritePrice: 0.4, maxTokens: 32768, canThink: false }],
  ['openai/gpt-4o-mini', { input: 0.15, output: 0.6, cacheReadPrice: 0.075, cacheWritePrice: 0.15, maxTokens: 16384, canThink: false }],
  ['openai/gpt-oss-120b', { input: 0.039, output: 0.19, maxTokens: 128 * 1024, canThink: false, openRouterOnly: true }],
  ['google/gemma-4-31b-it', { input: 0.14, output: 0.4, maxTokens: 128 * 1024 }],
  ['google/gemma-4-26b-a4b-it', { input: 0.13, output: 0.4, maxTokens: 128 * 1024 }],
  ['google/gemini-3.8-flash', { input: 0.75, output: 3.75, maxTokens: 64 * 1024, noThink: 'unsupported' }],
  ['google/gemini-3.1-flash-lite-preview', { input: 0.25, output: 1.5, maxTokens: 64 * 1024, noThink: 'explicit' }],
  ['google/gemini-3.1-pro-preview', { input: 2, output: 12, maxTokens: 64 * 1024, noThink: 'unsupported' }],
  ['nvidia/nemotron-3-super-120b-a12b', { input: 0.085, output: 0.4, maxTokens: 128 * 1024, noThink: 'explicit' }],
  ['nvidia/nemotron-3-ultra-550b-a55b', { input: 0.625, output: 3.125, maxTokens: 128 * 1024, noThink: 'explicit' }],
  ['nvidia/nemotron-3.5-lightning', { input: 0.08, output: 0.2, maxTokens: 128 * 1024 }],
  ['qwen/qwen3.6-27b', { input: 0.3, output: 2, maxTokens: 64 * 1024, noThink: 'explicit' }],
  ['qwen/qwen3.6-35b-a3b', { input: 0.1, output: 0.9, maxTokens: 64 * 1024, noThink: 'explicit' }],
  ['qwen/qwen3.8-27b', { input: 0.214, output: 2.55, maxTokens: 64 * 1024, noThink: 'explicit' }],
  ['qwen/qwen3.8-2.4t-a95b', { input: 2, output: 6, maxTokens: 64 * 1024, noThink: 'unsupported' }],
  ['qwen/qwen3.8-max', { input: 2, output: 6, cacheReadPrice: 0.25, maxTokens: 128 * 1024, noThink: 'unsupported' }],
  ['deepseek/deepseek-v4-pro', { input: 1.32, output: 3.96, cacheReadPrice: 0.044, maxTokens: 384 * 1024, noThink: 'explicit', efforts: ['high', 'xhigh'] }],
  ['deepseek/deepseek-v4.1-flash', { input: 0.3, output: 1.2, cacheReadPrice: 0.006, maxTokens: 384 * 1024, noThink: 'explicit', efforts: ['low', 'high', 'max'] }],
  ['x-ai/grok-4.7', { input: 2, output: 6, cacheReadPrice: 0.5, longContext: { above: 200_000, input: 2, output: 2 }, maxTokens: 128 * 1024, noThink: 'unsupported', efforts: EFFORTS_THROUGH_XHIGH }],
  ['z-ai/glm-5.3', { input: 1.4, output: 4.4, cacheReadPrice: 0.26, maxTokens: 128 * 1024, noThink: 'unsupported', efforts: ['low', 'high', 'max'] }],
  // Kimi K3 (1M context) at Moonshot's list rate. OpenRouter resells it a little cheaper but
  // reports its own per-request cost, which wins over this table, so one row serves both routes.
  // `maxTokens` is the output default.
  ['moonshotai/kimi-k3', { input: 3, output: 15, maxTokens: 131_072, noThink: 'unsupported', efforts: ['low', 'high', 'max'] }],
]

// Models that run on this machine, which OpenRouter has no endpoint for: Chrome's on-device models,
// and the local builds Ollama serves.
export const LOCAL_MODELS = [
  // Chrome's built-in on-device models. Unpriced like every other local row: nobody sells them, and
  // the provider says a local run costs nothing. `baseModel`/`specNames`/`modelVersion`/`component`
  // are Chrome's own spellings, read in src/chrome/.
  ['chrome/gemini-nano-v3', { maxTokens: 4096, canThink: false, baseModel: 'nano_v3', specNames: ['v3Nano'], modelVersion: 'v3', component: 'nano_v3_gpu_component' }],
  ['chrome/gemma-4-e2b-it', { maxTokens: 4096, canThink: false, baseModel: 'gemma4_2b', specNames: ['gemma4-2b-it'], modelVersion: 'v4', component: 'gemma4_component' }],
  ['chrome/gemma-4-e4b-it', { maxTokens: 4096, canThink: false, baseModel: 'gemma4_4b', specNames: ['gemma-4-E4B-it'], modelVersion: 'v4_4b', component: 'gemma4_4b_component' }],
  ['chrome/gemma-4-12b-it', { maxTokens: 4096, canThink: false, baseModel: 'gemma4_12b', modelVersion: 'v4_12b', component: 'gemma4_12b_component' }],
  // Local builds Ollama serves. No price: nobody sells them today, and a zero would quietly become
  // wrong the day one of them is listed. One id per build, because the weights differ and so do the
  // answers.
  ['google/gemma-4-e2b-it', { maxTokens: 128 * 1024 }],
  ['google/gemma-4-e2b-it-q8_0', { maxTokens: 128 * 1024 }],
  ['google/gemma-4-e2b-it-q4_k_m', { maxTokens: 128 * 1024 }],
  ['google/gemma-4-e2b-it-qat', { maxTokens: 128 * 1024 }],
  ['google/gemma-4-e4b-it', { maxTokens: 128 * 1024 }],
  ['google/gemma-4-e4b-it-q8_0', { maxTokens: 128 * 1024 }],
  ['google/gemma-4-e4b-it-q4_k_m', { maxTokens: 128 * 1024 }],
  ['google/gemma-4-e4b-it-qat', { maxTokens: 128 * 1024 }],
  ['google/gemma-4-12b-it', { maxTokens: 128 * 1024 }],
  ['google/gemma-4-12b-it-q8_0', { maxTokens: 128 * 1024 }],
  ['google/gemma-4-12b-it-q4_k_m', { maxTokens: 128 * 1024 }],
  ['google/gemma-4-12b-it-qat', { maxTokens: 128 * 1024 }],
  ['google/gemma-4-26b-a4b-it-q8_0', { maxTokens: 128 * 1024 }],
  ['google/gemma-4-26b-a4b-it-q4_k_m', { maxTokens: 128 * 1024 }],
  ['google/gemma-4-26b-a4b-it-mtp-q4_k_m', { maxTokens: 128 * 1024 }],
  ['google/gemma-4-26b-a4b-it-qat', { maxTokens: 128 * 1024 }],
  ['google/gemma-4-31b-it-q8_0', { maxTokens: 128 * 1024 }],
  ['google/gemma-4-31b-it-q4_k_m', { maxTokens: 128 * 1024 }],
  ['google/gemma-4-31b-it-qat', { maxTokens: 128 * 1024 }],
  ['qwen/qwen3.6-27b-bf16', { maxTokens: 64 * 1024 }],
  ['qwen/qwen3.6-27b-q4_k_m', { maxTokens: 64 * 1024 }],
  ['qwen/qwen3.6-35b-a3b-bf16', { maxTokens: 64 * 1024 }],
  ['qwen/qwen3.6-35b-a3b-q4_k_m', { maxTokens: 64 * 1024 }],
  ['qwen/qwen3.8-27b-bf16', { maxTokens: 64 * 1024 }],
  ['qwen/qwen3.8-27b-q4_k_m', { maxTokens: 64 * 1024 }],
  ['nvidia/nemotron-3.5-lightning-q8_0', { maxTokens: 128 * 1024 }],
  ['nvidia/nemotron-3.5-lightning-q4_k_m', { maxTokens: 128 * 1024 }],
  ['nvidia/nemotron-3-super-120b-a12b-q8_0', { maxTokens: 128 * 1024 }],
  ['nvidia/nemotron-3-super-120b-a12b-q4_k_m', { maxTokens: 128 * 1024 }],
]

// OpenRouter's free endpoints — may log/store/use your data.
export const FREE_MODELS = [
  ['openai/gpt-oss-120b:free', { input: 0, output: 0, maxTokens: 128 * 1024, canThink: false, free: true }],
  ['openai/gpt-oss-20b:free', { input: 0, output: 0, maxTokens: 128 * 1024, canThink: false, free: true }],
  ['nvidia/nemotron-3-super-120b-a12b:free', { input: 0, output: 0, maxTokens: 128 * 1024, noThink: 'explicit', free: true }],
  ['nvidia/nemotron-3-ultra-550b-a55b:free', { input: 0, output: 0, maxTokens: 128 * 1024, noThink: 'explicit', free: true }],
  ['nvidia/nemotron-3.5-lightning:free', { input: 0, output: 0, maxTokens: 128 * 1024, free: true }],
  ['qwen/qwen3-coder:free', { input: 0, output: 0, maxTokens: 128 * 1024, canThink: false, free: true }],
  ['qwen/qwen3.6-plus:free', { input: 0, output: 0, maxTokens: 64 * 1024, canThink: false, free: true }],
  ['google/gemma-4-31b-it:free', { input: 0, output: 0, maxTokens: 128 * 1024, free: true }],
  ['google/gemma-4-26b-a4b-it:free', { input: 0, output: 0, maxTokens: 128 * 1024, free: true }],
  ['google/gemma-3-27b-it:free', { input: 0, output: 0, maxTokens: 8192, canThink: false, free: true }],
]
