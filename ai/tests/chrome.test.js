import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { chromePreflight, findModelDir, isScratchProfile, localStateFor, removeProfileDir, turnInPage, waitUntilReady } from '../src/chrome.js'
import { identifiesAs } from '../src/chrome-model.js'
import { CHROME_SHAPE, toChatCompletions, toolConstraint, toolInstructions } from '../src/chrome-wire.js'
import { baseModelFor, calculateCost, getMaxTokens, modelVersionFor, specNamesFor } from '../src/models.js'
import { setProvider } from '../src/providers.js'

// The chrome provider, minus the model. Everything the adapter decides —
// what goes to the browser, what comes back, what that costs — is settled in
// plain JS and tested here; the one thing that genuinely needs Chrome (that a
// page can be driven at all) gets a real browser at the bottom, with a stub
// where the model would be, so the suite stays hermetic and fast.

const TOOLS = [
  { name: 'read_file', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'list_dir', description: 'List a directory', input_schema: { type: 'object', properties: {} } },
]

// A model dir that exists, so preflight passes without a 4 GB download.
function fakeModelDir() {
  const dir = mkdtempSync(join(tmpdir(), 'ai-chrome-test-'))
  writeFileSync(join(dir, 'weights.bin'), '')
  return dir
}

describe('chrome registry rows', () => {
  it('cost nothing — the compute was already paid for', () => {
    for (const model of ['chrome/nano_v3', 'chrome/gemma4_2b', 'chrome/gemma4_4b']) {
      const usage = { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite5m: 0, cacheWrite1h: 0 }
      assert.equal(calculateCost(model, usage), 0, model)
    }
  })

  it('name the base model spec the row expects Chrome to hold', () => {
    assert.equal(baseModelFor('chrome/nano_v3'), 'nano_v3')
    assert.equal(baseModelFor('chrome/gemma4_2b'), 'gemma4_2b')
    assert.equal(baseModelFor('chrome/gemma4_4b'), 'gemma4_4b')
    // Undefined is what tells the adapter a row is not one of Chrome's.
    assert.equal(baseModelFor('anthropic/claude-opus-5'), undefined)
  })

  it('are recognised rows, so getMaxTokens does not fall back', () => {
    assert.equal(getMaxTokens('chrome/nano_v3'), 4096)
  })
})

describe('chrome foundational model version', () => {
  it('asks for v4 on the gemma rows and v3 on nano', () => {
    // This — not the weights directory — is what actually switches which
    // model answers. Pointing the execution override at a gemma directory
    // changed nothing at all; Chrome selects by
    // AIApiFoundationalModel:model_version, set through the
    // gemma4-for-built-in-ai flag.
    assert.equal(modelVersionFor(baseModelFor('chrome/nano_v3')), 'v3')
    assert.equal(modelVersionFor(baseModelFor('chrome/gemma4_2b')), 'v4')
    assert.equal(modelVersionFor(baseModelFor('chrome/gemma4_4b')), 'v4')
  })

  it('asks for Gemma 4 through the flag, and only on the gemma rows', () => {
    // The pref Chrome reads is browser.enabled_labs_experiments, and the one
    // thing it will not do is complain: at the top level, or misspelled, the
    // flag is simply never applied and every row quietly answers as nano.
    // Verified against the browser rather than assumed — the flag offers only
    // Default and Enabled, so @1 is Enabled, and chrome://version shows it
    // reaching the command line as AIApiFoundationalModel:model_version/v4.
    const gemma = localStateFor(baseModelFor('chrome/gemma4_2b'))
    assert.deepEqual(gemma.browser.enabled_labs_experiments, ['gemma4-for-built-in-ai@1'])
    assert.deepEqual(
      localStateFor(baseModelFor('chrome/gemma4_4b')).browser.enabled_labs_experiments,
      ['gemma4-for-built-in-ai@1'],
    )
    // v3 is what Chrome does with no flag at all, so asking for it is not a
    // different flag — it is the absence of one.
    assert.deepEqual(localStateFor(baseModelFor('chrome/nano_v3')).browser.enabled_labs_experiments, [])
    // And the toggle that makes chrome://on-device-internals readable, which
    // is how the loaded model gets reported back under --debug.
    assert.equal(gemma.internal_only_uis_enabled, true)
  })

  it('cannot tell the two gemma sizes apart, and says so', () => {
    // Both rows ask Chrome for the same thing. Chrome chooses between
    // prompt_api_gemma4 / _4b / _12b itself, so the size is its call, and a
    // row promising one specific size would be promising what it cannot
    // deliver.
    assert.equal(
      modelVersionFor(baseModelFor('chrome/gemma4_2b')),
      modelVersionFor(baseModelFor('chrome/gemma4_4b')),
    )
  })
})

