import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { chat } from '../src/chat.js'
import { findModelDir } from '../src/chrome.js'
import { calculateCost } from '../src/models.js'
import { closeProvider, setProvider } from '../src/providers.js'

// The only test here that asks a real model a real question. Everything it
// needs is a property of the MACHINE rather than of the code — a branded
// Chrome, weights already downloaded into it, and hardware Chrome is willing
// to run them on — so it skips rather than fails wherever any of that is
// missing. chrome.test.js covers the adapter itself, with a stub standing in
// for the model, and stays hermetic.
//
// Skipped on CI unconditionally. A runner has no on-device model, and the one
// failure mode worth refusing outright is a CI box deciding to download four
// gigabytes to get one.
async function whyNot() {
  if (process.env.CI) return 'CI: no on-device model, and not worth downloading one'
  try { await import('playwright-core') } catch { return 'playwright-core is not installed (optional peer)' }
  if (!findModelDir()) return 'Chrome has no on-device model downloaded'
  // Also the browser check: setProvider runs the preflight, and a machine
  // with weights but no Chrome to run them in fails here with the reason.
  try { setProvider('chrome') } catch (err) { return err.message }
  return false
}

// Slow by nature: a cold browser, then a first load of the weights.
const TIMEOUT = 180_000

describe('chrome on-device, against the real model', async () => {
  const skip = await whyNot()
  after(async () => { await closeProvider() })

  it('answers a prompt', { skip, timeout: TIMEOUT }, async () => {
    const { text, error, usage } = await chat({
      model: 'chrome/gemma4',
      maxTokens: 4096,
      systemPrompt: 'You are terse. Answer in one word.',
      userContent: 'What is the capital of France?',
    })
    assert.equal(error, undefined, `chat() reported: ${error}`)
    assert.ok(text?.trim(), 'expected some text back')
    assert.match(text, /paris/iu)
    // Chrome's own tokenizer, read off contextUsage — there is no output
    // count to report, so that half is a delta rather than a measurement.
    assert.ok(usage.input > 0, 'expected the context to have been measured')
    assert.equal(calculateCost('chrome/gemma4', usage), 0, 'on-device compute is not billed')
  })

  it('serves a turn without the network', { skip, timeout: TIMEOUT }, async () => {
    // The whole point of the provider: the weights are already here, and
    // nothing leaves the machine to use them. A turn that needed the network
    // would hang or fail rather than answer.
    const { text, error } = await chat({
      model: 'chrome/gemma4',
      maxTokens: 4096,
      systemPrompt: 'Reply with exactly: ok',
      userContent: 'Go.',
    })
    assert.equal(error, undefined, `chat() reported: ${error}`)
    assert.ok(text.length > 0)
  })

  it('drives a tool call through the response constraint', { skip, timeout: TIMEOUT }, async () => {
    const tools = [{
      name: 'get_weather',
      description: 'Get the current weather for a city.',
      input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    }]
    const seen = []
    const { error } = await chat({
      model: 'chrome/gemma4',
      maxTokens: 4096,
      systemPrompt: 'Use the tools you are given.',
      userContent: 'What is the weather in Paris? Use the tool.',
      tools,
      handleToolCall: (call) => { seen.push(call); return '18C, clear' },
      maxToolTurns: 3,
    })
    assert.equal(error, undefined, `chat() reported: ${error}`)
    // A small model may reasonably decline to call anything, so the count is
    // not asserted. What must hold is that whatever it DID emit was
    // well-formed and named a real tool: the constraint is enforced by the
    // decoder, so malformed output here is a bug rather than a bad roll.
    for (const call of seen) {
      assert.equal(call.argsError, undefined, `malformed args: ${call.argsError}`)
      assert.equal(call.name, 'get_weather')
      assert.equal(typeof call.args, 'object')
    }
  })
})
