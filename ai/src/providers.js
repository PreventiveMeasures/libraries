import { CHROME_ADAPTER } from '#chrome'
import { env } from '#env'
import { assert } from '#assert'
import { fetchJSON } from './fetch-json.js'
import { ollamaOrigin, resolveOllamaTag } from './ollama.js'
import { calculateCost, effortsFor, ollamaModels, ollamaTagFor, reasoningModeFor, wireModelFor } from './models.js'
import { anthropicAuthHeader, anthropicShape, chatCompletionsBase, parseArgs, stripNamespace, toAnthropicModel, truncationError } from './wire-formats.js'

export { isMaxTokensTruncation } from './wire-formats.js'
import { cachesConversation, chatCompletionsInitialUserMessage, chatCompletionsSystemMessage, isAnthropicRoute, isOpenAIRoute, responsesInitialUserMessage } from './prompt-cache.js'

// Chat-completions function-tool shape (nested `function: {...}` wrapper), shared by every
// OpenAI-style chat backend — OpenRouter and Moonshot.
function toChatCompletionsTool(tool) {
  return { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.input_schema } }
}

// OpenAI Responses API takes function tools as flat top-level objects (no nested `function: {...}`
// wrapper as in chat completions).
function toOpenAIResponsesTool(tool) {
  return { type: 'function', name: tool.name, description: tool.description, parameters: tool.input_schema }
}

// Resolve the effort level a non-Anthropic request carries, or undefined for one that carries none.
// Centralises the policy all three non-Anthropic adapters share — an effort without thinking is a
// caller error, thinking defaults to 'high', and none of them understand the Anthropic-specific
// 'manual' value (which means "use a fixed budget_tokens number"). `model` is optional and only
// used to narrow the accepted set: a model that takes fewer levels than the CLI offers (see
// effortsFor) names the unsupported level rather than silently rounding it to a neighbouring one.
//
// The caller writes the result in its own shape rather than this doing it: the OpenAI Responses API
// nests it under `reasoning`, the chat-completions adapters take the flat `reasoning_effort`
// string.
function resolveEffort({ think, effort, model }) {
  if (!think) {
    if (effort) throw new Error('Thinking not enabled')
    return undefined
  }
  if (effort === 'manual') throw new Error('Manual effort unsupported on non-Anthropic providers')
  const level = effort ?? 'high'
  const allowed = effortsFor(model)
  if (allowed && !allowed.includes(level)) {
    throw new Error(`Effort "${level}" is not supported by this model. Use: ${allowed.join(', ')}`)
  }
  return level
}

