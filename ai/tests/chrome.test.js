import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { IGNORED_DEFAULT_ARGS, chromePreflight, findModelDir, isScratchProfile, launchArgs, localStateFor, removeProfileDir, turnInPage, waitUntilReady } from '../src/chrome.js'
import { graftPlanIn, identifiesAs, portableGuide } from '../src/chrome-model.js'
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
    for (const model of ['chrome/nano_v3', 'chrome/gemma4_2b', 'chrome/gemma4_4b', 'chrome/gemma4_12b']) {
      const usage = { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite5m: 0, cacheWrite1h: 0 }
      assert.equal(calculateCost(model, usage), 0, model)
    }
  })

  it('name the base model spec the row expects Chrome to hold', () => {
    assert.equal(baseModelFor('chrome/nano_v3'), 'nano_v3')
    assert.equal(baseModelFor('chrome/gemma4_2b'), 'gemma4_2b')
    assert.equal(baseModelFor('chrome/gemma4_4b'), 'gemma4_4b')
    assert.equal(baseModelFor('chrome/gemma4_12b'), 'gemma4_12b')
    // Undefined is what tells the adapter a row is not one of Chrome's.
    assert.equal(baseModelFor('anthropic/claude-opus-5'), undefined)
  })

  it('record the manifest names Chrome writes, which share no shape', () => {
    // Recorded rather than derived: v3Nano, gemma4-2b-it and gemma-4-E4B-it
    // have no common rule, and anything loose enough to relate gemma4_2b to
    // gemma4-2b-it also relates it to gemma-4-E4B-it.
    assert.deepEqual(specNamesFor('nano_v3'), ['v3Nano'])
    assert.deepEqual(specNamesFor('gemma4_2b'), ['gemma4-2b-it'])
    assert.deepEqual(specNamesFor('gemma4_4b'), ['gemma-4-E4B-it'])
    // The 12B row needs none. Its manifest declares no spec, and the component
    // name it declares instead is a template of the row's own id.
    assert.deepEqual(specNamesFor('gemma4_12b'), [])
  })

  it('are recognised rows, so getMaxTokens does not fall back', () => {
    assert.equal(getMaxTokens('chrome/nano_v3'), 4096)
  })
})

describe('chrome foundational model version', () => {
  const features = (model) => launchArgs('/models/x', baseModelFor(model))
    .find((arg) => arg.startsWith('--enable-features='))

  it('names the map key that picks each variant', () => {
    // Not a version number — a KEY into the manifest's experimental_use_cases:
    //
    //   PromptApiFeatureConfig {
    //     default_use_case: "prompt_api"
    //     experimental_use_cases: { "v4":     "prompt_api_gemma4"
    //                               "v4_4b":  "prompt_api_gemma4_4b"
    //                               "v4_12b": "prompt_api_gemma4_12b" }
    //   }
    //
    // AIApiFoundationalModel:model_version carries that key, which is how a
    // row picks its own size. nano wants the default use case and so names no
    // key of its own.
    assert.equal(modelVersionFor(baseModelFor('chrome/nano_v3')), 'v3')
    assert.equal(modelVersionFor(baseModelFor('chrome/gemma4_2b')), 'v4')
    assert.equal(modelVersionFor(baseModelFor('chrome/gemma4_4b')), 'v4_4b')
    assert.equal(modelVersionFor(baseModelFor('chrome/gemma4_12b')), 'v4_12b')
  })

  it('tells the gemma sizes apart, which the flag could not', () => {
    // chrome://flags/#gemma4-for-built-in-ai hard-codes model_version to v4,
    // so every gemma row asked for the 2b use case however its weights were
    // linked: Broker State showed prompt_api_gemma4 Requested and pending
    // while prompt_api_gemma4_4b sat there available and unasked-for.
    const keys = ['chrome/gemma4_2b', 'chrome/gemma4_4b', 'chrome/gemma4_12b']
      .map((model) => modelVersionFor(baseModelFor(model)))
    assert.equal(new Set(keys).size, keys.length, `expected distinct keys, got ${keys.join(', ')}`)
  })

  it('puts the key on the command line, and only for a gemma row', () => {
    assert.match(features('chrome/gemma4_4b'), /AIApiFoundationalModel:model_version\/v4_4b(,|$)/u)
    assert.match(features('chrome/gemma4_12b'), /AIApiFoundationalModel:model_version\/v4_12b(,|$)/u)
    // The broker rides along, since the variant use cases are its business.
    assert.match(features('chrome/gemma4_2b'), /OptimizationGuideManifestBroker/u)
    // nano is what Chrome does anyway and asks for none of it.
    assert.doesNotMatch(features('chrome/nano_v3'), /AIApiFoundationalModel|ManifestBroker/u)
  })

  it("drops playwright's own --enable-features rather than merging with it", () => {
    // Playwright appends its copy AFTER ours and Chrome reads the last
    // occurrence, so leaving it in discarded everything we added — measured on
    // chrome://version, which showed its value alone and none of ours.
    // ignoreDefaultArgs matches by exact string, so the whole switch is spelled
    // out; a playwright that changes it silently stops being filtered.
    assert.ok(IGNORED_DEFAULT_ARGS.includes('--enable-features=CDPScreenshotNewSurface'))
    // And ours has to carry their feature, or dropping theirs loses it.
    assert.match(features('chrome/nano_v3'), /CDPScreenshotNewSurface/u)
  })
})