describe('chrome model identification', () => {
  const withManifest = (specName) => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-chrome-test-manifest-'))
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
      manifest_version: 2, name: 'Optimization Guide On Device Model', version: '2025.1.1.1000',
      BaseModelSpec: { name: specName, version: '2025.01.01.0000', supported_performance_hints: [2, 1] },
    }))
    return dir
  }

  it('matches the manifest name Chrome actually writes, not the registry id', (t) => {
    // The internals page calls it nano_v3_gpu_high_tier_model; the manifest
    // calls it v3Nano. Comparing those as strings rejected a working model.
    const dir = withManifest('v3Nano')
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    assert.ok(identifiesAs(dir, specNamesFor('nano_v3')))
  })

  it('keeps the two gemma rows apart', (t) => {
    // The names share no shape — gemma4-2b-it against gemma-4-E4B-it — so
    // anything loose enough to relate one to `gemma4_2b` relates both, and
    // picking the wrong one silently is the bug this check prevents.
    const twoB = withManifest('gemma4-2b-it')
    const fourB = withManifest('gemma-4-E4B-it')
    t.after(() => { for (const d of [twoB, fourB]) rmSync(d, { recursive: true, force: true }) })
    assert.ok(identifiesAs(twoB, specNamesFor('gemma4_2b')), 'gemma4_2b should match the 2b manifest')
    assert.ok(identifiesAs(fourB, specNamesFor('gemma4_4b')), 'gemma4_4b should match the E4B manifest')
    assert.equal(identifiesAs(fourB, specNamesFor('gemma4_2b')), false, 'gemma4_2b must NOT match the 4b model')
    assert.equal(identifiesAs(twoB, specNamesFor('gemma4_4b')), false, 'gemma4_4b must NOT match the 2b model')
    assert.equal(identifiesAs(twoB, specNamesFor('nano_v3')), false)
  })

  it('ignores case and punctuation drift, but not a different model', (t) => {
    const dir = withManifest('Gemma4_2B_IT')
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    assert.ok(identifiesAs(dir, specNamesFor('gemma4_2b')))
  })

  it('refuses a directory with no manifest rather than guessing', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-chrome-test-bare-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    assert.equal(identifiesAs(dir, specNamesFor('nano_v3')), false)
  })
})

describe('chrome request body', () => {
  const build = (messages, opts) => CHROME_SHAPE.buildRequestBody('chrome/gemma4_2b', 4096, 'be terse', messages, opts)

  it('splits history from the turn being asked', () => {
    const body = build([
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'two' },
      { role: 'user', content: 'three' },
    ])
    assert.deepEqual(body.initialPrompts, [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'two' },
    ])
    assert.equal(body.prompt, 'three')
  })

  it('sends no output cap — the Prompt API has none', () => {
    const body = build([{ role: 'user', content: 'hi' }])
    assert.equal(body.max_tokens, undefined)
    assert.equal(body.max_completion_tokens, undefined)
  })

  it('carries no constraint when there are no tools', () => {
    assert.equal(build([{ role: 'user', content: 'hi' }]).responseConstraint, undefined)
  })

  it('constrains the answer and describes the tools when there are', () => {
    const body = build([{ role: 'user', content: 'hi' }], { tools: TOOLS })
    const branches = body.responseConstraint.properties.tool_calls.items.anyOf
    assert.deepEqual(branches.map((b) => b.properties.name.enum[0]), ['read_file', 'list_dir'])
    // The constraint says what shape to answer in; only the prompt can say
    // what the tools actually do.
    assert.match(body.initialPrompts[0].content, /be terse/u)
    assert.match(body.initialPrompts[0].content, /read_file: Read a file/u)
    assert.match(body.initialPrompts[0].content, /"path"/u)
  })

  it('refuses thinking rather than silently dropping it', () => {
    assert.throws(() => build([{ role: 'user', content: 'hi' }], { think: true }), /no thinking mode/u)
    assert.throws(() => build([{ role: 'user', content: 'hi' }], { effort: 'high' }), /no thinking mode/u)
  })

  it('concatenates a prefix and suffix — nothing local caches across requests', () => {
    assert.deepEqual(
      CHROME_SHAPE.buildInitialUserMessage('chrome/gemma4_2b', 'prefix', 'suffix'),
      { role: 'user', content: 'prefixsuffix' },
    )
    assert.deepEqual(
      CHROME_SHAPE.buildInitialUserMessage('chrome/gemma4_2b', 'prefix'),
      { role: 'user', content: 'prefix' },
    )
  })
})