// The OpenAI Responses wire format, parameterised by how the route names models. Two routes speak
// it and differ only in the namespace: the direct adapter strips it for a bare name the API must
// know, a gateway keeps it as the operator's routing key. Both resolve `wireModelFor` first,
// because that is not a namespace question — a `-pro` id is OpenRouter's way of asking for a mode
// on chat completions, which has no field for one, so on Responses it has to become the base model
// plus `reasoning.mode`. Everything else — body, parsing, tool replay — is identical, so it lives
// here once.
function openaiResponsesShape(modelId) {
  return {
    buildRequestBody(model, maxTokens, systemPrompt, messages, { think = false, effort, tools } = {}) {
      // Responses: system prompt goes top-level as `instructions`, chat history goes in `input`,
      // output cap is `max_output_tokens`. No cache_control — Responses handles caching server-side
      // via the input fingerprint.
      const body = {
        model: modelId(model),
        instructions: systemPrompt,
        input: [...messages],
        max_output_tokens: maxTokens,
        // Stateless. The default retains every request and response on OpenAI's servers, which for
        // a tool that uploads someone else's source code is a data-retention decision worth making
        // on purpose. Nothing here reads that state back: appendToolResults replays every output
        // item into the next `input`, which is exactly what stateless mode requires, so no
        // `previous_response_id` is ever needed.
        store: false,
      }
      if (tools) body.tools = tools.map(toOpenAIResponsesTool)
      const level = resolveEffort({ think, effort, model })
      // Independent knobs on one object: mode picks the standard or pro execution path, effort how
      // much reasoning happens within it. Emitted whenever the row names a mode, including with no
      // effort — a pro row is `noThink: 'unsupported'` so --no-think is refused up front, and this
      // is the backstop: naming pro anyway beats quietly serving the base model under the pro row's
      // cache dir and price.
      const mode = reasoningModeFor(model)
      if (level || mode) body.reasoning = { ...(level ? { effort: level } : null), ...(mode ? { mode } : null) }
      return body
    },

    checkResponse(json) {
      if (json.error) return `API error: ${json.error.message ?? 'unknown'}`
      if (json.status === 'failed') return `API error: ${json.error?.message ?? 'failed'}`
      if (json.status === 'incomplete' && json.incomplete_details?.reason === 'max_output_tokens') {
        return truncationError('max_output_tokens')
      }
      return null
    },

    extractResponseText(json) {
      // Responses: text lives in `output[*].type === 'message'` items whose `content[]` carries
      // `{ type: 'output_text', text }` blocks.
      return (json.output ?? [])
        .filter((i) => i.type === 'message')
        .flatMap((m) => (m.content ?? []).filter((b) => b.type === 'output_text').map((b) => b.text))
        .join('')
    },

    extractToolCalls(json) {
      return (json.output ?? [])
        .filter((i) => i.type === 'function_call')
        .map((i) => ({ id: i.call_id, name: i.name, ...parseArgs(i.arguments, i.name) }))
    },

    appendToolResults(messages, json, toolCalls, results) {
      // Responses replays state by feeding the previous turn's output items back as input items.
      // Push every output item (reasoning, function_call, message) verbatim so the model can pick
      // up where it left off, then pair each function_call with its function_call_output result.
      for (const item of json.output ?? []) messages.push(item)
      for (let i = 0; i < toolCalls.length; i++) {
        messages.push({ type: 'function_call_output', call_id: toolCalls[i].id, output: results[i] })
      }
    },

    // Responses carries the same split as the gateway route, in its own block naming. Only gpt-5.6
    // and later read the marker; everything else here falls through to a concatenated string.
    buildInitialUserMessage(model, userContent) {
      return responsesInitialUserMessage(model, userContent)
    },
  }
}

// The direct route: same resolution, then the namespace comes off, since here the id has to be a
// bare model name the API knows.
const OPENAI_RESPONSES_SHAPE = openaiResponsesShape((model) => stripNamespace(wireModelFor(model), 'openai/'))

// A Responses body, told apart from a chat-completions one for the gateway's response parsing. Both
// spell a bare failure `{ error }`, but that case is handled identically either way, so only the
// positive markers matter.
const isResponsesResponse = (json) => Array.isArray(json?.output) || typeof json?.status === 'string'


// Which wire format a response came back in. The two are self-identifying — Messages replies carry
// a `content` block array (or `type: 'error'`), chat-completions replies carry `choices` — so the
// parsing side dispatches on the response itself and needs no model threaded through it.
const isAnthropicResponse = (json) => json?.type === 'error' || Array.isArray(json?.content)

