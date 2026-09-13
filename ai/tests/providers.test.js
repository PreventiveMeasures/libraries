/* eslint-disable max-lines-per-function */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { calculateCost, emptyUsage } from '../src/models.js'
import {
  appendToolResults,
  buildInitialUserMessage,
  buildRequestBody,
  buildRequestHeaders,
  buildRequestUrl,
  checkResponse,
  extractResponseText,
  extractToolCalls,
  normalizeOneUsage,
  setProvider,
  turnCost,
} from '../src/providers.js'

// `setProvider` reads `process.env.<PROVIDER>_API_KEY` and asserts it is
// non-empty. Setting a dummy value is sufficient — extractToolCalls only
// reads `provider.name`, never the URL or auth header.
function withProvider(name, envName, fn) {
  const previous = process.env[envName]
  process.env[envName] = 'test-key'
  try {
    setProvider(name)
    fn()
  } finally {
    if (previous === undefined) delete process.env[envName]
    else process.env[envName] = previous
  }
}

// providers.js reads its env vars once, when the module is evaluated, so a case
// that needs different values imports its own instance rather than mutating a
// live one. `undefined` in `vars` means "unset this for the duration".
let envInstance = 0
async function withProvidersEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]))
  const apply = (values) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  apply(vars)
  try {
    return await fn(await import(`../src/providers.js?env-${envInstance++}`))
  } finally {
    apply(saved)
  }
}

describe('extractToolCalls — anthropic', () => {
  it('returns the parsed-input tool_use blocks verbatim (no JSON.parse — Anthropic gives objects)', () => {
    withProvider('anthropic', 'ANTHROPIC_API_KEY', () => {
      const json = {
        content: [
          { type: 'text', text: 'thinking...' },
          { type: 'tool_use', id: 'tu_1', name: 'get_source', input: { hash: 'abc' } },
        ],
      }
      assert.deepEqual(extractToolCalls(json), [
        { id: 'tu_1', name: 'get_source', args: { hash: 'abc' } },
      ])
    })
  })

  it('returns an empty list when there are no tool_use blocks', () => {
    withProvider('anthropic', 'ANTHROPIC_API_KEY', () => {
      assert.deepEqual(extractToolCalls({ content: [{ type: 'text', text: 'no tools' }] }), [])
      assert.deepEqual(extractToolCalls({}), [])
    })
  })
})

describe('extractToolCalls — openai (Responses)', () => {
  it('parses well-formed JSON args', () => {
    withProvider('openai', 'OPENAI_API_KEY', () => {
      const json = {
        output: [
          { type: 'reasoning', summary: 'thinking' },
          { type: 'function_call', call_id: 'c1', name: 'get_source', arguments: '{"hash":"abc"}' },
        ],
      }
      assert.deepEqual(extractToolCalls(json), [
        { id: 'c1', name: 'get_source', args: { hash: 'abc' } },
      ])
    })
  })

  it('surfaces argsError on malformed JSON args instead of throwing', () => {
    // Pre-fix this would crash the entire run. The argsError field lets
    // ask() converts it into the standard `error` channel.
    withProvider('openai', 'OPENAI_API_KEY', () => {
      const json = {
        output: [
          { type: 'function_call', call_id: 'c1', name: 'get_source', arguments: '{"hash":' },
        ],
      }
      const calls = extractToolCalls(json)
      assert.equal(calls.length, 1)
      assert.equal(calls[0].id, 'c1')
      assert.equal(calls[0].name, 'get_source')
      assert.equal(calls[0].args, undefined)
      assert.match(calls[0].argsError, /get_source.*malformed JSON args/u)
    })
  })

  it('reports argsError per-call — well-formed siblings still parse', () => {
    withProvider('openai', 'OPENAI_API_KEY', () => {
      const json = {
        output: [
          { type: 'function_call', call_id: 'c1', name: 'a', arguments: '{}' },
          { type: 'function_call', call_id: 'c2', name: 'b', arguments: 'not json' },
          { type: 'function_call', call_id: 'c3', name: 'c', arguments: '{"x":1}' },
        ],
      }
      const calls = extractToolCalls(json)
      assert.equal(calls.length, 3)
      assert.deepEqual(calls[0].args, {})
      assert.equal(calls[0].argsError, undefined)
      assert.equal(calls[1].args, undefined)
      assert.match(calls[1].argsError, /b.*malformed JSON args/u)
      assert.deepEqual(calls[2].args, { x: 1 })
      assert.equal(calls[2].argsError, undefined)
    })
  })
})

describe('extractToolCalls — openrouter / chat-completions', () => {
  it('parses well-formed JSON args', () => {
    withProvider('openrouter', 'OPENROUTER_API_KEY', () => {
      const json = {
        choices: [{
          message: { tool_calls: [
            { id: 'tc_1', function: { name: 'get_source', arguments: '{"hash":"abc"}' } },
          ] },
        }],
      }
      assert.deepEqual(extractToolCalls(json), [
        { id: 'tc_1', name: 'get_source', args: { hash: 'abc' } },
      ])
    })
  })

  it('surfaces argsError on malformed JSON args without throwing', () => {
    withProvider('openrouter', 'OPENROUTER_API_KEY', () => {
      const json = {
        choices: [{
          message: { tool_calls: [
            { id: 'tc_1', function: { name: 'get_source', arguments: '<not json>' } },
          ] },
        }],
      }
      const calls = extractToolCalls(json)
      assert.equal(calls.length, 1)
      assert.equal(calls[0].args, undefined)
      assert.match(calls[0].argsError, /get_source.*malformed JSON args/u)
    })
  })

  it('returns an empty list when the response has no tool_calls', () => {
    withProvider('openrouter', 'OPENROUTER_API_KEY', () => {
      assert.deepEqual(extractToolCalls({ choices: [{ message: { content: 'plain reply' } }] }), [])
      assert.deepEqual(extractToolCalls({}), [])
    })
  })
})

describe('extractResponseText', () => {
  it('anthropic: concatenates text blocks, ignores tool_use', () => {
    withProvider('anthropic', 'ANTHROPIC_API_KEY', () => {
      const json = { content: [
        { type: 'text', text: 'Hello ' },
        { type: 'tool_use', id: 't1', name: 'fn', input: {} },
        { type: 'text', text: 'world' },
      ] }
      assert.equal(extractResponseText(json), 'Hello world')
    })
  })

  it('openai (Responses): joins output_text blocks across message items', () => {
    withProvider('openai', 'OPENAI_API_KEY', () => {
      const json = { output: [
        { type: 'reasoning', summary: 'thinking...' },
        { type: 'message', content: [
          { type: 'output_text', text: 'Hello ' },
          { type: 'output_text', text: 'world' },
        ] },
      ] }
      assert.equal(extractResponseText(json), 'Hello world')
    })
  })

  it('openrouter: reads choices[0].message.content', () => {
    withProvider('openrouter', 'OPENROUTER_API_KEY', () => {
      const json = { choices: [{ message: { content: 'Plain reply' } }] }
      assert.equal(extractResponseText(json), 'Plain reply')
    })
  })

  it('returns empty string when there is no text on any provider', () => {
    withProvider('anthropic', 'ANTHROPIC_API_KEY', () => {
      assert.equal(extractResponseText({}), '')
    })
    withProvider('openai', 'OPENAI_API_KEY', () => {
      assert.equal(extractResponseText({}), '')
    })
    withProvider('openrouter', 'OPENROUTER_API_KEY', () => {
      assert.equal(extractResponseText({}), '')
    })
  })
})