describe('chrome profile graft', () => {
  // Stated against paths, not against whichever Chrome this machine has, so
  // it runs on CI too. The ledger is absent from a made-up user data dir,
  // which leaves exactly the model entries under test.
  const UDD = '/udd'
  const plan = (modelDir) => graftPlanIn(UDD, modelDir)

  it('links the one requested model, not every installed one', () => {
    // Linking the component roots whole put all four models in front of the
    // browser. The requested one is known at launch, so nothing else needs to
    // be visible — and with only a leaf linked, the parent directories inside
    // the profile are real, so nothing Chrome writes beside it can reach the
    // user's own component tree.
    assert.deepEqual(plan('/udd/OptGuideManifestModel/abc123/2026.1.2.1000'), [
      { from: '/udd/OptGuideManifestModel/abc123/2026.1.2.1000', rel: 'OptGuideManifestModel/abc123/2026.1.2.1000' },
    ])
  })

  it('mirrors the path rather than flattening it', () => {
    // The two stores nest differently and Chrome reads the shape, so a link
    // has to land where the original sat: one level down for nano, two for
    // the gemma models, which key a content hash above the version.
    assert.deepEqual(plan('/udd/OptGuideOnDeviceModel/2025.1.1.1000').at(-1).rel, 'OptGuideOnDeviceModel/2025.1.1.1000')
    assert.deepEqual(plan('/udd/OptGuideManifestModel/h/2026.1.3.1000').at(-1).rel, 'OptGuideManifestModel/h/2026.1.3.1000')
  })

  it('skips a model dir that has no place inside the profile', () => {
    // CHROME_MODEL_DIR can point anywhere. There is no position to mirror,
    // and the override switch names it outright, so it is not linked rather
    // than linked somewhere invented — in particular never at a rel that
    // climbs out of the profile.
    assert.deepEqual(plan('/tmp/some/borrowed/weights'), [])
    assert.deepEqual(plan('/udd/../elsewhere/weights'), [])
  })

  it('links nothing at all when there is no Chrome to borrow from', () => {
    assert.deepEqual(graftPlanIn(undefined, '/udd/OptGuideOnDeviceModel/1'), [])
    assert.deepEqual(plan(undefined), [])
  })
})