// A gateway fronting more than one upstream: the model's namespace picks which provider serves it,
// and each route gets the endpoint, body, headers and parsing that provider itself documents —
// never one shape the gateway is trusted to translate.
//
// Serving anthropic/* over /v1/chat/completions is such a translation, and not something a gateway
// generally does: Cloudflare AI Gateway and LiteLLM both expose Anthropic in its native format
// only. So an Anthropic route here is the Messages API end to end.
//
// `origin` is everything before `/v1`; an unset one leaves `url` empty and setProvider refuses the
// provider by name rather than posting to "undefined/v1/chat/completions".
function gatewayAdapter({ origin, apiUrlEnv, apiKeyEnv }) {
  // The id stays namespaced: on a gateway it is the routing key the operator configured, not a
  // model name the upstream API resolves.
  const messages = anthropicShape((model) => model)
  // Namespace kept for the same reason, but a row served as a mode on another model still resolves
  // to that base — see openaiResponsesShape.
  const responses = openaiResponsesShape(wireModelFor)
  const chat = CHAT_COMPLETIONS_SHAPE
  // Tolerates a missing model — buildRequestHeaders is public, and a caller that omits it should
  // get the chat route rather than a TypeError.
  const routesMessages = (model) => isAnthropicRoute(model ?? '')
  // OpenAI gets its own API too, not the compatible chat one: chat completions caps
  // `reasoning_effort` below `max` and has no `reasoning.mode` at all, so routing an openai/ model
  // through it silently costs capabilities the model has. Same rule as the Messages route above —
  // the namespace names the provider whose own shape the route speaks.
  const routesResponses = (model) => isOpenAIRoute(model ?? '')
  const shapeFor = (model) => (routesMessages(model) ? messages : routesResponses(model) ? responses : chat)
  const parse = (json) => (isAnthropicResponse(json) ? messages : isResponsesResponse(json) ? responses : chat)
  const chatUrl = origin ? `${origin}/v1/chat/completions` : ''
  const routeUrl = (model) => (routesMessages(model) ? `${origin}/v1/messages` : routesResponses(model) ? `${origin}/v1/responses` : chatUrl)
  return {
    // Kept for setProvider's "is this gateway configured" check; urlFor is what actually goes on
    // the wire.
    url: chatUrl,
    urlFor: routeUrl,
    apiUrlEnv,
    // Bearer always, plus Anthropic's own scheme on the Messages route: a pass-through gateway
    // forwards x-api-key to Anthropic, while LiteLLM- and Portkey-style proxies authenticate their
    // virtual keys on Authorization. Sending one would 401 against the other, and neither rejects
    // the spare.
    authHeader: (key, model) => ({ Authorization: `Bearer ${key}`, ...(routesMessages(model) ? anthropicAuthHeader(key) : null) }),
    apiKey: () => env(apiKeyEnv),
    // Names the wire format in the resumable-history stamp: one provider name covers three shapes
    // here, so the name alone can't tell a partial written on one route apart from another.
    wireRoute: (model) => (routesMessages(model) ? 'messages' : routesResponses(model) ? 'responses' : 'chat'),

    buildRequestBody: (model, ...rest) => shapeFor(model).buildRequestBody(model, ...rest),
    buildInitialUserMessage: (model, ...rest) => shapeFor(model).buildInitialUserMessage(model, ...rest),
    // The task-budget beta header belongs to the Messages route only.
    extraHeaders: (opts = {}) => (routesMessages(opts.model) ? messages.extraHeaders(opts) : null),

    checkResponse: (json) => parse(json).checkResponse(json),
    extractResponseText: (json) => parse(json).extractResponseText(json),
    extractToolCalls: (json) => parse(json).extractToolCalls(json),
    appendToolResults: (thread, json, toolCalls, results) => parse(json).appendToolResults(thread, json, toolCalls, results),
  }
}

// The chat-completions half of a gateway. Moonshot direct spreads chatCompletionsBase instead: it
// wants the concatenating user message, not the prefix/suffix split this adds.
const CHAT_COMPLETIONS_SHAPE = {
  ...chatCompletionsBase('max_completion_tokens'),

  buildRequestBody(model, maxTokens, systemPrompt, messages, { think = false, effort, tools, turn = 0 } = {}) {
    // `max_completion_tokens` rather than `max_tokens`: OpenAI's schema deprecated the latter and
    // OpenRouter's followed, so the newer name is the one a compatible gateway is likeliest to
    // accept.
    const body = { model, max_completion_tokens: maxTokens, messages: [chatCompletionsSystemMessage(model, systemPrompt), ...messages] }
    if (tools) body.tools = tools.map(toChatCompletionsTool)
    // The OpenAI-compatible flat string, not OpenRouter's own `reasoning: { effort }` object — the
    // flat one is what any chat-completions backend understands. The narrowing keys on the model,
    // not the adapter: a gateway can route moonshotai/kimi-k3, whose three levels are the model's
    // own.
    const level = resolveEffort({ think, effort, model })
    if (level) body.reasoning_effort = level
    // Same request-level field the Anthropic adapter sends, gated the same way — a gateway forwards
    // it verbatim, so an Anthropic model caches its conversation identically either way it is
    // reached. Anthropic-backed routes only: no other provider we route reads this field.
    if (isAnthropicRoute(model) && cachesConversation({ turn })) body.cache_control = { type: 'ephemeral' }
    return body
  },

  // The user message is the second shape a gateway can carry a breakpoint on, after the system
  // message built in buildRequestBody above. The concatenating version from chatCompletionsBase
  // stays right for every route that reads no breakpoint.
  buildInitialUserMessage(model, userContent) {
    return chatCompletionsInitialUserMessage(model, userContent)
  },
}

