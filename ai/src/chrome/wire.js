import { env } from '#env'
import { modelVersionFor } from '../models.js'
import { chatCompletionsBase } from '../wire-formats.js'

// What goes to the browser and what comes back — index.js is the transport, this is the shape.
// Chat-completions, so the usage, the cache and a partial history read back like any other
// provider's.

// Chrome warns per SESSION on a request that names no output language. Accepts de, en, es, fr, ja.
export const outputLanguage = () => env('CHROME_OUTPUT_LANGUAGE') || 'en'

// Chrome's Prompt API documents no function calling, and unreleased `AIPromptAPIToolUse` runs the
// tool inside the page rather than in the caller. So tools ride `responseConstraint`: prose, a list
// of calls, or both.

export function toolConstraint(tools) {
  return {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'A reply to the user, when no tool is needed.' },
      tool_calls: {
        type: 'array',
        // One branch per tool, each binding a name to THAT tool's schema: ask() hands calls
        // straight to the caller's handler, so a shared `arguments: { type: 'object' }` reaches
        // real tools unchecked.
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
    // Both, always: with neither required, `{}` satisfies the constraint and becomes a turn
    // carrying no text and no calls.
    required: ['text', 'tool_calls'],
  }
}

// A constraint says what shape to answer in, never what the tools do, so the schemas go in the
// system prompt where the model can read them.
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
    // Positional and deterministic: ids are only matched up within one turn, and a random one would
    // change the cache key of an identical request.
    id: `call_${i}`,
    type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
  }))
  return { calls, text: parsed.text ?? '' }
}

// Reshape the page's result as a chat-completions response.
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
    // Chrome's own tokenizer's view of the context; it reports neither a price nor an output-token
    // count.
    usage: result.usage,
    chrome: { contextWindow: result.contextWindow, createMs: result.createMs, promptMs: result.promptMs },
  }
}

// Messages are `{ role, content }` with string content: Chrome's `initialPrompts` takes system /
// user / assistant and nothing else, which is why appendToolResults folds results into a user turn
// rather than using the `tool` role a chat-completions backend would take.
export const CHROME_SHAPE = {
  // The shared chat-completions parsing, which is why toChatCompletions emits that envelope. Its
  // truncation branch never fires — no output cap exists to hit — and `maxTokens` names the field a
  // caller would change if one did.
  ...chatCompletionsBase('maxTokens'),

  buildRequestBody(model, maxTokens, systemPrompt, messages, { think = false, effort, tools } = {}) {
    if (think || effort) throw new Error('Chrome\'s on-device model has no thinking mode')
    // An empty array is not a tool call waiting to happen: it would put an `anyOf: []` on the
    // constraint, which nothing can satisfy, and turn a request that wanted no tools into a
    // refusal.
    const offered = tools?.length ? tools : undefined
    const system = offered ? `${systemPrompt}\n\n${toolInstructions(offered)}` : systemPrompt
    // The last message is the turn being asked, everything before it is history. `maxTokens` is
    // unused: the Prompt API has no output cap.
    return {
      model,
      // Part of the request rather than a launch setting: it changes what the model produces, so a
      // cached turn records which language it asked for.
      language: outputLanguage(),
      initialPrompts: [{ role: 'system', content: system }, ...messages.slice(0, -1)],
      prompt: messages.at(-1).content,
      ...(offered ? { responseConstraint: toolConstraint(offered) } : null),
    }
  },

  appendToolResults(messages, json, toolCalls, results) {
    // The assistant's turn goes back as the JSON it produced: the calls it made, and the prose it
    // said alongside them, which the constraint allows together and the next turn would otherwise
    // never see.
    const calls = toolCalls.map((tc) => ({ name: tc.name, arguments: tc.args }))
    const text = json?.choices?.[0]?.message?.content ?? ''
    messages.push({ role: 'assistant', content: JSON.stringify({ text, tool_calls: calls }) })
    const rendered = toolCalls.map((tc, i) => `${tc.name} -> ${results[i]}`).join('\n\n')
    messages.push({ role: 'user', content: `Tool results:\n${rendered}` })
  },
}


// Chrome says only "The device is unable to create a session to run the model. Please check the
// result of availability() first" — neither the row nor the variant, and a check the page has
// already made.
export function explainCreateFailure(error, model, baseModel) {
  // That failure and no other: every create() failure carries an availability reading, so gating on
  // one would rewrite an oversized history as a model too large for the machine.
  if (error.name !== 'InvalidStateError') return
  const version = modelVersionFor(baseModel)
  const useCase = version && version !== 'v3' ? ` (model_version/${version})` : ''
  // Raised both for a session Chrome declines and for a service that dies starting one; only the
  // second leaves a "Session crashed" behind.
  const verdict = error.availability === 'available'
    ? 'availability() reports "available", so nothing is missing — what failed is running the ' +
      'weights, which is what a model too large for this device looks like'
    : `availability() reports "${error.availability}", so this device will not run the variant`
  error.message =
    `${model} could not start a session${useCase}. ` +
    `Chrome said: ${error.message.replace(/\.$/u, '')}. ` +
    `${verdict}. The event log in chrome://on-device-internals names the reason ` +
    '(CHROME_HEADLESS=0 to reach it), or use a smaller row.'
}