describe('chrome response shaping', () => {
  it('reads plain text back out', () => {
    const json = toChatCompletions({ text: 'hello', usage: { prompt_tokens: 5, completion_tokens: 2 } }, false)
    assert.equal(CHROME_SHAPE.extractResponseText(json), 'hello')
    assert.deepEqual(CHROME_SHAPE.extractToolCalls(json), [])
    assert.equal(CHROME_SHAPE.checkResponse(json), null)
    assert.equal(json.choices[0].finish_reason, 'stop')
  })

  it('reports usage in the shape normalizeOneUsage already reads', () => {
    const json = toChatCompletions({ text: 'x', usage: { prompt_tokens: 40, completion_tokens: 3 } }, false)
    assert.equal(json.usage.prompt_tokens, 40)
    assert.equal(json.usage.completion_tokens, 3)
  })

  it('turns a constrained answer into tool calls', () => {
    const raw = JSON.stringify({ tool_calls: [{ name: 'read_file', arguments: { path: 'a.js' } }] })
    const json = toChatCompletions({ text: raw }, true)
    assert.equal(json.choices[0].finish_reason, 'tool_calls')
    assert.deepEqual(CHROME_SHAPE.extractToolCalls(json), [
      { id: 'call_0', name: 'read_file', args: { path: 'a.js' } },
    ])
    // The prose half is empty on a pure tool turn, not the raw JSON.
    assert.equal(CHROME_SHAPE.extractResponseText(json), '')
  })

  it('takes the text branch of the constraint when no tool was called', () => {
    const json = toChatCompletions({ text: JSON.stringify({ text: 'no tool needed', tool_calls: [] }) }, true)
    assert.equal(CHROME_SHAPE.extractResponseText(json), 'no tool needed')
    assert.deepEqual(CHROME_SHAPE.extractToolCalls(json), [])
    assert.equal(json.choices[0].finish_reason, 'stop')
  })

  it('gives ids that are stable across identical requests', () => {
    const raw = JSON.stringify({ tool_calls: [{ name: 'read_file', arguments: {} }, { name: 'list_dir', arguments: {} }] })
    const ids = () => CHROME_SHAPE.extractToolCalls(toChatCompletions({ text: raw }, true)).map((c) => c.id)
    // A random id would change the cached response for a request that is
    // otherwise byte-for-byte the same one.
    assert.deepEqual(ids(), ['call_0', 'call_1'])
    assert.deepEqual(ids(), ['call_0', 'call_1'])
  })

  it('surfaces a page-side failure as an API error', () => {
    const json = toChatCompletions({ error: { message: 'on-device model not ready (availability: downloadable)' } }, false)
    assert.match(CHROME_SHAPE.checkResponse(json), /API error: on-device model not ready/u)
  })

  it('reports malformed constrained JSON as an error, not a crash', () => {
    const json = toChatCompletions({ text: 'not json at all' }, true)
    assert.match(CHROME_SHAPE.checkResponse(json), /malformed JSON under responseConstraint/u)
  })

  it('reports malformed tool ARGS through argsError, the way every adapter does', () => {
    // The constraint parsed, but the args inside it did not — chat() ends the
    // turn on argsError rather than throwing.
    const json = {
      choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'call_0', type: 'function', function: { name: 'read_file', arguments: '{oops' } }] } }],
    }
    const [call] = CHROME_SHAPE.extractToolCalls(json)
    assert.equal(call.args, undefined)
    assert.match(call.argsError, /Tool call read_file: malformed JSON args/u)
  })
})

describe('chrome tool-result threading', () => {
  it('folds results into a user turn — initialPrompts has no `tool` role', () => {
    const messages = [{ role: 'user', content: 'go' }]
    const raw = JSON.stringify({ tool_calls: [{ name: 'read_file', arguments: { path: 'a.js' } }] })
    const json = toChatCompletions({ text: raw }, true)
    const calls = CHROME_SHAPE.extractToolCalls(json)
    CHROME_SHAPE.appendToolResults(messages, json, calls, ['contents of a.js'])

    assert.equal(messages.length, 3)
    assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'user'])
    // Every role Chrome's initialPrompts accepts, and nothing else.
    for (const m of messages) assert.ok(['system', 'user', 'assistant'].includes(m.role), m.role)
    // The assistant turn shows the call it made, not an empty message.
    assert.match(messages[1].content, /read_file/u)
    assert.match(messages[2].content, /contents of a\.js/u)
  })

  it('threads a second turn back into a well-formed body', () => {
    const messages = [{ role: 'user', content: 'go' }]
    const json = toChatCompletions({ text: JSON.stringify({ tool_calls: [{ name: 'list_dir', arguments: {} }] }) }, true)
    CHROME_SHAPE.appendToolResults(messages, json, CHROME_SHAPE.extractToolCalls(json), ['a.js\nb.js'])
    const body = CHROME_SHAPE.buildRequestBody('chrome/gemma4_2b', 4096, 'sys', messages, { tools: TOOLS })
    assert.equal(body.initialPrompts.length, 3)
    assert.match(body.prompt, /a\.js/u)
    assert.ok(body.responseConstraint)
  })
})