// Per-provider adapter. Each entry bundles the wire-format details (url, auth, env-var name) and
// the dispatch methods (request/response shape, tool-call extraction, follow-up-message format).
// Adding a new provider is one new entry plus a setProvider() lookup — no scattered edits.
const ADAPTERS = {
  anthropic: {
    url: 'https://api.anthropic.com/v1/messages',
    authHeader: anthropicAuthHeader,
    apiKey: () => env('ANTHROPIC_API_KEY'),
    ...anthropicShape(toAnthropicModel),
  },

  openai: {
    // Responses API rather than chat completions — chat-completions doesn't pair `reasoning_effort`
    // with tool calls cleanly on the gpt-5 family, it caps effort below `max`, and Responses is
    // what OpenAI's migration guide points new integrations at.
    // OPENAI_API_URL replaces the origin, same split as OPENROUTER_API_URL: the variable holds
    // everything before `/v1`, so one gateway serves both adapters as e.g. http://localhost:4000.
    url: (env('OPENAI_API_URL') || 'https://api.openai.com') + '/v1/responses',
    authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
    apiKey: () => env('OPENAI_API_KEY'),

    // The direct route resolves the registry id to a bare model name the API must know, and
    // `wireModelFor` is what turns a row served as a mode on another model (astra pro) into that
    // base name.
    ...OPENAI_RESPONSES_SHAPE,
  },

  // OpenRouter normalizes every model onto /v1/chat/completions and exposes no /v1/messages, so
  // unlike a general gateway it speaks exactly one wire format — Anthropic included, translated on
  // their side.
  openrouter: {
    ...CHAT_COMPLETIONS_SHAPE,
    // See OPENAI_API_URL above for the origin/path split these two share.
    url: (env('OPENROUTER_API_URL') || 'https://openrouter.ai/api') + '/v1/chat/completions',
    apiUrlEnv: 'OPENROUTER_API_URL',
    authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
    apiKey: () => env('OPENROUTER_API_KEY'),
  },

  // The same wire format pointed at a gateway of your own — LiteLLM, Portkey, a self-hosted proxy.
  // No default origin: AI_GATEWAY_API_URL names it, and setProvider refuses the provider until it
  // does.
  gateway: gatewayAdapter({
    origin: env('AI_GATEWAY_API_URL'),
    apiUrlEnv: 'AI_GATEWAY_API_URL',
    apiKeyEnv: 'AI_GATEWAY_API_KEY',
  }),

  // Ollama's OpenAI-compatible endpoint, serving models already pulled onto this machine. Local and
  // keyless: OLLAMA_API_KEY exists only for one reached through a proxy that wants auth.
  ollama: {
    // Not CHAT_COMPLETIONS_SHAPE: that one marks a reusable prefix for the routes whose vendors
    // read one, and a local server reads none. Several rows here are qwen/*, which would otherwise
    // be sent Anthropic's cache_control blocks by an endpoint that has no prompt cache at all.
    ...chatCompletionsBase('max_completion_tokens'),
    // The rows it serves are hosted models too, and priced as such. Nothing leaves the machine
    // here, so the table's rate is the wrong answer.
    runsLocally: true,
    // Resolved per request rather than at module load, so this and the tag probe in src/ollama.js
    // always agree on which server is being asked.
    urlFor: () => `${ollamaOrigin()}/v1/chat/completions`,
    apiUrlEnv: 'OLLAMA_API_URL',
    apiKey: () => env('OLLAMA_API_KEY'),
    // Omitted rather than sent empty: a local server rejects nothing, but a proxy in front of one
    // can reject a Bearer with no token after it.
    authHeader: (key) => (key ? { Authorization: `Bearer ${key}` } : {}),
    // The default preflight demands a key, which no local server has, so selection would fail on
    // exactly the machines this is for. Nothing else is checkable here: whether the tag is pulled
    // is a question only the server can answer, and it answers it on the first turn.
    preflight: () => env('OLLAMA_API_KEY') ?? null,

    // Ollama addresses a model by tag and keeps one per precision, so what goes on the wire is
    // never the registry id.
    buildRequestBody(model, maxTokens, systemPrompt, messages, { think = false, effort, tools } = {}) {
      const tag = ollamaTagFor(model)
      assert(tag, `Provider \`ollama\` has no local build for ${model}. Use one of: ${ollamaModels().join(', ')}`)
      const body = {
        model: tag,
        max_completion_tokens: maxTokens,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
      }
      if (tools) body.tools = tools.map(toChatCompletionsTool)
      const level = resolveEffort({ think, effort, model })
      if (level) body.reasoning_effort = level
      return body
    },

    // Some tags have a twin that is the same model with speculative decoding switched on, and
    // taking it needs the server asked which it has. That is a question buildRequestBody cannot
    // ask, being synchronous and offline.
    async finalizeBody(body) {
      const tag = await resolveOllamaTag(body.model)
      return tag === body.model ? body : { ...body, model: tag }
    },
  },

  // Chrome's built-in on-device model — the one adapter with no endpoint at all, and like ollama
  // above, no key. Its `preflight` checks for a browser and resident weights in place of a URL and a
  // key, and `send` routes a turn through the browser instead of fetchJSON. Taken whole from
  // src/chrome/, which owns everything about reaching that model.
  chrome: CHROME_ADAPTER,

  // Moonshot's own platform (platform.kimi.ai / api.moonshot.ai), the direct route to Kimi K3.
  // OpenAI-compatible chat completions, so the whole response side is shared — see
  // chatCompletionsBase.
  moonshot: {
    ...chatCompletionsBase('max_completion_tokens'),
    url: 'https://api.moonshot.ai/v1/chat/completions',
    authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
    apiKey: () => env('MOONSHOT_API_KEY'),

    buildRequestBody(model, maxTokens, systemPrompt, messages, { think = false, effort, tools } = {}) {
      // Same shared system-message rule as the OpenRouter body above, keyed on the namespaced id
      // rather than the stripped one. It resolves to a plain string for everything this endpoint
      // serves — moonshotai/* caches context automatically, so there is no breakpoint to mark — but
      // going through the one helper keeps that decision in a single place instead of restating it
      // as a special case here.
      const body = {
        model: stripNamespace(model, 'moonshotai/'),
        max_completion_tokens: maxTokens,
        messages: [chatCompletionsSystemMessage(model, systemPrompt), ...messages],
      }
      if (tools) body.tools = tools.map(toChatCompletionsTool)
      // kimi-k3 reasons unconditionally — there is no off switch, so a think=false request simply
      // omits the field (the registry marks it `noThink: 'unsupported'`, which is what makes the
      // CLI reject --no-think against it up front rather than promise a non-thinking run it can't
      // deliver).
      const level = resolveEffort({ think, effort, model })
      if (level) body.reasoning_effort = level
      return body
    },
  },
}

