import { parseArgs } from './wire-formats.js'

// The `chrome` provider's wire format: what goes to the browser, and what
// comes back. Kept apart from chrome.js for the same reason wire-formats.js
// is kept apart from providers.js — that file is the transport, this one is
// the shape, and neither needs to know how the other works.
//
// The shape is chat-completions, which is not cosmetic: normalizeOneUsage
// already reads `prompt_tokens` / `completion_tokens`, the cache stores it
// like any other turn, and a partial history written here reads back like one
// from any other provider.

// The tool protocol. Chrome's Prompt API documents no function calling — the
// `AIPromptAPIToolUse` flag exists unreleased in Chrome dev, and its shape
// executes the tool inside the page, which cannot produce the caller-run
// calls chat() is built around. So tools ride `responseConstraint`
// (AIPromptAPIStructuredOutput), which IS documented: the model is held to a
// JSON object carrying either prose or a list of calls.
export function toolConstraint(tools) {
  return {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'A reply to the user, when no tool is needed.' },
      tool_calls: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', enum: tools.map((tool) => tool.name) },
            arguments: { type: 'object', description: 'Arguments matching that tool\'s input schema.' },
          },
          required: ['name', 'arguments'],
        },
      },
    },
  }
}

// A constraint says what shape to answer in, never what the tools do, so the
// schemas go in the system prompt where the model can read them.
export function toolInstructions(tools) {
  return [
    'You can call tools. Answer with a JSON object.',
    'To call tools, set "tool_calls" to the calls you want made; their results come back in the next message.',
    'To answer instead, set "text" and leave "tool_calls" empty.',
    '',
    'Tools:',
    ...tools.map((tool) => `- ${tool.name}: ${tool.description}\n  input schema: ${JSON.stringify(tool.input_schema)}`),
  ].join('\n')
}

function parseConstrained(raw) {
  let parsed
  try { parsed = JSON.parse(raw) } catch (err) {
    return { error: `Model returned malformed JSON under responseConstraint (${err.message})` }
  }
  const calls = (parsed.tool_calls ?? []).map((call, i) => ({
    // Positional and deterministic: an id is only matched back up within one
    // turn, and a random one would change the cached response for an
    // otherwise identical request.
    id: `call_${i}`,
    type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
  }))
  return { calls, text: parsed.text ?? '' }
}

// Reshape the page's result as a chat-completions response. Reusing that
// envelope is not cosmetic: normalizeOneUsage already reads `prompt_tokens` /
// `completion_tokens`, the cache stores it like any other turn, and a partial
// history written here reads back like one from any other provider.
export function toChatCompletions(result, constrained) {
  if (result.error) return { error: result.error }
  const message = { role: 'assistant', content: result.text ?? '' }
  let finishReason = 'stop'
  if (constrained) {
    const { calls, text, error } = parseConstrained(result.text)
    if (error) return { error: { message: error } }
    message.content = text
    if (calls.length > 0) {
      message.tool_calls = calls
      finishReason = 'tool_calls'
    }
  }
  return {
    choices: [{ message, finish_reason: finishReason }],
    // Chrome reports neither a price nor an output-token count. This is its
    // own tokenizer's view of the context, and the registry prices these rows
    // at zero because the compute was paid for when the machine was bought.
    usage: result.usage,
    chrome: { contextWindow: result.contextWindow, createMs: result.createMs, promptMs: result.promptMs },
  }
}

// The wire format. Messages are `{ role, content }` with string content:
// Chrome's `initialPrompts` takes system / user / assistant and nothing else,
// which is why appendToolResults folds results into a user turn rather than
// using the `tool` role a chat-completions backend would take.
export const CHROME_SHAPE = {
  buildRequestBody(model, maxTokens, systemPrompt, messages, { think = false, effort, tools } = {}) {
    if (think || effort) throw new Error('Chrome\'s on-device model has no thinking mode')
    const system = tools ? `${systemPrompt}\n\n${toolInstructions(tools)}` : systemPrompt
    // The last message is the turn being asked, everything before it is
    // history. No output cap goes out — the Prompt API has no equivalent of
    // max_tokens — so `maxTokens` is deliberately unused.
    return {
      model,
      initialPrompts: [{ role: 'system', content: system }, ...messages.slice(0, -1)],
      prompt: messages.at(-1).content,
      ...(tools ? { responseConstraint: toolConstraint(tools) } : null),
    }
  },

  // Nothing to mark up: the model is local and holds no cross-request cache,
  // so a prefix/suffix split buys nothing and the two simply concatenate.
  buildInitialUserMessage(model, userContent, userContentSuffix) {
    return { role: 'user', content: userContent + (userContentSuffix ?? '') }
  },

  checkResponse(json) {
    if (json.error) return `API error: ${json.error.message ?? 'unknown'}`
    return null
  },

  extractResponseText(json) {
    return json.choices?.[0]?.message?.content ?? ''
  },

  extractToolCalls(json) {
    const calls = json.choices?.[0]?.message?.tool_calls ?? []
    return calls.map((c) => ({ id: c.id, name: c.function.name, ...parseArgs(c.function.arguments, c.function.name) }))
  },

  appendToolResults(messages, json, toolCalls, results) {
    // The assistant's turn goes back as the JSON it produced, so the model
    // sees the calls it made rather than an empty turn.
    const calls = toolCalls.map((tc) => ({ name: tc.name, arguments: tc.args }))
    messages.push({ role: 'assistant', content: JSON.stringify({ tool_calls: calls }) })
    const rendered = toolCalls.map((tc, i) => `${tc.name} -> ${results[i]}`).join('\n\n')
    messages.push({ role: 'user', content: `Tool results:\n${rendered}` })
  },
}