describe('chrome tool schema helpers', () => {
  it('holds the model to the tools that exist', () => {
    const schema = toolConstraint(TOOLS)
    const branches = schema.properties.tool_calls.items.anyOf
    assert.deepEqual(branches.map((b) => b.properties.name.enum[0]), ['read_file', 'list_dir'])
    for (const branch of branches) assert.deepEqual(branch.required, ['name', 'arguments'])
  })

  it('binds each tool to its OWN argument schema', () => {
    // One shared `arguments: { type: 'object' }` accepted anything, and
    // chat() hands calls to the caller's handler without revalidating — so a
    // call missing a required field reached a real tool.
    const [readFile, listDir] = toolConstraint(TOOLS).properties.tool_calls.items.anyOf
    assert.deepEqual(readFile.properties.arguments, TOOLS[0].input_schema)
    assert.deepEqual(listDir.properties.arguments, TOOLS[1].input_schema)
  })

  it('cannot be satisfied by an empty object', () => {
    // `{}` used to validate, and became a successful turn with no text and no
    // tool calls — a silent dead end rather than an answer.
    assert.deepEqual(toolConstraint(TOOLS).required, ['text', 'tool_calls'])
  })

  it('describes every tool it allows', () => {
    const text = toolInstructions(TOOLS)
    for (const tool of TOOLS) assert.match(text, new RegExp(tool.name, 'u'))
  })
})

describe('chrome scratch-profile cleanup', () => {
  it('recognises only its own scratch profiles', () => {
    // The predicate, not the delete. Asking removeProfileDir to refuse ''
    // or '/' would, the day the guard regressed, delete the cwd or the root
    // from inside the test written to catch that — so nothing here calls a
    // function that can remove a file.
    for (const bad of ['', undefined, null, 0, {}, [], '/', '/tmp', tmpdir(),
      join(tmpdir(), 'ai-chrome-'), join(tmpdir(), 'nested', 'ai-chrome-x'),
      join(homedir(), 'ai-chrome-elsewhere')]) {
      assert.equal(isScratchProfile(bad), false, `should not accept ${JSON.stringify(bad)}`)
    }
    assert.equal(isScratchProfile(join(tmpdir(), 'ai-chrome-abc123')), true)
  })

  it('removes a directory that IS one of ours', () => {
    const ours = mkdtempSync(join(tmpdir(), 'ai-chrome-'))
    writeFileSync(join(ours, 'Local State'), '{}')
    removeProfileDir(ours)
    assert.equal(existsSync(ours), false)
  })

  // The provider removes its scratch profile, and that profile contains a
  // symlink to the user's multi-gigabyte model directory. This asserts the
  // platform behaviour the cleanup leans on: a recursive delete unlinks a
  // symlink rather than following it. If that ever stopped holding, the
  // provider would delete weights that are not its own, silently.
  it('deletes the profile without following the symlink into the model', () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-chrome-test-root-'))
    const model = join(root, 'model')
    mkdirSync(model)
    writeFileSync(join(model, 'weights.bin'), 'the user\'s copy')

    const profile = join(root, 'profile')
    mkdirSync(profile)
    symlinkSync(model, join(profile, 'OptGuideOnDeviceModel'))

    rmSync(profile, { recursive: true, force: true })

    assert.equal(existsSync(profile), false, 'the scratch profile should be gone')
    assert.equal(readFileSync(join(model, 'weights.bin'), 'utf8'), 'the user\'s copy')
    rmSync(root, { recursive: true, force: true })
  })
})

describe('chrome preflight', () => {
  it('refuses rather than downloading a second copy of the weights', (t) => {
    t.after(() => { delete process.env.CHROME_MODEL_DIR })
    process.env.CHROME_MODEL_DIR = ''
    // Nothing under a home dir this test controls, so on a machine with no
    // model this is the real path; on one with a model, CHROME_MODEL_DIR
    // below proves the other half.
    if (findModelDir()) return t.skip('this machine has an on-device model installed')
    assert.throws(() => chromePreflight(), /will not download a second copy/u)
  })

  it('accepts a model dir it is pointed at, and selects the provider', (t) => {
    t.after(() => { delete process.env.CHROME_MODEL_DIR })
    process.env.CHROME_MODEL_DIR = fakeModelDir()
    assert.equal(findModelDir(), process.env.CHROME_MODEL_DIR)
    // No key, no URL — the two things setProvider demands of everyone else.
    assert.doesNotThrow(() => setProvider('chrome'))
  })
})