let provider

// What every adapter with an endpoint has to have before a run starts: a key, and a URL to send it
// to. The default preflight, so selection has one shape.
function httpPreflight(name, adapter) {
  const key = adapter.apiKey()
  assert(key, `Missing API key for ${name}`)
  // Only a gateway entry can be missing one, and only when its origin env var is unset — every
  // other adapter hardcodes its endpoint.
  assert(adapter.url, `Missing API URL for ${name}. Set ${adapter.apiUrlEnv}.`)
  return key
}

// Whatever an adapter needs true before the first turn, checked HERE at selection rather than on
// that turn. An endpoint adapter needs a key and a URL; the on-device one needs a browser and
// resident weights and returns no key, so it supplies its own preflight instead of being
// special-cased here.
export function setProvider(name) {
  assert(Object.hasOwn(ADAPTERS, name), `Unknown provider: ${name}. Use: ${Object.keys(ADAPTERS).join(', ')}`)
  const adapter = ADAPTERS[name]
  const apiKeyValue = (adapter.preflight ?? httpPreflight)(name, adapter) ?? null
  provider = { ...adapter, name, apiKeyValue }
}

// Release whatever any adapter is holding open. Today only `chrome` holds anything — a browser
// process, which keeps the event loop alive until it is closed — so for every other provider this
// is a no-op and a caller can end a run with it unconditionally.
//
// EVERY adapter, not the selected one. A caller that ran chrome and then switched to a hosted
// provider still has a browser holding the loop open, and closing only `provider` would miss it.
// Asking each adapter rather than naming chrome here keeps that fix from having to be repeated the
// next time something holds a resource.
//
// Releases the resource without deselecting the provider: a caller that closes and then issues
// another request gets a fresh browser rather than a crash, the same way a connection pool reopens.
export async function closeProvider() {
  await Promise.all(Object.values(ADAPTERS).map((adapter) => adapter.close?.()))
}