describe('checkResponse', () => {
  it('anthropic: returns null on a healthy response', () => {
    withProvider('anthropic', 'ANTHROPIC_API_KEY', () => {
      assert.equal(checkResponse({ content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn' }), null)
    })
  })

  it('anthropic: surfaces API error and max_tokens truncation', () => {
    withProvider('anthropic', 'ANTHROPIC_API_KEY', () => {
      assert.match(checkResponse({ type: 'error', error: { message: 'rate limited' } }), /API error.*rate limited/u)
      assert.match(checkResponse({ stop_reason: 'max_tokens' }), /truncated.*max_tokens/u)
    })
  })

  it('openai (Responses): returns null on a healthy response', () => {
    withProvider('openai', 'OPENAI_API_KEY', () => {
      assert.equal(checkResponse({ output: [], status: 'completed' }), null)
    })
  })

  it('openai: surfaces error and max_output_tokens truncation', () => {
    withProvider('openai', 'OPENAI_API_KEY', () => {
      assert.match(checkResponse({ error: { message: 'invalid_request' } }), /API error.*invalid_request/u)
      assert.match(
        checkResponse({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }),
        /truncated.*max_output_tokens/u,
      )
    })
  })

  it('openrouter: returns null on a healthy response, surfaces length-truncation', () => {
    withProvider('openrouter', 'OPENROUTER_API_KEY', () => {
      assert.equal(checkResponse({ choices: [{ finish_reason: 'stop' }] }), null)
      assert.match(checkResponse({ choices: [{ finish_reason: 'length' }] }), /truncated.*max_completion_tokens/u)
      assert.match(checkResponse({ error: { message: 'oops' } }), /API error.*oops/u)
    })
  })
})

describe('appendToolResults', () => {
  it('anthropic: appends an assistant message with the original content + a user message of tool_result blocks', () => {
    withProvider('anthropic', 'ANTHROPIC_API_KEY', () => {
      const messages = [{ role: 'user', content: 'go' }]
      const json = { content: [{ type: 'tool_use', id: 't1', name: 'fn', input: {} }] }
      const toolCalls = [{ id: 't1', name: 'fn', args: {} }]
      appendToolResults(messages, json, toolCalls, ['result-1'])
      assert.equal(messages.length, 3)
      assert.deepEqual(messages[1], { role: 'assistant', content: json.content })
      assert.deepEqual(messages[2], {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'result-1' }],
      })
    })
  })

  it('openai (Responses): replays every output item, then pairs each function_call with its result', () => {
    withProvider('openai', 'OPENAI_API_KEY', () => {
      const messages = []
      const json = { output: [
        { type: 'reasoning', summary: 's' },
        { type: 'function_call', call_id: 'c1', name: 'fn', arguments: '{}' },
      ] }
      const toolCalls = [{ id: 'c1', name: 'fn', args: {} }]
      appendToolResults(messages, json, toolCalls, ['result-1'])
      assert.equal(messages.length, 3)
      assert.equal(messages[0].type, 'reasoning')
      assert.equal(messages[1].type, 'function_call')
      assert.deepEqual(messages[2], { type: 'function_call_output', call_id: 'c1', output: 'result-1' })
    })
  })

  it('openrouter: appends the assistant message + one tool message per call', () => {
    withProvider('openrouter', 'OPENROUTER_API_KEY', () => {
      const messages = []
      const json = { choices: [{ message: { role: 'assistant', tool_calls: [
        { id: 'tc1', function: { name: 'fn', arguments: '{}' } },
      ] } }] }
      const toolCalls = [{ id: 'tc1', name: 'fn', args: {} }]
      appendToolResults(messages, json, toolCalls, ['result-1'])
      assert.equal(messages.length, 2)
      assert.equal(messages[0], json.choices[0].message)
      assert.deepEqual(messages[1], { role: 'tool', tool_call_id: 'tc1', content: 'result-1' })
    })
  })
})

describe('buildRequestBody — provider-specific shapes', () => {
  const messages = [{ role: 'user', content: 'hi' }]

  it('anthropic: nests system as a content array, includes max_tokens, no instructions field', () => {
    withProvider('anthropic', 'ANTHROPIC_API_KEY', () => {
      const body = buildRequestBody('anthropic/claude-opus-4.7', 1000, 'sys', messages)
      assert.equal(body.model, 'claude-opus-4-7') // dot-to-hyphen rewrite
      assert.equal(body.max_tokens, 1000)
      assert.equal(Array.isArray(body.system), true)
      assert.equal(body.system[0].text, 'sys')
      assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral', ttl: '1h' })
      assert.deepEqual(body.messages, messages)
      assert.equal(body.instructions, undefined)
    })
  })

  it('openai (Responses): instructions + input + max_output_tokens, strips the openai/ prefix', () => {
    withProvider('openai', 'OPENAI_API_KEY', () => {
      const body = buildRequestBody('openai/gpt-5.5', 1000, 'sys', messages)
      assert.equal(body.model, 'gpt-5.5')
      assert.equal(body.max_output_tokens, 1000)
      assert.equal(body.instructions, 'sys')
      assert.deepEqual(body.input, messages)
      assert.equal(body.system, undefined)
      assert.equal(body.messages, undefined)
    })
  })

  // Pro is a mode on astra, not a model of its own, and `reasoning.mode`
  // exists only on Responses — so the two routes ask for it in the two
  // different ways the APIs actually offer.
  it('openai (Responses): astra pro sends the BASE model plus reasoning.mode', () => {
    withProvider('openai', 'OPENAI_API_KEY', () => {
      const body = buildRequestBody('openai/gpt-6-astra-pro', 1000, 'sys', messages, { think: true, effort: 'xhigh' })
      assert.equal(body.model, 'gpt-6-astra')
      // Independent knobs: mode picks the execution path, effort how much
      // reasoning happens within it.
      assert.deepEqual(body.reasoning, { effort: 'xhigh', mode: 'pro' })
      // Still pro with thinking off, rather than silently serving the base
      // model under the pro row's cache dir and price.
      const noThink = buildRequestBody('openai/gpt-6-astra-pro', 1000, 'sys', messages)
      assert.equal(noThink.model, 'gpt-6-astra')
      assert.deepEqual(noThink.reasoning, { mode: 'pro' })
      // Base astra is untouched — no mode, and it names itself.
      const base = buildRequestBody('openai/gpt-6-astra', 1000, 'sys', messages, { think: true, effort: 'xhigh' })
      assert.equal(base.model, 'gpt-6-astra')
      assert.deepEqual(base.reasoning, { effort: 'xhigh' })
    })
  })

  it('openrouter: astra pro goes on the wire as its own slug, no mode field', () => {
    withProvider('openrouter', 'OPENROUTER_API_KEY', () => {
      const body = buildRequestBody('openai/gpt-6-astra-pro', 1000, 'sys', messages, { think: true, effort: 'xhigh' })
      // Chat Completions has no `reasoning.mode` at all, so the slug is the
      // only way to ask for pro on this route.
      assert.equal(body.model, 'openai/gpt-6-astra-pro')
      assert.equal(body.reasoning_effort, 'xhigh')
      assert.equal(body.reasoning, undefined)
    })
  })

  // The Responses default retains every request and response on OpenAI's
  // servers; this tool uploads someone else's source code, so the opt-out is
  // deliberate and worth pinning. Nothing reads that state back — tool results
  // are replayed into the next `input` — so stateless costs us nothing.
  it('openai (Responses): opts out of server-side retention on every route', () => {
    withProvider('openai', 'OPENAI_API_KEY', () => {
      assert.equal(buildRequestBody('openai/gpt-6-astra', 1000, 'sys', messages).store, false)
    })
    // Chat-completions backends have no such field, and must not grow one.
    withProvider('openrouter', 'OPENROUTER_API_KEY', () => {
      assert.equal('store' in buildRequestBody('openai/gpt-6-astra', 1000, 'sys', messages), false)
    })
  })

  it('openrouter: prepends a system message and caps with max_completion_tokens', () => {
    withProvider('openrouter', 'OPENROUTER_API_KEY', () => {
      const body = buildRequestBody('openai/gpt-5.5', 1000, 'sys', messages)
      assert.equal(body.model, 'openai/gpt-5.5') // namespace preserved for OpenRouter
      assert.equal(body.max_completion_tokens, 1000)
      assert.equal(body.max_tokens, undefined) // deprecated in OpenRouter's schema
      assert.equal(body.messages[0].role, 'system')
      assert.deepEqual(body.messages[1], messages[0])
    })
  })

  // The gateway is not asked to translate one provider's cache marker into
  // another's: each route gets the shape its own provider documents, which is
  // what keeps this adapter usable against any OpenAI-compatible gateway.
  it('openrouter: marks a cache breakpoint only on routes whose provider requires one', () => {
    withProvider('openrouter', 'OPENROUTER_API_KEY', () => {
      // Anthropic: explicit breakpoint required, with the extended TTL.
      // OpenRouter normalizes Anthropic onto chat-completions, so the system
      // prompt is still the first message here — unlike a plain gateway.
      const claude = buildRequestBody('anthropic/claude-opus-4.7', 1000, 'sys', messages)
      assert.deepEqual(claude.messages[0].content, [
        { type: 'text', text: 'sys', cache_control: { type: 'ephemeral', ttl: '1h' } },
      ])

      // Qwen: explicit breakpoint required, but the bare ephemeral block —
      // ttl is Anthropic's knob.
      const qwen = buildRequestBody('qwen/qwen3-coder:free', 1000, 'sys', messages)
      assert.deepEqual(qwen.messages[0].content, [
        { type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } },
      ])

      // gpt-5.6: its own dialect. Implicit mode would put the only breakpoint
      // on the latest message, so each file writes an entry ending in its own
      // content and the next file matches none of it; marking the system
      // prompt gives the run one entry every request reads.
      for (const model of ['openai/gpt-5.6-sol', 'openai/gpt-5.6-terra', 'openai/gpt-5.6-luna', 'openai/gpt-5.6']) {
        const body = buildRequestBody(model, 1000, 'sys', messages)
        assert.deepEqual(body.messages[0].content, [
          { type: 'text', text: 'sys', prompt_cache_breakpoint: { mode: 'explicit' } },
        ], model)
      }

      // Everyone else caches automatically upstream: plain string, no marker
      // for a gateway to rewrite. gpt-5.5 and older would 400 on the 5.6 field
      // rather than ignore it, so it must not reach them.
      for (const model of ['openai/gpt-5.5', 'openai/gpt-5.4', 'openai/gpt-5.3-codex', 'google/gemini-3.1-pro-preview', 'moonshotai/kimi-k3', 'x-ai/grok-5']) {
        const body = buildRequestBody(model, 1000, 'sys', messages)
        assert.equal(body.messages[0].content, 'sys', model)
      }
    })
  })

  it('openai (Responses): no breakpoint reaches the request, even on gpt-5.6', () => {
    // Breakpoints attach to content blocks, and Responses carries the system
    // prompt as top-level `instructions` — there is nowhere to hang one. Moving
    // it into `input` to gain a block would change how the model weighs it,
    // which is not a trade worth making for a cache entry. Asserted over the
    // whole serialized body rather than on `instructions` alone: this adapter
    // does not call chatCompletionsSystemMessage today, so a narrower check
    // would still pass if someone wired the marker in here.
    withProvider('openai', 'OPENAI_API_KEY', () => {
      const body = buildRequestBody('openai/gpt-5.6-sol', 1000, 'sys', messages)
      assert.equal(body.instructions, 'sys')
      assert.equal(JSON.stringify(body).includes('prompt_cache_breakpoint'), false)
    })
  })

  it('think + adaptive Anthropic emits {thinking: {type: "adaptive"}, output_config: {effort}}', () => {
    withProvider('anthropic', 'ANTHROPIC_API_KEY', () => {
      const body = buildRequestBody('anthropic/claude-opus-4.7', 1000, 'sys', messages, { think: true, effort: 'high' })
      assert.deepEqual(body.thinking, { type: 'adaptive' })
      assert.deepEqual(body.output_config, { effort: 'high' })
    })
  })

  it('dotless model names pass through unchanged (no dot-to-hyphen rewrite) and use adaptive thinking', () => {
    withProvider('anthropic', 'ANTHROPIC_API_KEY', () => {
      for (const model of ['anthropic/claude-fable-5', 'anthropic/claude-opus-5']) {
        const body = buildRequestBody(model, 1000, 'sys', messages, { think: true })
        assert.equal(body.model, model.slice('anthropic/'.length), model)
        assert.deepEqual(body.thinking, { type: 'adaptive' }, model)
      }
    })
  })

  it('a dotted point release goes on the wire hyphenated — fable 5.1 -> claude-fable-5-1', () => {
    withProvider('anthropic', 'ANTHROPIC_API_KEY', () => {
      const body = buildRequestBody('anthropic/claude-fable-5.1', 1000, 'sys', messages, { think: true, effort: 'xhigh' })
      assert.equal(body.model, 'claude-fable-5-1')
      assert.deepEqual(body.thinking, { type: 'adaptive' })
      assert.deepEqual(body.output_config, { effort: 'xhigh' })
    })
  })

  it('opus 5 + think=false emits an explicit {thinking: {type: "disabled"}} — it thinks by default otherwise', () => {
    withProvider('anthropic', 'ANTHROPIC_API_KEY', () => {
      const body = buildRequestBody('anthropic/claude-opus-5', 1000, 'sys', messages)
      assert.deepEqual(body.thinking, { type: 'disabled' })
      // No effort alongside it — the disabled form 400s at xhigh / max.
      assert.equal(body.output_config, undefined)
    })
  })

  it('think=false omits `thinking` entirely on every other model', () => {
    withProvider('anthropic', 'ANTHROPIC_API_KEY', () => {
      // The first three because an absent field already means "off"; the
      // fable rows for the opposite reason — they think anyway, but reject
      // the disabled form, so omitting is their only legal request.
      for (const model of ['anthropic/claude-opus-4.8', 'anthropic/claude-opus-4.7', 'anthropic/claude-sonnet-4.5', 'anthropic/claude-fable-5', 'anthropic/claude-fable-5.1']) {
        assert.equal(buildRequestBody(model, 1000, 'sys', messages).thinking, undefined, model)
      }
    })
  })

  it('think + non-adaptive Anthropic emits {thinking: {type: "enabled", budget_tokens}}; explicit effort throws', () => {
    withProvider('anthropic', 'ANTHROPIC_API_KEY', () => {
      const body = buildRequestBody('anthropic/claude-sonnet-4.5', 1000, 'sys', messages, { think: true })
      assert.equal(body.thinking.type, 'enabled')
      assert.equal(body.thinking.budget_tokens, 750)
      assert.throws(
        () => buildRequestBody('anthropic/claude-sonnet-4.5', 1000, 'sys', messages, { think: true, effort: 'high' }),
        /effort/u,
      )
    })
  })

  it('think on openai (Responses) emits reasoning.effort, defaulting to high', () => {
    withProvider('openai', 'OPENAI_API_KEY', () => {
      const body = buildRequestBody('openai/gpt-5.5', 1000, 'sys', messages, { think: true })
      assert.deepEqual(body.reasoning, { effort: 'high' })
      const explicit = buildRequestBody('openai/gpt-5.5', 1000, 'sys', messages, { think: true, effort: 'low' })
      assert.deepEqual(explicit.reasoning, { effort: 'low' })
    })
  })

  it('think on openrouter emits the flat reasoning_effort string, defaulting to high', () => {
    withProvider('openrouter', 'OPENROUTER_API_KEY', () => {
      const body = buildRequestBody('openai/gpt-5.5', 1000, 'sys', messages, { think: true })
      assert.equal(body.reasoning_effort, 'high')
      assert.equal(buildRequestBody('openai/gpt-5.5', 1000, 'sys', messages, { think: true, effort: 'low' }).reasoning_effort, 'low')
      // The OpenAI-compatible flat string, not OpenRouter's own `reasoning: { effort }` object.
      assert.equal(body.reasoning, undefined)
    })
  })

  it('think=false on openrouter sends no reasoning field at all', () => {
    withProvider('openrouter', 'OPENROUTER_API_KEY', () => {
      const body = buildRequestBody('openai/gpt-5.5', 1000, 'sys', messages)
      assert.equal(body.reasoning_effort, undefined)
      assert.equal(body.reasoning, undefined)
    })
  })

  it('effort without think throws on every provider', () => {
    for (const [name, env] of [['anthropic', 'ANTHROPIC_API_KEY'], ['openai', 'OPENAI_API_KEY'], ['openrouter', 'OPENROUTER_API_KEY']]) {
      withProvider(name, env, () => {
        assert.throws(
          () => buildRequestBody('anthropic/claude-opus-4.7', 1000, 'sys', messages, { effort: 'high' }),
          /[Tt]hinking not enabled/u,
        )
      })
    }
  })
})