describe('chrome missing model', () => {
  it('sends the caller to chrome://on-device-internals rather than downloading', (t) => {
    // The provider does not download, and neither may the browser it
    // launches, so a model Chrome has not got is a stop with somewhere to go.
    const dir = mkdtempSync(join(tmpdir(), 'ai-chrome-test-missing-'))
    t.after(() => { rmSync(dir, { recursive: true, force: true }); delete process.env.CHROME_MODEL_DIR })
    let err
    try { findModelDir('gemma4_12b') } catch (e) { err = e }
    // A machine that happens to HAVE a 12b installed proves nothing here.
    if (!err) { t.skip('this machine has the model'); return }
    assert.match(err.message, /chrome:\/\/on-device-internals/u)
    assert.match(err.message, /will not download/u)
    // And the escape hatch for a model Chrome merely renamed.
    assert.match(err.message, /specNames/u)
  })
})

describe('chrome inherited prefs', () => {
  // Shape only; the values are stand-ins. Ledger keys are the content hash a
  // manifest model sits under, and requested_version is its version directory.
  const GUIDE = {
    on_device: { performance_class: 5, model_validation_result: { result: 2 }, vram_mb: 'some number' },
    model_cache_key_mapping: { a: 'b' },
    model_quality_logging_client_id: 'identifies a browser',
    model_store_metadata: { 2: {} },
    predictionmodelfetcher: { last_fetch_attempt: '1' },
    model_execution: {
      last_usage_by_feature: {
        prompt_api: '1', prompt_api_gemma4: '2', prompt_api_gemma4_12b: '3', prompt_api_gemma4_4b: '4',
      },
      manifest_asset_ledger: {
        hashnano: { asset_id: 'nano_v3_gpu_component', requested_version: '2025.1.1.1000' },
        hash2b: { asset_id: 'gemma4_component', requested_version: '2026.1.1.1000' },
        hash4b: { asset_id: 'gemma4_4b_component', requested_version: '2026.1.2.1000' },
      },
    },
  }
  const DIRS = {
    nano: '/udd/OptGuideOnDeviceModel/2025.1.1.1000',
    twoB: '/udd/OptGuideManifestModel/hash2b/2026.1.1.1000',
    fourB: '/udd/OptGuideManifestModel/hash4b/2026.1.2.1000',
  }
  const ledger = (dir) => portableGuide(GUIDE, dir).optimization_guide.model_execution.manifest_asset_ledger

  it('requests the one component the launch links', () => {
    // Every ledger entry is a standing REQUEST, not a record of an install.
    // Three of them against a profile that links one model is two fetches: a
    // nano launch pulling gemma4, a gemma4 launch pulling nano_v3. The entry
    // itself is passed through, so a field Chrome adds to it still arrives.
    assert.deepEqual(ledger(DIRS.twoB), { hash2b: GUIDE.model_execution.manifest_asset_ledger.hash2b })
    assert.deepEqual(ledger(DIRS.fourB), { hash4b: GUIDE.model_execution.manifest_asset_ledger.hash4b })
    // Nano's store has no hash in the path, so the version names its entry.
    assert.deepEqual(ledger(DIRS.nano), { hashnano: GUIDE.model_execution.manifest_asset_ledger.hashnano })
  })

  it('names the one thing it takes rather than deleting the rest', () => {
    // The whole result, asserted whole: one standing request and nothing
    // beside it. Everything else stays in the profile it came from —
    // last_usage_by_feature, which listed the other use cases as Pending
    // Assets; on_device, which the perf-class switch makes redundant and a
    // real model answers without; and an id identifying somebody's browser.
    assert.deepEqual(portableGuide(GUIDE, DIRS.nano), {
      optimization_guide: {
        model_execution: {
          manifest_asset_ledger: { hashnano: GUIDE.model_execution.manifest_asset_ledger.hashnano },
        },
      },
    })
  })

  it('inherits nothing when it cannot identify the launched component', () => {
    // A CHROME_MODEL_DIR outside the component tree. graftPlan links nothing
    // there either, and the execution override names the directory outright —
    // whereas carrying the real profile's ledger would claim components this
    // profile does not have, which is the fetch all of this exists to stop.
    assert.deepEqual(portableGuide(GUIDE, '/tmp/borrowed/weights'), {})
    assert.deepEqual(portableGuide(GUIDE, undefined), {})
  })

  it('writes the internals toggle and nothing about which model to run', () => {
    // localStateFor is the file the launch actually writes. Which Gemma
    // answers used to be decided here, as a chrome://flags choice under
    // browser.enabled_labs_experiments; it is a command-line feature param
    // now, because the flag could only ever say v4.
    const state = localStateFor(DIRS.nano)
    assert.equal(state.internal_only_uis_enabled, true)
    assert.equal('browser' in state, false)
  })

  it('does not invent a subtree that was not there', () => {
    // localStateFor spreads this, so {} has to mean "add no key".
    assert.deepEqual(portableGuide(undefined, DIRS.nano), {})
    assert.deepEqual(portableGuide({}, DIRS.nano), {})
    assert.deepEqual(portableGuide({ on_device: { performance_class: 5 } }, DIRS.nano), {})
  })
})