// What a turn cost. The price table prices the MODEL, so it cannot answer this alone: an adapter
// running the weights on this machine charges nothing, whatever the table says the hosted route
// would have cost. Off one, an unpriced row stays null — unknown is not free, and the caller says
// what to show for it.
export function turnCost(model, usage) {
  if (provider?.runsLocally) return 0
  return calculateCost(model, usage)
}

// Identifies the wire format a history entry was written under, for isResumableHistory. A provider
// that speaks one format is just its name; a gateway appends the route, so a partial written over
// chat-completions is never replayed into a Messages body. Entries stamped by an older version
// carry the bare name and simply stop matching, which starts the run fresh.
export function providerStamp(model) {
  // Undefined before setProvider: callers gate on a falsy stamp rather than a thrown TypeError.
  if (!provider) return undefined
  const route = provider.wireRoute?.(model)
  return route ? `${provider.name}:${route}` : provider.name
}

export function getProvider() {
  return provider
}

// Public dispatch surface — each call delegates to the active adapter. Keeping these as thin
// re-exports lets callers stay agnostic of the adapter shape; swapping providers is
// `setProvider(name)` and the rest of the pipeline keeps working.
export function buildRequestBody(model, maxTokens, systemPrompt, messages, opts) {
  return provider.buildRequestBody(model, maxTokens, systemPrompt, messages, opts)
}

// Per-request headers: the base set captured by setProvider plus any adapter-specific extras driven
// by the call's opts (e.g. anthropic-beta for task_budget). Adapters opt in by exposing
// extraHeaders; everyone else falls through to the base headers untouched.
// Built per request rather than once at setProvider: a gateway routing an anthropic/* model
// authenticates the Messages way (x-api-key + anthropic-version) and everything else the Bearer
// way, so which headers go out depends on the model.
export function buildRequestHeaders(opts = {}) {
  return {
    'Content-Type': 'application/json',
    ...provider.authHeader(provider.apiKeyValue, opts.model),
    ...provider.extraHeaders?.(opts),
  }
}

// Where this model's request goes. Fixed for every adapter that speaks one wire format; per-model
// for a gateway, which speaks two.
export function buildRequestUrl(model) {
  return provider.urlFor?.(model) ?? provider.url
}

// Where a turn actually goes. Every adapter but one posts JSON to an endpoint; the local one runs
// the turn in a browser it owns. Which of those happens is the adapter's to say rather than the
// caller's, so the choice lives here beside the rest of the dispatch surface and issueTurn stays
// one code path.
export async function sendRequest(model, body, { taskBudget = false, debug, label } = {}) {
  if (provider.send) return await provider.send(model, body, { debug, label })
  const headers = buildRequestHeaders({ taskBudget, model })
  // One last look at the body, for an adapter that has to ask the endpoint something before it can
  // finish one. Everyone else sends what they built.
  const sent = provider.finalizeBody ? await provider.finalizeBody(body) : body
  return await fetchJSON(buildRequestUrl(model), { method: 'POST', headers, body: JSON.stringify(sent) }, { debug, label })
}

