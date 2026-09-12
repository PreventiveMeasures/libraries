import { readsCacheBreakpoint } from './models.js'

// Prompt-cache markup: which routes read an explicit cache breakpoint out of
// the request body, and how each message shape carries one. Lives apart from
// the adapters because the same model gets the same caching either way it is
// reached — Anthropic direct or through a chat-completions gateway — and only
// the wire format differs.
//
// Two placements are explicit because the API cannot infer them:
//   - the system prompt, the one thing stable for a whole run. On Anthropic it
//     takes the 1h TTL that top-level caching has no way to express, worth the
//     2.0x write premium; on gpt-5.6, whose reads anchor to breakpoints, it is
//     the only thing that makes the run-wide prefix reusable at all;
//   - the isolate-mode prefix, where many per-export variants share a preamble
//     and differ only in the tail. The breakpoint has to sit at the end of the
//     SHARED part; left to the end of the whole message, every variant would
//     write its own entry and none would ever be read.
// The conversation tail is not explicit: `cache_control` at the top level of
// the request auto-places on the last cacheable block and advances as the
// thread grows, which is exactly the bookkeeping we would otherwise hand-roll.

export const isAnthropicRoute = (model) => model.startsWith('anthropic/')

// The same question for OpenAI, which the gateway asks to pick the Responses
// route, on the same namespace-names-the-provider rule.
export const isOpenAIRoute = (model) => model.startsWith('openai/')

// The two routes whose provider reads Anthropic's `cache_control` marker out
// of the request body. Everywhere else it would be noise, so those routes send
// plain strings and let the provider cache on its own.
//
// The marker each route gets is the one its own upstream provider documents,
// rather than one shape the gateway is trusted to translate. OpenRouter does
// translate — an Anthropic-style `cache_control` block becomes OpenAI's
// `prompt_cache_breakpoint` on an OpenAI-backed route — but that behaviour is
// OpenRouter's own, and this client has to keep working against any
// OpenAI-compatible gateway (see OPENROUTER_API_URL). Emitting the marker only
// where the provider defines it means nothing needs translating at all, and
// gpt-5.6 gets its own dialect below rather than riding on the translation.
//
// An unlisted namespace gets no marker: the marker-free form is the one every
// gateway forwards unchanged. A provider that needs an explicit breakpoint is
// an edit here; a model-gated one, like gpt-5.6's, is a row in the registry.
export const readsExplicitBreakpoint = (model) => isAnthropicRoute(model) || model.startsWith('qwen/')

// The marker that ends the system prompt, in whichever dialect the model
// reads. Distinct from prefixMarker below only in its TTL: the system prompt
// is the one thing stable for an entire run, so Anthropic gets the 1h form and
// its 2.0x write premium rather than the 5m default.
//
// gpt-5.6 needs this as much as Anthropic does. Its implicit mode places a
// breakpoint on the LATEST message, so each file's request writes an entry
// ending in that file's own content and the next file matches none of it.
// Marking the system prompt gives a run one entry every request reads. Sending
// it costs nothing where it cannot pay: a prefix under the ~1024-token minimum
// simply doesn't cache, reporting zero written rather than erroring. That is
// the common case, not a rare tail — measured over one caller's 20 system
// prompts, 12 sat under the floor, the short per-item ones among them (~223,
// ~680 and ~807 est. tokens). The eight larger prompts that dominated request
// volume cleared it comfortably (~1857 through ~3022), and those are the ones
// a run repeats most.
// The one definition of the Anthropic system-prompt TTL, shared with the direct
// adapter so the two routes cannot drift apart on it.
export const ANTHROPIC_SYSTEM_CACHE = { type: 'ephemeral', ttl: '1h' }

function systemMarker(model) {
  if (isAnthropicRoute(model)) return { cache_control: ANTHROPIC_SYSTEM_CACHE }
  // Every other route wants exactly what the prefix gets — Qwen's bare
  // ephemeral block, gpt-5.6's breakpoint, or nothing. Deferring rather than
  // restating the list keeps a newly added provider from being marked on the
  // isolate prefix and silently skipped here.
  return prefixMarker(model)
}

export function chatCompletionsSystemMessage(model, systemPrompt) {
  const marker = systemMarker(model)
  if (!marker) return { role: 'system', content: systemPrompt }
  return { role: 'system', content: [{ type: 'text', text: systemPrompt, ...marker }] }
}