describe('buildInitialUserMessage', () => {
  const CLAUDE = 'anthropic/claude-opus-4.7'
  const GPT = 'openai/gpt-5.5'
  const GPT56 = 'openai/gpt-5.6-sol'

  it('anthropic: nothing to split → role:user with plain string content', () => {
    withProvider('anthropic', 'ANTHROPIC_API_KEY', () => {
      assert.deepEqual(buildInitialUserMessage(CLAUDE, 'hello'), { role: 'user', content: 'hello' })
      assert.deepEqual(buildInitialUserMessage(CLAUDE, ['hello']), { role: 'user', content: 'hello' })
      // An empty block is no boundary — and Anthropic 400s on one.
      assert.deepEqual(buildInitialUserMessage(CLAUDE, ['hello', '']), { role: 'user', content: 'hello' })
      assert.deepEqual(buildInitialUserMessage(CLAUDE, ['', 'hello']), { role: 'user', content: 'hello' })
    })
  })

  it('anthropic: two blocks → the first gets cache_control', () => {
    // Lets isolate-mode share a single cache entry for the prefix
    // across multiple per-export variants.
    withProvider('anthropic', 'ANTHROPIC_API_KEY', () => {
      const out = buildInitialUserMessage(CLAUDE, ['PREFIX', 'SUFFIX'])
      assert.equal(out.role, 'user')
      assert.deepEqual(out.content, [
        { type: 'text', text: 'PREFIX', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'SUFFIX' },
      ])
    })
  })

  it('more than two blocks → ONE marker, immediately before the last', () => {
    // The last block is the part that varies, so the shared part ends on the
    // one before it. Earlier blocks stay separate but unmarked: a second
    // breakpoint would write a second entry for a prefix the first already
    // covers, at a write premium each.
    withProvider('anthropic', 'ANTHROPIC_API_KEY', () => {
      assert.deepEqual(buildInitialUserMessage(CLAUDE, ['A', 'B', 'C']).content, [
        { type: 'text', text: 'A' },
        { type: 'text', text: 'B', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'C' },
      ])
      const four = buildInitialUserMessage(CLAUDE, ['A', 'B', 'C', 'D']).content
      assert.deepEqual(four.map((b) => Boolean(b.cache_control)), [false, false, true, false])
    })
  })

  it('openai (Responses): concats below gpt-5.6, which caches server-side via the input fingerprint', () => {
    withProvider('openai', 'OPENAI_API_KEY', () => {
      assert.deepEqual(buildInitialUserMessage(GPT, 'hello'), { role: 'user', content: 'hello' })
      assert.deepEqual(buildInitialUserMessage(GPT, ['PRE', 'SUF']), { role: 'user', content: 'PRESUF' })
      assert.deepEqual(buildInitialUserMessage(GPT, ['A', 'B', 'C']), { role: 'user', content: 'ABC' })
    })
  })

  it('gpt-5.6: marks the shared prefix, in each route\'s own block naming', () => {
    // 5.6 anchors cache reads to breakpoints rather than the 128-token strides
    // earlier models use, so an unmarked isolate prefix would never be read
    // back. Responses names the block input_text, chat-completions text.
    withProvider('openai', 'OPENAI_API_KEY', () => {
      assert.deepEqual(buildInitialUserMessage(GPT56, ['PRE', 'SUF']).content, [
        { type: 'input_text', text: 'PRE', prompt_cache_breakpoint: { mode: 'explicit' } },
        { type: 'input_text', text: 'SUF' },
      ])
    })
    withProvider('openrouter', 'OPENROUTER_API_KEY', () => {
      assert.deepEqual(buildInitialUserMessage(GPT56, ['PRE', 'SUF']).content, [
        { type: 'text', text: 'PRE', prompt_cache_breakpoint: { mode: 'explicit' } },
        { type: 'text', text: 'SUF' },
      ])
      // The bare alias resolves to a 5.6 row, so it is marked too.
      assert.deepEqual(buildInitialUserMessage('openai/gpt-5.6', ['PRE', 'SUF']).content[0].prompt_cache_breakpoint, { mode: 'explicit' })
    })
  })

  it('splitting never changes what the model reads, on any route', () => {
    // cache.js reverses a stored request back into its cache key by flattening
    // block content (`content.map((b) => b.text).join('')`), so a marked split
    // has to concatenate back to exactly the string the key was hashed over —
    // otherwise a cached entry stops matching the request that produced it.
    const flatten = (content) => (typeof content === 'string' ? content : content.map((b) => b?.text ?? '').join(''))
    const routes = [
      ['anthropic', 'ANTHROPIC_API_KEY', ['anthropic/claude-opus-5']],
      ['openai', 'OPENAI_API_KEY', [GPT56, GPT]],
      ['openrouter', 'OPENROUTER_API_KEY', [GPT56, GPT, 'anthropic/claude-opus-5', 'qwen/qwen3-coder:free', 'moonshotai/kimi-k3']],
      ['moonshot', 'MOONSHOT_API_KEY', ['moonshotai/kimi-k3']],
    ]
    for (const [name, env, models] of routes) {
      withProvider(name, env, () => {
        for (const model of models) {
          assert.equal(flatten(buildInitialUserMessage(model, ['PRE', 'SUF']).content), 'PRESUF', `${name} ${model}`)
          assert.equal(flatten(buildInitialUserMessage(model, ['A', 'B', 'C']).content), 'ABC', `${name} ${model} (three blocks)`)
          assert.equal(flatten(buildInitialUserMessage(model, 'ONLY').content), 'ONLY', `${name} ${model} (one string)`)
        }
      })
    }
  })

  it('never sends the marker to a model that would 400 on it', () => {
    // Every OpenAI model before 5.6 rejects prompt_cache_breakpoint outright
    // rather than ignoring it, so the field must not reach them.
    for (const [name, env] of [['openai', 'OPENAI_API_KEY'], ['openrouter', 'OPENROUTER_API_KEY']]) {
      withProvider(name, env, () => {
        for (const model of [GPT, 'openai/gpt-5.4', 'openai/gpt-5.4-pro', 'openai/gpt-5.3-codex', 'openai/gpt-4o-mini']) {
          assert.deepEqual(buildInitialUserMessage(model, ['PRE', 'SUF']), { role: 'user', content: 'PRESUF' }, `${name} ${model}`)
        }
      })
    }
  })

  it('openrouter: splits for a route that reads the marker, concats for one that does not', () => {
    withProvider('openrouter', 'OPENROUTER_API_KEY', () => {
      // Same split the Anthropic adapter makes, so isolate-mode variants
      // share one cache entry for the prefix on this route too.
      assert.deepEqual(buildInitialUserMessage(CLAUDE, ['PRE', 'SUF']).content, [
        { type: 'text', text: 'PRE', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'SUF' },
      ])
      assert.deepEqual(buildInitialUserMessage('qwen/qwen3-coder:free', ['PRE', 'SUF']).content, [
        { type: 'text', text: 'PRE', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'SUF' },
      ])
      // Routes that cache on their own side gain nothing from an unmarked
      // two-block message, so they keep the concat.
      assert.deepEqual(buildInitialUserMessage(GPT, ['PRE', 'SUF']), { role: 'user', content: 'PRESUF' })
      assert.deepEqual(buildInitialUserMessage('moonshotai/kimi-k3', ['PRE', 'SUF']), { role: 'user', content: 'PRESUF' })
      // One block — nothing to split, on any route.
      assert.deepEqual(buildInitialUserMessage(CLAUDE, 'only'), { role: 'user', content: 'only' })
    })
  })
})