export function checkResponse(json) {
  return provider.checkResponse(json)
}

export function extractResponseText(json) {
  return provider.extractResponseText(json)
}

// Tool-call shape: `{ id, name, args }` on success, or `{ id, name, argsError }` when the model
// produced malformed JSON args. `id` is whatever the provider needs back to match the tool result —
// `tool_use_id` for Anthropic, `call_id` for OpenAI Responses, `tool_call_id` for chat-completions
// / OpenRouter.
export function extractToolCalls(json) {
  return provider.extractToolCalls(json)
}

export function appendToolResults(messages, json, toolCalls, results) {
  return provider.appendToolResults(messages, json, toolCalls, results)
}

// Build the initial user message in the format the active provider prefers. When `userContent` is a
// list of blocks AND the provider's adapter knows how, a cache marker closes the block before the
// last one, so everything ahead of that per-request tail can be reused across the variants that
// share it without re-tokenizing each time.
export function buildInitialUserMessage(model, userContent) {
  return provider.buildInitialUserMessage(model, userContent)
}

export function normalizeOneUsage(data) {
  if (!data?.usage) return null
  const u = data.usage
  // Anthropic + OpenAI Responses both name the totals `input_tokens` / `output_tokens`.
  // Disambiguate cached-token reporting by checking both vendor-specific subkeys: Anthropic uses
  // `cache_creation` / `cache_read_input_tokens`; OpenAI Responses uses
  // `input_tokens_details.cached_tokens` (no separate cache-write accounting — server-side caching
  // is implicit and free for the caller).
  if ('input_tokens' in u) {
    const cc = u.cache_creation
    const cacheWrite5m = cc ? (cc.ephemeral_5m_input_tokens ?? 0) : (u.cache_creation_input_tokens ?? 0)
    const cacheWrite1h = cc?.ephemeral_1h_input_tokens ?? 0
    // The two vendors sharing this branch mean different things by the sibling `input_tokens`:
    // Anthropic EXCLUDES cache reads from it (`cache_read_input_tokens` is a separate bucket),
    // while OpenAI folds them in and `input_tokens_details` just details the subset. So subtract
    // for the OpenAI spelling only — otherwise a Responses cache read is charged twice, at full
    // price inside input_tokens and again at 0.1x as cacheRead, which on a cache-heavy turn
    // overstates the cost several-fold with no provider-supplied `cost` to fall back on.
    const anthropic = u.cache_read_input_tokens !== undefined
    const cacheRead = anthropic
      ? u.cache_read_input_tokens
      : Math.min(u.input_tokens_details?.cached_tokens ?? 0, u.input_tokens)
    return {
      input: anthropic ? u.input_tokens : u.input_tokens - cacheRead,
      output: u.output_tokens,
      cacheRead, cacheWrite5m, cacheWrite1h,
      cost: 0,
    }
  }
  // Chat-completions format (OpenRouter, Moonshot). OpenRouter ships its own `cost` and wins over
  // the price table; Moonshot reports no cost at all, so its tokens get priced locally — which is
  // what makes the cached-token split matter. Both spell the hit count the OpenAI-compatible way,
  // where `prompt_tokens` is the TOTAL with cache reads already folded in, so subtract to get the
  // fresh input calculateCost should charge full price for. Moonshot bills a cache hit at 0.1x —
  // exactly the cacheRead multiplier — so the split reproduces their published cost formula.
  if ('prompt_tokens' in u) {
    // Capped at the prompt itself: a backend that ever reported the two as disjoint counts would
    // otherwise claim more cache reads than there were prompt tokens (and drive the fresh-input
    // count negative).
    const cacheRead = Math.min(u.cached_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0, u.prompt_tokens)
    return {
      input: u.prompt_tokens - cacheRead,
      output: u.completion_tokens,
      cacheRead, cacheWrite5m: 0, cacheWrite1h: 0,
      cost: u.cost ?? 0,
    }
  }
  return null
}
