import { modelVersionFor } from '../models.js'
import { chatCompletionsBase } from '../wire-formats.js'

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
// Chrome warns on any request that does not name one, and it warns per
// SESSION — so the readiness probe in index.js needs it as much as a turn
// does, which is why the warning survived being added to the turn alone.
// Accepts de, en, es, fr, ja.
export const outputLanguage = () => process.env.CHROME_OUTPUT_LANGUAGE || 'en'

export function toolConstraint(tools) {
  return {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'A reply to the user, when no tool is needed.' },
      tool_calls: {
        type: 'array',
        // One branch per tool, each binding a name to THAT tool's argument
        // schema. A single shared `arguments: { type: 'object' }` accepted
        // anything: chat() hands tool calls straight to the caller's handler
        // without revalidating, so missing or mistyped fields reached real
        // tools. Every other adapter sends the schema with the tool; this is
        // how the constraint carries the same guarantee.
        items: {
          anyOf: tools.map((tool) => ({
            type: 'object',
            properties: {
              name: { type: 'string', enum: [tool.name] },
              arguments: tool.input_schema ?? { type: 'object' },
            },
            required: ['name', 'arguments'],
          })),
        },
      },
    },
    // Both, always. With neither required, `{}` satisfied the constraint and
    // became a successful turn carrying no text and no calls — a silent
    // dead end rather than an answer. The prompt already asks for an empty
    // string or an empty array on the branch not taken.
    required: ['text', 'tool_calls'],
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
  // The response side is the shared chat-completions one, which is the whole
  // point of toChatCompletions emitting that envelope: checkResponse,
  // extractResponseText and extractToolCalls are the same parsing every
  // hosted chat-completions adapter uses, and were duplicated here until it
  // moved somewhere both could import. The truncation branch it carries never
  // fires — the Prompt API accepts no output cap, so nothing this file emits
  // has finish_reason 'length' — and `maxTokens` names the registry field a
  // caller would have to change if one ever did.
  ...chatCompletionsBase('maxTokens'),

  buildRequestBody(model, maxTokens, systemPrompt, messages, { think = false, effort, tools } = {}) {
    if (think || effort) throw new Error('Chrome\'s on-device model has no thinking mode')
    const system = tools ? `${systemPrompt}\n\n${toolInstructions(tools)}` : systemPrompt
    // The last message is the turn being asked, everything before it is
    // history. No output cap goes out — the Prompt API has no equivalent of
    // max_tokens — so `maxTokens` is deliberately unused.
    return {
      model,
      // Part of the request rather than a launch setting: it changes what the
      // model produces, so a cached turn should record which language it was
      // asked for.
      language: outputLanguage(),
      initialPrompts: [{ role: 'system', content: system }, ...messages.slice(0, -1)],
      prompt: messages.at(-1).content,
      ...(tools ? { responseConstraint: toolConstraint(tools) } : null),
    }
  },

  appendToolResults(messages, json, toolCalls, results) {
    // The assistant's turn goes back as the JSON it produced, so the model
    // sees the calls it made rather than an empty turn — and the text it said
    // alongside them, which the constraint requires and a turn carrying both
    // prose and calls would otherwise lose on the way to the next one.
    const calls = toolCalls.map((tc) => ({ name: tc.name, arguments: tc.args }))
    const text = json?.choices?.[0]?.message?.content ?? ''
    messages.push({ role: 'assistant', content: JSON.stringify({ text, tool_calls: calls }) })
    const rendered = toolCalls.map((tc, i) => `${tc.name} -> ${results[i]}`).join('\n\n')
    messages.push({ role: 'user', content: `Tool results:\n${rendered}` })
  },
}


// A create() that fails after the model warmed up is a variant this machine
// will not run: the weights are linked and the browser is willing, but the
// size the row asks for is more than it can load. Chrome says only "The
// device is unable to create a session to run the model. Please check the
// result of availability() first", which names neither the row nor the
// variant — and following that advice is its own surprise, because on the
// 12B failure that prompted this, availability() answered `available`.
export function explainCreateFailure(error, model, baseModel) {
  // That failure and no other. Every create() failure comes back carrying an
  // availability reading — it is read in the catch, not by the caller — so
  // gating on one rewrote an oversized history, or a language Chrome will not
  // emit, as a model too large for the machine, and told the caller nothing
  // was missing when something was.
  if (error.name !== 'InvalidStateError') return
  const version = modelVersionFor(baseModel)
  const useCase = version && version !== 'v3' ? ` (model_version/${version})` : ''
  // Whether the advice Chrome gives actually explains anything.
  const verdict = error.availability === 'available'
    ? 'availability() reports "available", so the check Chrome suggests does not explain this: ' +
      'the variant is advertised as usable and then refuses to start, which is what a size too ' +
      'large for this device looks like'
    : `availability() reports "${error.availability}", so this device will not run the variant`
  error.message =
    `${model} could not start a session${useCase}. ` +
    `Chrome said: ${error.message.replace(/\.$/u, '')}. ` +
    `${verdict}. The weights are linked and nothing is missing — read Broker State > Use Cases ` +
    'in chrome://on-device-internals for the reason, or use a smaller row.'
}