describe('conversation caching — one rule, both ways to reach the model', () => {
  const CLAUDE = 'anthropic/claude-opus-4.7'
  const messages = [{ role: 'user', content: 'hi' }]
  const tools = [{ name: 't' }]
  const body = (provider, env, model, opts) => {
    let out
    withProvider(provider, env, () => { out = buildRequestBody(model, 1000, 'sys', messages, opts) })
    return out
  }
  const direct = (opts) => body('anthropic', 'ANTHROPIC_API_KEY', CLAUDE, opts)
  const gateway = (model, opts) => body('openrouter', 'OPENROUTER_API_KEY', model, opts)

  it('caches the thread once there is one, on both routes', () => {
    for (const opts of [{ turn: 1 }, { turn: 3 }, { turn: 3, tools }]) {
      assert.deepEqual(direct(opts).cache_control, { type: 'ephemeral' }, `direct ${JSON.stringify(opts)}`)
      assert.deepEqual(gateway(CLAUDE, opts).cache_control, { type: 'ephemeral' }, `gateway ${JSON.stringify(opts)}`)
    }
  })

  it('withholds it on the head turn, on both routes, tools declared or not', () => {
    // A turn-0 request has no reader yet and mostly never gets one: only 13.3%
    // of tool-carrying requests measured ever called a tool, against a 27.8%
    // break-even. Declaring a tool is not a second turn.
    for (const opts of [{}, { turn: 0 }, { tools }, { turn: 0, tools }]) {
      assert.equal(direct(opts).cache_control, undefined, `direct ${JSON.stringify(opts)}`)
      assert.equal(gateway(CLAUDE, opts).cache_control, undefined, `gateway ${JSON.stringify(opts)}`)
    }
  })

  it('is the model\'s rule, not the provider\'s — no other route reads the field', () => {
    for (const model of ['openai/gpt-5.5', 'qwen/qwen3-coder:free', 'moonshotai/kimi-k3']) {
      assert.equal(gateway(model, { turn: 3, tools }).cache_control, undefined, model)
    }
  })

  it('leaves the message list untouched — the API advances the breakpoint itself', () => {
    const thread = [{ role: 'user', content: 'hi' }, { role: 'tool', tool_call_id: 't1', content: 'r' }]
    const before = JSON.parse(JSON.stringify(thread))
    direct({ turn: 3, tools })
    gateway(CLAUDE, { turn: 3, tools })
    assert.deepEqual(thread, before)
  })

  it('keeps the two explicit breakpoints the API cannot place for us', () => {
    // The system prompt carries a TTL the request-level field cannot express…
    assert.deepEqual(direct({ turn: 3 }).system[0].cache_control, { type: 'ephemeral', ttl: '1h' })
    assert.deepEqual(gateway(CLAUDE, { turn: 3 }).messages[0].content, [
      { type: 'text', text: 'sys', cache_control: { type: 'ephemeral', ttl: '1h' } },
    ])
    // …and the isolate prefix has to be marked at the end of the SHARED part,
    // which is not where auto-placement would put it. This is the breakpoint
    // a rolling window evicts on turn 2 of a tool loop.
    for (const [provider, env] of [['anthropic', 'ANTHROPIC_API_KEY'], ['openrouter', 'OPENROUTER_API_KEY']]) {
      withProvider(provider, env, () => {
        assert.deepEqual(buildInitialUserMessage(CLAUDE, ['SHARED', 'VARIANT']).content, [
          { type: 'text', text: 'SHARED', cache_control: { type: 'ephemeral' } },
          { type: 'text', text: 'VARIANT' },
        ], provider)
      })
    }
  })
})