// The half that needs a browser: that the page-side function runs where
// `LanguageModel` lives and comes back as a value Node can read. The model
// itself is stubbed — a real one needs a GPU and a 4 GB download, neither of
// which belongs in a unit suite — so what this proves is the round trip, not
// the generation. Skipped wherever Chrome isn't installed.
describe('chrome page round-trip', async () => {
  let chromium
  try { ({ chromium } = await import('playwright-core')) } catch { /* optional dep */ }

  let browser
  after(async () => { await browser?.close() })

  const open = async () => {
    browser = await chromium.launch({
      ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: process.env.CHROME_CHANNEL || 'chrome' }),
      args: process.platform === 'linux' ? ['--no-sandbox'] : [],
    })
    const page = await browser.newPage()
    await page.goto('file:///dev/null')
    return page
  }

  const STUB = (reply) => `globalThis.LanguageModel = {
    availability: async () => 'available',
    create: async ({ initialPrompts }) => ({
      contextUsage: initialPrompts.length * 10,
      contextWindow: 8192,
      prompt: async (text, options) => ${reply},
      destroy() {},
    }),
  }`

  let page
  try { page = chromium && await open() } catch { /* no Chrome on this machine */ }
  const skip = page ? false : 'needs an installed Chrome and playwright-core'

  it('runs the turn in the page and brings back text and usage', { skip }, async () => {
    await page.evaluate(STUB('`saw ${initialPrompts.length} prompts, asked: ${text}`'))
    const result = await page.evaluate(turnInPage, {
      initialPrompts: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'a' }],
      prompt: 'b',
    })
    assert.equal(result.error, undefined)
    assert.equal(result.text, 'saw 2 prompts, asked: b')
    assert.equal(result.contextWindow, 8192)
    assert.equal(result.usage.prompt_tokens, 20)
  })

  it('passes the constraint through and shapes tool calls out of the answer', { skip }, async () => {
    await page.evaluate(STUB('JSON.stringify({ text: "", tool_calls: [{ name: options.responseConstraint.properties.tool_calls.items.anyOf[0].properties.name.enum[0], arguments: {} }] })'))
    const body = CHROME_SHAPE.buildRequestBody('chrome/gemma4_2b', 4096, 'sys', [{ role: 'user', content: 'go' }], { tools: TOOLS })
    const json = toChatCompletions(await page.evaluate(turnInPage, body), true)
    assert.deepEqual(CHROME_SHAPE.extractToolCalls(json), [{ id: 'call_0', name: 'read_file', args: {} }])
  })

  it('warms the model by asking for a session, not by waiting on availability', { skip }, async () => {
    // The deadlock this replaced: availability() answers `unavailable` for a
    // model that is merely unloaded, and only create() loads one — so waiting
    // for `available` before calling create() waits forever.
    await page.evaluate(`
      globalThis.__creates = 0
      globalThis.LanguageModel = {
        availability: async () => 'unavailable',
        create: async () => { globalThis.__creates++; return { destroy() {} } },
      }`)
    await waitUntilReady(page, false)
    assert.equal(await page.evaluate(() => globalThis.__creates), 1, 'should have asked for a session')
  })

  it('does not mistake load progress for a download', { skip }, async () => {
    // `downloadprogress` fires while Chrome prepares weights it already has.
    // Treating a sub-complete event as a network fetch aborted every warm-up
    // roughly ten seconds in; --disable-component-update is what actually
    // prevents a download, not anything in the page.
    await page.evaluate(`
      globalThis.LanguageModel = {
        availability: async () => 'unavailable',
        create: async ({ monitor }) => {
          const target = new EventTarget()
          monitor(target)
          for (const loaded of [0, 0.5, 1]) {
            target.dispatchEvent(Object.assign(new Event('downloadprogress'), { loaded }))
          }
          return { destroy() {} }
        },
      }`)
    await assert.doesNotReject(() => waitUntilReady(page, false))
  })

  it('reports a Chromium with no Prompt API as such', { skip }, async () => {
    await page.evaluate('delete globalThis.LanguageModel')
    const result = await page.evaluate(turnInPage, { initialPrompts: [], prompt: 'x' })
    assert.match(result.error.message, /not a branded Chrome/u)
  })
})