// The marker that closes a reusable prefix, in whichever dialect the model
// reads — or null for one that caches on its own, where a split would only add
// a block boundary no cache acts on. Both dialects mean the same thing: the
// block carrying it, and everything before it, is the reusable part.
function prefixMarker(model) {
  if (readsExplicitBreakpoint(model)) return { cache_control: { type: 'ephemeral' } }
  if (readsCacheBreakpoint(model)) return { prompt_cache_breakpoint: { mode: 'explicit' } }
  return null
}

// Mirrors the Anthropic adapter's split: with a suffix present, the prefix
// goes as a separately-cached block so multiple variants that differ only in
// their tail share one cache entry for everything before it. Routes that
// read no marker concatenate instead — a
// two-block user message with nothing on it buys nothing, since automatic
// caching matches the token prefix and a block boundary is not a cache
// boundary anywhere.
//
// gpt-5.6 is the case that makes this matter beyond Anthropic: it anchors
// cache reads to breakpoints instead of the 128-token strides earlier OpenAI
// models use, so without a marker at the end of the shared part every variant
// writes its own entry and none is ever read.
//
// A user message is documented placement for the marker on every route that
// has one; the growing conversation tail is not marked here at all, since
// assistant and tool messages are not, and the request-level field below
// covers it.
//
// Chat-completions names its text blocks `text`, Responses names them
// `input_text`; the split and the marker are the same decision either way, so
// the two exported shapes differ only in that name.
function splitInitialUserMessage(model, userContent, userContentSuffix, textType) {
  if (!userContentSuffix) return { role: 'user', content: userContent }
  const marker = prefixMarker(model)
  if (!marker) return { role: 'user', content: userContent + userContentSuffix }
  return { role: 'user', content: [
    { type: textType, text: userContent, ...marker },
    { type: textType, text: userContentSuffix },
  ] }
}

export function chatCompletionsInitialUserMessage(model, userContent, userContentSuffix) {
  return splitInitialUserMessage(model, userContent, userContentSuffix, 'text')
}

// Anthropic's Messages API names its blocks `text` too, so this is the same
// shape the gateway sends — which is the point: one place decides where the
// prefix ends, and the adapter it is reached through only picks the spelling.
export function anthropicInitialUserMessage(model, userContent, userContentSuffix) {
  return splitInitialUserMessage(model, userContent, userContentSuffix, 'text')
}

export function responsesInitialUserMessage(model, userContent, userContentSuffix) {
  return splitInitialUserMessage(model, userContent, userContentSuffix, 'input_text')
}

// Whether this request has a conversation worth caching: only the turns after
// the head. A turn-0 request has no reader yet, and measured against real
// runs, most never get one.
//
// Declaring tools does not predict a second turn. A census of two prompts'
// cached entries found 1392 of 10476 tool-carrying requests ever called a
// tool — 13.3%, against a break-even of 27.8%, since a 1.25x write only pays
// off by turning a later 1.0x re-read into a 0.1x one. Those prompts ask the
// model to reach for their source-fetch tool sparingly, so that rate is the
// design working rather than a symptom to fix. Gating on tools meant 9084 of
// those requests wrote a tail entry nothing ever read.
//
// `turn > 0` is only reachable when tools were declared — a response with no
// tool calls ends the loop — so this writes exactly when a conversation has
// continued, and never on the one-shots that dominate. A cache entry holding
// two request/response pairs with no tools in sight is not a counterexample:
// that is a caller's format retry, and a retry calls chat() again, so the
// second attempt is a fresh conversation starting at turn 0
// whose history is concatenated onto the first. It re-sends a byte-identical
// prefix, which is the one case a turn-0 write would be read back verbatim —
// but measured at 1 entry in 6313, three orders of magnitude under the rate
// that would justify writing for it. The cost is that a
// conversation's first two turns no longer share an entry, which is why this
// stays a win only while the rate is under 21.7%: at 13.3% it is ~7.7%
// cheaper across tool-carrying requests.
//
// Not writing the tail at all would be a hair cheaper still on those two —
// the same census puts them at a mean of 2.24 turns when they do loop, just
// under the 2.28 crossover — but a conversation that explores through tools
// inverts the shape: nearly every one loops, for tens of turns. Skipping the
// write there would re-process the whole accumulated transcript every turn,
// ~30x the head against ~5x. Writing from turn 1 is the one rule that suits
// both, and it costs the exploring kind almost nothing: its head is a single
// sentence, so the entry it forgoes on turn 0 is ~20 tokens.
export const cachesConversation = ({ turn = 0 }) => turn > 0