describe('task_budget — body shape and headers (anthropic only)', () => {
  const messages = [{ role: 'user', content: 'hi' }]

  it('off by default: no output_config.task_budget and no anthropic-beta header', () => {
    withProvider('anthropic', 'ANTHROPIC_API_KEY', () => {
      const body = buildRequestBody('anthropic/claude-opus-4.7', 1000, 'sys', messages)
      assert.equal(body.output_config, undefined)
      const headers = buildRequestHeaders({})
      assert.equal(headers['anthropic-beta'], undefined)
    })
  })

  it('opus 4.7 + taskBudget: emits output_config.task_budget keyed by maxTokens', () => {
    withProvider('anthropic', 'ANTHROPIC_API_KEY', () => {
      const body = buildRequestBody('anthropic/claude-opus-4.7', 12345, 'sys', messages, { taskBudget: true })
      assert.deepEqual(body.output_config, { task_budget: { type: 'tokens', total: 12345 } })
    })
  })

  it('opus 5 + think=false + taskBudget: task_budget lands without an effort that would reject the disabled form', () => {
    withProvider('anthropic', 'ANTHROPIC_API_KEY', () => {
      const body = buildRequestBody('anthropic/claude-opus-5', 2000, 'sys', messages, { taskBudget: true })
      assert.deepEqual(body.thinking, { type: 'disabled' })
      assert.deepEqual(body.output_config, { task_budget: { type: 'tokens', total: 2000 } })
    })
  })

  it('opus 4.7 + taskBudget + think+effort: merges task_budget alongside the adaptive-thinking effort field', () => {
    withProvider('anthropic', 'ANTHROPIC_API_KEY', () => {
      const body = buildRequestBody('anthropic/claude-opus-4.7', 1000, 'sys', messages, { think: true, effort: 'high', taskBudget: true })
      assert.deepEqual(body.thinking, { type: 'adaptive' })
      assert.deepEqual(body.output_config, { effort: 'high', task_budget: { type: 'tokens', total: 1000 } })
    })
  })

  it('anthropic-beta header is added only when taskBudget is on', () => {
    withProvider('anthropic', 'ANTHROPIC_API_KEY', () => {
      const on = buildRequestHeaders({ taskBudget: true })
      assert.equal(on['anthropic-beta'], 'task-budgets-2026-03-13')
      const off = buildRequestHeaders({ taskBudget: false })
      assert.equal(off['anthropic-beta'], undefined)
    })
  })

  it('taskBudget against a non-opus-4.7 anthropic model throws', () => {
    withProvider('anthropic', 'ANTHROPIC_API_KEY', () => {
      assert.throws(
        () => buildRequestBody('anthropic/claude-sonnet-4.6', 1000, 'sys', messages, { taskBudget: true }),
        /does not support task_budget/u,
      )
    })
  })

  it('the beta header follows the route, not the provider', () => {
    // Headers are built per request now, because a gateway authenticates an
    // Anthropic route the Messages way and everything else the Bearer way.
    withProvider('openai', 'OPENAI_API_KEY', () => {
      assert.equal(buildRequestHeaders({ taskBudget: true, model: 'openai/gpt-5.5' })['anthropic-beta'], undefined)
    })
    // OpenRouter translates Anthropic onto chat-completions, so every route
    // it serves authenticates the same Bearer way and none takes the beta.
    withProvider('openrouter', 'OPENROUTER_API_KEY', () => {
      for (const model of ['openai/gpt-5.5', 'anthropic/claude-opus-5']) {
        const headers = buildRequestHeaders({ taskBudget: true, model })
        assert.equal(headers['anthropic-beta'], undefined, model)
        assert.equal(headers.Authorization, 'Bearer test-key', model)
        assert.equal(headers['x-api-key'], undefined, model)
      }
    })
  })
})

describe('moonshot adapter — Kimi K3 on Moonshot direct', () => {
  const MODEL = 'moonshotai/kimi-k3'
  const messages = [{ role: 'user', content: 'hi' }]

  function withMoonshot(fn) {
    withProvider('moonshot', 'MOONSHOT_API_KEY', fn)
  }

  it('strips the moonshotai/ namespace and caps output via max_completion_tokens', () => {
    withMoonshot(() => {
      const body = buildRequestBody(MODEL, 1000, 'sys', messages, { think: true })
      assert.equal(body.model, 'kimi-k3')
      assert.equal(body.max_completion_tokens, 1000)
      // `max_tokens` is deprecated on Moonshot — sending it too would be
      // two caps for one budget.
      assert.equal(body.max_tokens, undefined)
      assert.equal(body.max_output_tokens, undefined)
    })
  })

  it('sends the system prompt as a plain string message, not a cache_control block array', () => {
    withMoonshot(() => {
      const body = buildRequestBody(MODEL, 1000, 'sys', messages, { think: true })
      assert.deepEqual(body.messages[0], { role: 'system', content: 'sys' })
      assert.deepEqual(body.messages[1], messages[0])
      assert.equal(body.system, undefined)
      assert.equal(body.instructions, undefined)
    })
  })

  it('think emits the flat reasoning_effort string, defaulting to high', () => {
    withMoonshot(() => {
      assert.equal(buildRequestBody(MODEL, 1000, 'sys', messages, { think: true }).reasoning_effort, 'high')
      assert.equal(buildRequestBody(MODEL, 1000, 'sys', messages, { think: true, effort: 'max' }).reasoning_effort, 'max')
      assert.equal(buildRequestBody(MODEL, 1000, 'sys', messages, { think: true, effort: 'low' }).reasoning_effort, 'low')
      // Flat string, not a `reasoning: { effort }` object — same shape OpenRouter sends.
      assert.equal(buildRequestBody(MODEL, 1000, 'sys', messages, { think: true }).reasoning, undefined)
    })
  })

  it('rejects effort levels Moonshot does not accept instead of rounding them', () => {
    withMoonshot(() => {
      for (const effort of ['medium', 'xhigh']) {
        assert.throws(
          () => buildRequestBody(MODEL, 1000, 'sys', messages, { think: true, effort }),
          /is not supported by this model. Use: low, high, max/u,
          effort,
        )
      }
      // 'manual' is Anthropic's fixed-budget marker — rejected by the policy
      // every non-Anthropic adapter shares, so it keeps that wording.
      assert.throws(
        () => buildRequestBody(MODEL, 1000, 'sys', messages, { think: true, effort: 'manual' }),
        /Manual effort unsupported on non-Anthropic providers/u,
      )
    })
  })

  it('think=false omits reasoning_effort entirely — K3 has no off switch to send', () => {
    withMoonshot(() => {
      const body = buildRequestBody(MODEL, 1000, 'sys', messages)
      assert.equal(body.reasoning_effort, undefined)
      assert.equal(body.reasoning, undefined)
      assert.equal(body.thinking, undefined)
    })
  })

  it('effort without think throws, same as every other provider', () => {
    withMoonshot(() => {
      assert.throws(() => buildRequestBody(MODEL, 1000, 'sys', messages, { effort: 'high' }), /Thinking not enabled/u)
    })
  })

  it('tools take the nested chat-completions function shape', () => {
    withMoonshot(() => {
      const tools = [{ name: 'read', description: 'read a file', input_schema: { type: 'object' } }]
      const body = buildRequestBody(MODEL, 1000, 'sys', messages, { think: true, tools })
      assert.deepEqual(body.tools, [{
        type: 'function',
        function: { name: 'read', description: 'read a file', parameters: { type: 'object' } },
      }])
    })
  })

  it('authenticates with a bearer MOONSHOT_API_KEY and adds no anthropic-beta header', () => {
    withMoonshot(() => {
      const headers = buildRequestHeaders({ taskBudget: true })
      assert.equal(headers.Authorization, 'Bearer test-key')
      assert.equal(headers['Content-Type'], 'application/json')
      assert.equal(headers['anthropic-beta'], undefined)
    })
  })

  it('shares the chat-completions response side with openrouter', () => {
    withMoonshot(() => {
      const json = { choices: [{ message: {
        role: 'assistant',
        content: 'text out',
        tool_calls: [{ id: 'c1', function: { name: 'read', arguments: '{"path":"a.js"}' } }],
      } }] }
      assert.equal(extractResponseText(json), 'text out')
      assert.deepEqual(extractToolCalls(json), [{ id: 'c1', name: 'read', args: { path: 'a.js' } }])

      const thread = [...messages]
      appendToolResults(thread, json, extractToolCalls(json), ['result'])
      assert.deepEqual(thread[1], json.choices[0].message)
      assert.deepEqual(thread[2], { role: 'tool', tool_call_id: 'c1', content: 'result' })

      assert.equal(checkResponse(json), null)
      assert.equal(checkResponse({ error: { message: 'boom' } }), 'API error: boom')
    })
  })

  it('names max_completion_tokens on truncation — the field it actually caps output with', () => {
    withMoonshot(() => {
      assert.equal(
        checkResponse({ choices: [{ finish_reason: 'length' }] }),
        'Response truncated: hit max_completion_tokens limit',
      )
    })
    // OpenRouter caps with the same field, so it reports the same wording;
    // task-budget.js gates its retry on the shape, not this exact string.
    withProvider('openrouter', 'OPENROUTER_API_KEY', () => {
      assert.equal(
        checkResponse({ choices: [{ finish_reason: 'length' }] }),
        'Response truncated: hit max_completion_tokens limit',
      )
    })
  })

  it('concats the initial user message and never marks a cache breakpoint', () => {
    withMoonshot(() => {
      assert.deepEqual(buildInitialUserMessage(MODEL, ['prefix', 'suffix']), { role: 'user', content: 'prefixsuffix' })
      const body = buildRequestBody(MODEL, 1000, 'sys', [{ role: 'user', content: 'hi' }], { turn: 3, tools: [{ name: 't' }] })
      assert.equal(body.cache_control, undefined, 'Moonshot caches server-side')
      assert.equal(body.messages[0].content, 'sys')
    })
  })
})