describe('chrome launch switches', () => {
  const args = launchArgs('/models/nano')

  it('never lets the browser fetch a model', () => {
    // Asking for Gemma 4 turns on the manifest broker, which started a 6.1 GB
    // foreground install of a gemma4_12b the profile did not have, over again
    // on every launch. Downloading is the one thing this provider exists not
    // to do, so the component updater is pointed at an address that cannot
    // answer. Port 1 is on Chrome's restricted list: the attempt dies as
    // ERR_UNSAFE_PORT without a socket.
    const guard = args.find((a) => a.startsWith('--component-updater='))
    assert.ok(guard, 'expected the component updater to be redirected')
    assert.match(guard, /url-source=http:\/\/127\.0\.0\.1:1\//u)
  })

  it('keeps OptimizationHints enabled', () => {
    // The single entry whose removal from playwright's list took four wrong
    // diagnoses to find: with it disabled, availability() reads `unavailable`
    // and no eligibility reason is recorded. --enable-features cannot undo it,
    // since disable wins, so the whole list has to be re-sent without it.
    const disabled = args.find((a) => a.startsWith('--disable-features='))
    assert.ok(disabled, 'expected a disable list')
    assert.doesNotMatch(disabled, /OptimizationHints/u)
    // Still playwright's list otherwise, or the launch loses their defaults.
    assert.match(disabled, /DestroyProfileOnBrowserClose/u)
  })

  it('points at the borrowed weights and skips the benchmark', () => {
    assert.ok(args.includes('--optimization-guide-ondevice-model-execution-override=/models/nano'))
    // An INTEGER: Chrome parses it with StringToInt, so a name becomes
    // kUnknown and reads exactly like not passing the switch at all.
    const perf = args.find((a) => a.startsWith('--optimization-guide-performance-class='))
    assert.match(perf, /=\d+$/u)
  })
})

describe('chrome model identification', () => {
  const withManifest = (specName, componentName = 'Optimization Guide On Device Model') => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-chrome-test-manifest-'))
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
      manifest_version: 2, name: componentName, version: '2025.1.1.1000',
      // Omitted entirely when there is no spec — which is how the 12B
      // manifest arrives, not a BaseModelSpec with a missing name.
      ...(specName ? { BaseModelSpec: { name: specName, version: '2025.01.01.0000', supported_performance_hints: [2, 1] } } : {}),
    }))
    return dir
  }

  it('matches the manifest name Chrome actually writes, not the registry id', (t) => {
    // The internals page calls it nano_v3_gpu_high_tier_model; the manifest
    // calls it v3Nano. Comparing those as strings rejected a working model.
    const dir = withManifest('v3Nano')
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    assert.ok(identifiesAs(dir, 'nano_v3'))
  })

  it('keeps the two gemma rows apart', (t) => {
    // The names share no shape — gemma4-2b-it against gemma-4-E4B-it — so
    // anything loose enough to relate one to `gemma4_2b` relates both, and
    // picking the wrong one silently is the bug this check prevents.
    const twoB = withManifest('gemma4-2b-it')
    const fourB = withManifest('gemma-4-E4B-it')
    t.after(() => { for (const d of [twoB, fourB]) rmSync(d, { recursive: true, force: true }) })
    assert.ok(identifiesAs(twoB, 'gemma4_2b'), 'gemma4_2b should match the 2b manifest')
    assert.ok(identifiesAs(fourB, 'gemma4_4b'), 'gemma4_4b should match the E4B manifest')
    assert.equal(identifiesAs(fourB, 'gemma4_2b'), false, 'gemma4_2b must NOT match the 4b model')
    assert.equal(identifiesAs(twoB, 'gemma4_4b'), false, 'gemma4_4b must NOT match the 2b model')
    assert.equal(identifiesAs(twoB, 'nano_v3'), false)
  })

  it('derives the component name from the row id when there is no BaseModelSpec', (t) => {
    // The 12B manifest is the odd one out: no BaseModelSpec at all, identity
    // in the top-level name.
    //
    //   { "name": "Optimization Guide On-Device Gemma4 12B Model",
    //     "version": "<version>" }
    //
    // Lowercased with spaces made underscores that is
    // optimization_guide_on-device_gemma4_12b_model, which is the row's own id
    // in a template — so nothing is transcribed and a future size needs no
    // edit.
    const twelveB = withManifest(null, 'Optimization Guide On-Device Gemma4 12B Model')
    // And the generic name the spec-carrying manifests use up there, which the
    // fallback must not turn into a match for anything.
    const generic = withManifest('gemma4-2b-it')
    t.after(() => { for (const d of [twelveB, generic]) rmSync(d, { recursive: true, force: true }) })
    assert.ok(identifiesAs(twelveB, 'gemma4_12b'), 'the 12B row should match its manifest')
    assert.equal(identifiesAs(twelveB, 'gemma4_2b'), false, '2b must not match the 12B model')
    assert.equal(identifiesAs(twelveB, 'gemma4_4b'), false, '4b must not match the 12B model')
    // The generic top-level name is never consulted here, because the spec
    // beneath it wins — otherwise every spec-carrying manifest would collapse
    // onto one identity.
    assert.equal(identifiesAs(generic, 'gemma4_12b'), false, '12b must not match a 2b manifest')
    assert.ok(identifiesAs(generic, 'gemma4_2b'))
  })

  it('would match a size Chrome has not shipped yet', (t) => {
    // The point of deriving the name: a hypothetical gemma4_27b needs a
    // registry row and nothing else. Its manifest would identify itself the
    // same way, and a transcribed title could not have anticipated it.
    const dir = withManifest(null, 'Optimization Guide On-Device Gemma4 27B Model')
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    assert.ok(identifiesAs(dir, 'gemma4_27b'))
    assert.equal(identifiesAs(dir, 'gemma4_12b'), false)
  })

  it('ignores case and punctuation drift, but not a different model', (t) => {
    const dir = withManifest('Gemma4_2B_IT')
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    assert.ok(identifiesAs(dir, 'gemma4_2b'))
  })

  it('refuses a directory with no manifest rather than guessing', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-chrome-test-bare-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    assert.equal(identifiesAs(dir, 'nano_v3'), false)
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

  it('concatenates the blocks — nothing local caches across requests', () => {
    const initial = (userContent) => CHROME_SHAPE.buildInitialUserMessage('chrome/gemma4_2b', userContent)
    // A list, which is what chat() passes now. Concatenating with `+` gave
    // 'prefix,suffix' here: an array stringifies with commas, so the old
    // two-argument form put a comma into the prompt the moment a caller
    // split its user content.
    assert.deepEqual(initial(['prefix', 'suffix']), { role: 'user', content: 'prefixsuffix' })
    assert.deepEqual(initial(['A', 'B', 'C']), { role: 'user', content: 'ABC' })
    // The plain string, which has to keep working unchanged.
    assert.deepEqual(initial('prefix'), { role: 'user', content: 'prefix' })
    // Joined on '' like every other adapter, because that is what the cache
    // key is built from — a separator here would file a split request under a
    // key its own unsplit result never produces.
    assert.deepEqual(initial(['a', '']), { role: 'user', content: 'a' })
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