describe('normalizeOneUsage — chat-completions cached tokens', () => {
  it('splits Moonshot cache hits out of prompt_tokens so they price at 0.1x', () => {
    // Moonshot reports no cost, so these tokens get priced from the local
    // table: 800k fresh at $3/Mtok + 200k cached at $0.30/Mtok + 1k output.
    const usage = normalizeOneUsage({ usage: { prompt_tokens: 1_000_000, completion_tokens: 1000, cached_tokens: 200_000 } })
    assert.deepEqual(usage, { input: 800_000, output: 1000, cacheRead: 200_000, cacheWrite5m: 0, cacheWrite1h: 0, cost: 0 })
    // 0.8 Mtok × $3 + 0.2 Mtok × $0.30 + 1k × $15/Mtok = 2.40 + 0.06 + 0.015.
    assert.equal(calculateCost('moonshotai/kimi-k3', usage), 2.475)
  })

  it('reads the OpenAI-compatible prompt_tokens_details spelling too', () => {
    const usage = normalizeOneUsage({ usage: { prompt_tokens: 500, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 100 } } })
    assert.equal(usage.input, 400)
    assert.equal(usage.cacheRead, 100)
  })

  it('reports all input as fresh when no cache hits are reported, and keeps a provider-supplied cost', () => {
    const usage = normalizeOneUsage({ usage: { prompt_tokens: 500, completion_tokens: 10, cost: 0.42 } })
    assert.deepEqual(usage, { input: 500, output: 10, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cost: 0.42 })
  })

  it('caps cache reads at the prompt if a backend reports the two counts as disjoint', () => {
    // Neither field may exceed prompt_tokens, and input must not go negative.
    const usage = normalizeOneUsage({ usage: { prompt_tokens: 100, completion_tokens: 10, cached_tokens: 400 } })
    assert.equal(usage.input, 0)
    assert.equal(usage.cacheRead, 100)
  })
})

describe('normalizeOneUsage — input_tokens providers report cache reads differently', () => {
  it('OpenAI Responses: cached_tokens is a SUBSET of input_tokens, so it is not charged twice', () => {
    // Pre-fix this returned input: 2000 alongside cacheRead: 1920, billing
    // 2000 at full price plus another 1920 at 0.1x. OpenAI supplies no
    // `cost` field, so the inflated number was the one the user saw.
    const usage = normalizeOneUsage({ usage: {
      input_tokens: 2000,
      input_tokens_details: { cached_tokens: 1920 },
      output_tokens: 100,
    } })
    assert.equal(usage.input, 80)
    assert.equal(usage.cacheRead, 1920)
    assert.equal(usage.output, 100)
  })

  it('Anthropic: input_tokens EXCLUDES cache reads, so nothing is subtracted', () => {
    const usage = normalizeOneUsage({ usage: {
      input_tokens: 80,
      cache_read_input_tokens: 1920,
      cache_creation_input_tokens: 300,
      output_tokens: 100,
    } })
    assert.equal(usage.input, 80, 'left whole — the buckets are already disjoint here')
    assert.equal(usage.cacheRead, 1920)
    assert.equal(usage.cacheWrite5m, 300)
  })

  it('a zero Anthropic cache-read count stays zero and never falls through to the OpenAI key', () => {
    const usage = normalizeOneUsage({ usage: { input_tokens: 500, cache_read_input_tokens: 0, output_tokens: 10 } })
    assert.equal(usage.input, 500)
    assert.equal(usage.cacheRead, 0)
  })
})

describe('effort narrowing follows the model, not the provider', () => {
  const messages = [{ role: 'user', content: 'hi' }]

  it('narrows K3 on every route that can reach it, Moonshot direct or gateway', () => {
    for (const [name, env] of [['moonshot', 'MOONSHOT_API_KEY'], ['openrouter', 'OPENROUTER_API_KEY']]) {
      withProvider(name, env, () => {
        assert.throws(
          () => buildRequestBody('moonshotai/kimi-k3', 1000, 'sys', messages, { think: true, effort: 'medium' }),
          /is not supported by this model. Use: low, high, max/u,
          name,
        )
        // The levels it does take still go out.
        const body = buildRequestBody('moonshotai/kimi-k3', 1000, 'sys', messages, { think: true, effort: 'max' })
        assert.equal(body.reasoning_effort, 'max', name)
      })
    }
  })

  it('leaves models that take the CLI\'s full set alone', () => {
    withProvider('openrouter', 'OPENROUTER_API_KEY', () => {
      assert.equal(buildRequestBody('openai/gpt-5.5', 1000, 'sys', messages, { think: true, effort: 'medium' }).reasoning_effort, 'medium')
    })
    withProvider('openai', 'OPENAI_API_KEY', () => {
      assert.deepEqual(buildRequestBody('openai/gpt-5.5', 1000, 'sys', messages, { think: true, effort: 'xhigh' }).reasoning, { effort: 'xhigh' })
    })
  })
})

describe('gateway — Anthropic and OpenAI natively, everything else like openrouter', () => {
  const messages = [{ role: 'user', content: 'hi' }]
  // What is left on chat completions once Anthropic and OpenAI take their own
  // APIs: the namespaces no upstream of ours documents another shape for.
  const CHAT_ROUTES = ['qwen/qwen3-coder:free', 'moonshotai/kimi-k3']
  const CLAUDE = 'anthropic/claude-opus-5'
  const ASTRA = 'openai/gpt-6-astra'

  // OPENROUTER_API_URL is cleared too: the assertions below name openrouter's
  // default origin, and a developer running a gateway may well have it set.
  const withGateway = (fn) => withProvidersEnv(
    { AI_GATEWAY_API_URL: 'https://gw.example', AI_GATEWAY_API_KEY: 'k', OPENROUTER_API_KEY: 'k', OPENROUTER_API_URL: undefined },
    fn,
  )

  it('sends an Anthropic model to /v1/messages, in the Messages format', async () => {
    // Serving anthropic/* over chat-completions is a translation layer, and
    // Cloudflare AI Gateway and LiteLLM both expose Anthropic natively only.
    await withGateway((mod) => {
      mod.setProvider('gateway')
      assert.equal(mod.buildRequestUrl(CLAUDE), 'https://gw.example/v1/messages')

      const body = mod.buildRequestBody(CLAUDE, 1000, 'sys', messages, { turn: 1 })
      assert.deepEqual(body.system, [
        { type: 'text', text: 'sys', cache_control: { type: 'ephemeral', ttl: '1h' } },
      ])
      assert.equal(body.max_tokens, 1000)
      assert.equal(body.max_completion_tokens, undefined)
      assert.deepEqual(body.cache_control, { type: 'ephemeral' })

      // The id stays namespaced: on a gateway it is the routing key the
      // operator configured, not a name the upstream API resolves. The direct
      // adapter is the one that strips it (see toAnthropicModel).
      assert.equal(body.model, CLAUDE)

      // Both auth schemes: a pass-through forwards x-api-key to Anthropic,
      // while LiteLLM/Portkey-style proxies check their own key on Bearer.
      const headers = mod.buildRequestHeaders({ model: CLAUDE })
      assert.equal(headers['x-api-key'], 'k')
      assert.equal(headers['anthropic-version'], '2023-06-01')
      assert.equal(headers.Authorization, 'Bearer k')
    })
  })

  it('carries task_budget and its beta header on the native route only', async () => {
    // This route is the first non-anthropic provider the beta can reach, and
    // the body field and the header have to travel together or the API rejects
    // the request — which is why the beta id lives in one place.
    await withGateway((mod) => {
      mod.setProvider('gateway')
      const body = mod.buildRequestBody(CLAUDE, 1000, 'sys', messages, { taskBudget: true })
      assert.deepEqual(body.output_config.task_budget, { type: 'tokens', total: 1000 })
      assert.equal(mod.buildRequestHeaders({ model: CLAUDE, taskBudget: true })['anthropic-beta'], 'task-budgets-2026-03-13')

      // A chat route never gets either half.
      assert.equal(mod.buildRequestHeaders({ model: 'openai/gpt-5.5', taskBudget: true })['anthropic-beta'], undefined)
    })
  })

  it('never throws when a caller builds headers or a url without a model', async () => {
    // buildRequestHeaders is public and its model is optional; a caller that
    // omits it should fall to the chat route, not crash the run.
    await withGateway((mod) => {
      mod.setProvider('gateway')
      assert.equal(mod.buildRequestHeaders({ taskBudget: true }).Authorization, 'Bearer k')
      assert.equal(mod.buildRequestHeaders().Authorization, 'Bearer k')
      assert.equal(mod.buildRequestUrl(undefined), 'https://gw.example/v1/chat/completions')
    })
  })

  it('stamps the wire route so a partial cannot resume into another shape', async () => {
    // One provider name covers three formats here, so the name alone cannot
    // tell a chat-completions partial apart from a Messages or Responses one.
    await withGateway((mod) => {
      mod.setProvider('gateway')
      assert.equal(mod.providerStamp(CLAUDE), 'gateway:messages')
      assert.equal(mod.providerStamp('openai/gpt-5.5'), 'gateway:responses')
      assert.equal(mod.providerStamp('moonshotai/kimi-k3'), 'gateway:chat')
      // A single-format provider stays its bare name.
      mod.setProvider('openrouter')
      assert.equal(mod.providerStamp(CLAUDE), 'openrouter')
    })
  })

  it('parses a Messages reply on the same provider that parses a chat one', async () => {
    // The two formats are self-identifying, so the response side dispatches on
    // the reply rather than on a model threaded back through it.
    await withGateway((mod) => {
      mod.setProvider('gateway')
      assert.equal(mod.extractResponseText({ content: [{ type: 'text', text: 'from messages' }] }), 'from messages')
      assert.equal(mod.extractResponseText({ choices: [{ message: { content: 'from chat' } }] }), 'from chat')
      assert.deepEqual(mod.extractToolCalls({ content: [{ type: 'tool_use', id: 't1', name: 'fn', input: { a: 1 } }] }),
        [{ id: 't1', name: 'fn', args: { a: 1 } }])
      assert.deepEqual(mod.extractToolCalls({ choices: [{ message: { tool_calls: [{ id: 'c1', function: { name: 'fn', arguments: '{}' } }] } }] }),
        [{ id: 'c1', name: 'fn', args: {} }])
      assert.match(mod.checkResponse({ type: 'error', error: { message: 'nope' } }), /API error.*nope/u)
      assert.match(mod.checkResponse({ error: { message: 'nope' } }), /API error.*nope/u)
    })
  })

  it('is identical to openrouter on every route openrouter does not translate', async () => {
    await withGateway((mod) => {
      const snapshot = (provider) => {
        mod.setProvider(provider)
        return CHAT_ROUTES.map((model) => JSON.stringify([
          mod.buildRequestBody(model, 1000, 'sys', messages, { turn: 1, think: true }),
          mod.buildInitialUserMessage(model, ['PRE', 'SUF']),
          mod.buildRequestUrl(model).replace('https://gw.example', '').replace('https://openrouter.ai/api', ''),
        ]))
      }
      assert.deepEqual(snapshot('gateway'), snapshot('openrouter'))
    })
  })

  // Chat completions caps reasoning_effort below `max` and has no
  // reasoning.mode at all, so routing an openai/ model through it silently
  // costs capabilities the model has.
  it('routes openai natively to /v1/responses, with the effort ladder intact', async () => {
    await withGateway((mod) => {
      mod.setProvider('gateway')
      assert.equal(mod.buildRequestUrl(ASTRA), 'https://gw.example/v1/responses')
      const body = mod.buildRequestBody(ASTRA, 1000, 'sys', messages, { think: true, effort: 'max' })
      // The Responses body, not the chat one.
      assert.equal(body.max_output_tokens, 1000)
      assert.equal(body.instructions, 'sys')
      assert.deepEqual(body.reasoning, { effort: 'max' })
      assert.equal(body.max_completion_tokens, undefined)
      assert.equal(body.reasoning_effort, undefined)
      // The id stays namespaced: on a gateway it is the operator's routing
      // key, exactly as on the Messages route.
      assert.equal(body.model, ASTRA)
      // Stateless on the gateway route too.
      assert.equal(body.store, false)
      // The pro row normalizes to the base model plus the mode. The `-pro`
      // id is OpenRouter's way of asking for a mode on chat completions,
      // which has no field for one; Responses does, so sending the slug here
      // would name a model this API has never heard of.
      const pro = mod.buildRequestBody('openai/gpt-6-astra-pro', 1000, 'sys', messages, { think: true, effort: 'max' })
      assert.equal(pro.model, ASTRA)
      assert.deepEqual(pro.reasoning, { effort: 'max', mode: 'pro' })
    })
  })

  it('parses a Responses reply alongside the other two shapes', async () => {
    await withGateway((mod) => {
      mod.setProvider('gateway')
      const reply = { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'from responses' }] }] }
      assert.equal(mod.extractResponseText(reply), 'from responses')
      assert.deepEqual(mod.extractToolCalls({ output: [{ type: 'function_call', call_id: 'c1', name: 'fn', arguments: '{}' }] }),
        [{ id: 'c1', name: 'fn', args: {} }])
      assert.match(mod.checkResponse({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }), /truncated.*max_output_tokens/u)
      // A chat reply still parses as chat — the shapes are self-identifying.
      assert.equal(mod.extractResponseText({ choices: [{ message: { content: 'from chat' } }] }), 'from chat')
    })
  })

  it('leaves openrouter translating Anthropic, which has no /v1/messages', async () => {
    // OpenRouter normalizes every model onto chat-completions and exposes no
    // Messages endpoint, so routing natively there would 404 every request.
    await withGateway((mod) => {
      mod.setProvider('openrouter')
      assert.equal(mod.buildRequestUrl(CLAUDE), 'https://openrouter.ai/api/v1/chat/completions')
      const body = mod.buildRequestBody(CLAUDE, 1000, 'sys', messages, { turn: 1 })
      assert.equal(body.max_completion_tokens, 1000)
      assert.equal(body.system, undefined)
      assert.equal(mod.buildRequestHeaders({ model: CLAUDE }).Authorization, 'Bearer k')
    })
  })
})

describe('ollama adapter — local builds, addressed by tag', () => {
  const MODEL = 'google/gemma-4-31b-it'
  const messages = [{ role: 'user', content: 'hi' }]

  // Unlike every other adapter, this one must select with NO key: a local
  // server has no auth, so a helper that supplies a dummy one would test the
  // opposite of the case that matters.
  function withOllama(fn) {
    const previous = process.env.OLLAMA_API_KEY
    delete process.env.OLLAMA_API_KEY
    try {
      setProvider('ollama')
      fn()
    } finally {
      if (previous !== undefined) process.env.OLLAMA_API_KEY = previous
    }
  }

  it('selects with no key, and sends no Authorization header', () => {
    withOllama(() => {
      const headers = buildRequestHeaders({ model: 'google/gemma-4-26b-a4b-it' })
      assert.equal(headers.Authorization, undefined)
      assert.equal(headers['Content-Type'], 'application/json')
    })
  })

  it('puts the local tag on the wire, not the registry id', () => {
    withOllama(() => {
      // The whole point of the mapping: the id names the model, the tag names
      // the build, and only the server needs the second.
      assert.equal(buildRequestBody('google/gemma-4-26b-a4b-it', 1000, 'sys', messages).model, 'gemma4:26b-a4b-it-bf16')
      assert.equal(buildRequestBody('google/gemma-4-26b-a4b-it-mtp-q4_k_m', 1000, 'sys', messages).model, 'gemma4:26b-a4b-it-mtp-q4_K_M')
      assert.equal(buildRequestBody('google/gemma-4-31b-it', 1000, 'sys', messages).model, 'gemma4:31b-it-bf16')
    })
  })

  it('keeps the rest of the chat-completions body it shares with openrouter', () => {
    withOllama(() => {
      const body = buildRequestBody('google/gemma-4-31b-it', 1000, 'sys', messages, { think: true })
      assert.equal(body.max_completion_tokens, 1000)
      assert.deepEqual(body.messages[0], { role: 'system', content: 'sys' })
      assert.deepEqual(body.messages[1], messages[0])
      assert.equal(body.reasoning_effort, 'high')
    })
  })

  it('sends a plain system message for a qwen row, which reads no breakpoint here', () => {
    withOllama(() => {
      // readsExplicitBreakpoint keys on the `qwen/` namespace, which the local
      // builds share with the hosted rows — so the shared chat-completions
      // shape would post Anthropic's cache_control blocks to a server that has
      // no prompt cache and does not know the dialect.
      const body = buildRequestBody('qwen/qwen3.6-27b-q4_k_m', 1000, 'sys', messages)
      assert.deepEqual(body.messages[0], { role: 'system', content: 'sys' })
      assert.equal(JSON.stringify(body).includes('cache_control'), false, JSON.stringify(body))
    })
  })

  it('refuses a model it has no local build for, naming the ones it has', () => {
    withOllama(() => {
      // Rather than posting a registry id no Ollama server has ever heard of
      // and reporting whatever 404 comes back.
      assert.throws(
        () => buildRequestBody('anthropic/claude-opus-5', 1000, 'sys', messages),
        /no local build for anthropic\/claude-opus-5\. Use one of: .*google\/gemma-4-12b-it/u,
      )
    })
  })

  it('charges nothing, including for the rows that are sold hosted', () => {
    withOllama(() => {
      const million = { ...emptyUsage(), input: 1_000_000, output: 1_000_000 }
      // The weights never left the machine, so the hosted rate on this row is
      // the wrong answer however the table prices it.
      assert.ok(calculateCost('google/gemma-4-26b-a4b-it', million) > 0)
      assert.equal(turnCost('google/gemma-4-26b-a4b-it', million), 0)
      // And an unpriced local build reads as nothing rather than unknown.
      assert.equal(calculateCost('google/gemma-4-31b-it-q8_0', million), null)
      assert.equal(turnCost('google/gemma-4-31b-it-q8_0', million), 0)
    })
  })

  it('leaves a hosted provider priced by the table', () => {
    withProvider('openrouter', 'OPENROUTER_API_KEY', () => {
      const million = { ...emptyUsage(), input: 1_000_000, output: 1_000_000 }
      assert.equal(turnCost('google/gemma-4-26b-a4b-it', million), calculateCost('google/gemma-4-26b-a4b-it', million))
      // Unknown stays unknown off a local provider — not silently free.
      assert.equal(turnCost('google/gemma-4-31b-it-q8_0', million), null)
    })
  })

  it('defaults to a local server, and follows OLLAMA_API_URL elsewhere', () => {
    withOllama(() => {
      assert.equal(buildRequestUrl(MODEL), 'http://127.0.0.1:11434/v1/chat/completions')
    })
  })

  it('resolves that URL per request, so the turn and the tag probe agree', () => {
    // The other adapters read their origin once, at module load. This one
    // cannot: src/ollama.js reads OLLAMA_API_URL when it probes, so a URL
    // frozen at import would have the probe asking one server what it has
    // and the turn posting the answer to another.
    withOllama(() => {
      const previous = process.env.OLLAMA_API_URL
      process.env.OLLAMA_API_URL = 'http://box.local:11434'
      try {
        assert.equal(buildRequestUrl(MODEL), 'http://box.local:11434/v1/chat/completions')
      } finally {
        if (previous === undefined) delete process.env.OLLAMA_API_URL
        else process.env.OLLAMA_API_URL = previous
      }
    })
  })

  it('sends a Bearer only when one is configured, for an Ollama behind a proxy', async () => {
    const headers = await withProvidersEnv({ OLLAMA_API_KEY: 'proxy-token' }, (mod) => {
      mod.setProvider('ollama')
      return mod.buildRequestHeaders({ model: 'google/gemma-4-31b-it' })
    })
    assert.equal(headers.Authorization, 'Bearer proxy-token')
  })
})

describe('base URL overrides — pointing an adapter at a gateway', () => {
  const urlFor = (provider, env) => withProvidersEnv(env, (mod) => {
    mod.setProvider(provider)
    return mod.getProvider().url
  })

  it('gateway: takes its origin from AI_GATEWAY_API_URL', async () => {
    assert.equal(
      await urlFor('gateway', { AI_GATEWAY_API_KEY: 'k', AI_GATEWAY_API_URL: 'http://localhost:4000' }),
      'http://localhost:4000/v1/chat/completions',
    )
  })

  it('gateway: refuses by name when no origin is configured', async () => {
    // It has no default to fall back on, so an unset origin must fail at
    // setProvider rather than posting to "undefined/v1/chat/completions".
    await assert.rejects(
      () => urlFor('gateway', { AI_GATEWAY_API_KEY: 'k', AI_GATEWAY_API_URL: undefined }),
      /Missing API URL for gateway. Set AI_GATEWAY_API_URL./u,
    )
  })

  it('defaults to each provider\'s own endpoint when unset', async () => {
    assert.equal(
      await urlFor('openai', { OPENAI_API_KEY: 'k', OPENAI_API_URL: undefined }),
      'https://api.openai.com/v1/responses',
    )
    assert.equal(
      await urlFor('openrouter', { OPENROUTER_API_KEY: 'k', OPENROUTER_API_URL: undefined }),
      'https://openrouter.ai/api/v1/chat/completions',
    )
  })

  it('replaces the origin, keeping the endpoint path the adapter needs', async () => {
    // Both variables hold everything before `/v1`, so one gateway origin
    // serves both adapters.
    assert.equal(
      await urlFor('openai', { OPENAI_API_KEY: 'k', OPENAI_API_URL: 'http://localhost:4000' }),
      'http://localhost:4000/v1/responses',
    )
    assert.equal(
      await urlFor('openrouter', { OPENROUTER_API_KEY: 'k', OPENROUTER_API_URL: 'http://localhost:4000' }),
      'http://localhost:4000/v1/chat/completions',
    )
  })

  it('leaves the providers that have no override hardcoded', async () => {
    assert.equal(await urlFor('anthropic', { ANTHROPIC_API_KEY: 'k' }), 'https://api.anthropic.com/v1/messages')
    assert.equal(await urlFor('moonshot', { MOONSHOT_API_KEY: 'k' }), 'https://api.moonshot.ai/v1/chat/completions')
  })
})
