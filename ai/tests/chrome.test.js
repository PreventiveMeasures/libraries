import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync } from 'node:fs'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { IGNORED_DEFAULT_ARGS, chromePreflight, closeChrome, findModelDir, isScratchProfile, launchArgs, launchOptions, localStateFor, openTab, pruneProfileRoot, removeProfileDir, sweepStaleProfiles, turnInPage, turnRequest } from '../src/chrome/index.js'
import { graftPlanIn, identifiesAs, portableGuide, rootOwning } from '../src/chrome/model.js'
import { CHROME_SHAPE, explainCreateFailure, toChatCompletions, toolConstraint, toolInstructions } from '../src/chrome/wire.js'
import { sendChromeTurn, trackTurn } from '../src/chrome/index.js'
import { claimProfile, dropProfile } from '../src/chrome/profile.js'
import { baseModelFor, calculateCost, getMaxTokens, modelVersionFor, specNamesFor } from '../src/models.js'
import { setProvider, turnCost } from '../src/providers.js'

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

// Where the provider puts its scratch profiles, and one shaped the same way.
// Spelled out rather than imported, so a wrong root is a failure here.
// A function, because os.tmpdir() reads the environment on every call.
const profileRoot = () => join(tmpdir(), `preventive-ai${process.getuid ? `-${process.getuid()}` : ''}`)
function scratchProfile() {
  mkdirSync(profileRoot(), { recursive: true })
  return mkdtempSync(join(profileRoot(), 'chrome-'))
}

// chrome selects without a key — its preflight checks weights, not auth — so
// turnCost can be asked what a local run costs.
function withChrome(fn) {
  const previous = process.env.CHROME_MODEL_DIR
  process.env.CHROME_MODEL_DIR = fakeModelDir()
  try {
    setProvider('chrome')
    fn()
  } finally {
    if (previous === undefined) delete process.env.CHROME_MODEL_DIR
    else process.env.CHROME_MODEL_DIR = previous
  }
}

describe('chrome registry rows', () => {
  it('carry no price, and cost nothing to run — the compute was already paid for', () => {
    // Unpriced rather than priced at zero: nobody sells these, so the table
    // has no rate to state. That a run costs nothing is the provider's
    // answer, and turnCost is where it is given.
    const usage = { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite5m: 0, cacheWrite1h: 0 }
    for (const model of ['chrome/gemini-nano-v3', 'chrome/gemma-4-e2b-it', 'chrome/gemma-4-e4b-it', 'chrome/gemma-4-12b-it']) {
      assert.equal(calculateCost(model, usage), null, model)
      withChrome(() => assert.equal(turnCost(model, usage), 0, model))
    }
  })

  it('name the base model spec the row expects Chrome to hold', () => {
    assert.equal(baseModelFor('chrome/gemini-nano-v3'), 'nano_v3')
    assert.equal(baseModelFor('chrome/gemma-4-e2b-it'), 'gemma4_2b')
    assert.equal(baseModelFor('chrome/gemma-4-e4b-it'), 'gemma4_4b')
    assert.equal(baseModelFor('chrome/gemma-4-12b-it'), 'gemma4_12b')
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
    assert.equal(getMaxTokens('chrome/gemini-nano-v3'), 4096)
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
    assert.equal(modelVersionFor(baseModelFor('chrome/gemini-nano-v3')), 'v3')
    assert.equal(modelVersionFor(baseModelFor('chrome/gemma-4-e2b-it')), 'v4')
    assert.equal(modelVersionFor(baseModelFor('chrome/gemma-4-e4b-it')), 'v4_4b')
    assert.equal(modelVersionFor(baseModelFor('chrome/gemma-4-12b-it')), 'v4_12b')
  })

  it('tells the gemma sizes apart, which the flag could not', () => {
    // chrome://flags/#gemma4-for-built-in-ai hard-codes model_version to v4,
    // so every gemma row asked for the 2b use case however its weights were
    // linked: Broker State showed prompt_api_gemma4 Requested and pending
    // while prompt_api_gemma4_4b sat there available and unasked-for.
    const keys = ['chrome/gemma-4-e2b-it', 'chrome/gemma-4-e4b-it', 'chrome/gemma-4-12b-it']
      .map((model) => modelVersionFor(baseModelFor(model)))
    assert.equal(new Set(keys).size, keys.length, `expected distinct keys, got ${keys.join(', ')}`)
  })

  it('puts the key on the command line, and only for a gemma row', () => {
    assert.match(features('chrome/gemma-4-e4b-it'), /AIApiFoundationalModel:model_version\/v4_4b(,|$)/u)
    assert.match(features('chrome/gemma-4-12b-it'), /AIApiFoundationalModel:model_version\/v4_12b(,|$)/u)
    // The broker rides along, since the variant use cases are its business.
    assert.match(features('chrome/gemma-4-e2b-it'), /OptimizationGuideManifestBroker/u)
    // nano is what Chrome does anyway and asks for none of it.
    assert.doesNotMatch(features('chrome/gemini-nano-v3'), /AIApiFoundationalModel|ManifestBroker/u)
  })

  it("drops playwright's own --enable-features rather than merging with it", () => {
    // Playwright appends its copy AFTER ours and Chrome reads the last
    // occurrence, so leaving it in discarded everything we added — measured on
    // chrome://version, which showed its value alone and none of ours.
    // ignoreDefaultArgs matches by exact string, so the whole switch is spelled
    // out; a playwright that changes it silently stops being filtered.
    assert.ok(IGNORED_DEFAULT_ARGS.includes('--enable-features=CDPScreenshotNewSurface'))
    // And ours has to carry their feature, or dropping theirs loses it.
    assert.match(features('chrome/gemini-nano-v3'), /CDPScreenshotNewSurface/u)
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

  it('grafts from the root that HOLDS the model, not the first Chrome installed', () => {
    // Two different questions the moment a second channel is installed, and
    // they were being answered by two different rules: discovery searches
    // every root, while the graft took the first root holding any component.
    // Nano under stable and the requested gemma under Canary answered stable
    // — whose tree does not contain the model, so nothing was linked and the
    // prefs came from a profile that had never asked for it.
    const roots = ['/udd', '/udd-canary']
    assert.equal(rootOwning(roots, '/udd-canary/OptGuideManifestModel/h/2026.1.1.1000'), '/udd-canary')
    assert.equal(rootOwning(roots, '/udd/OptGuideOnDeviceModel/2025.1.1.1000'), '/udd')
    // A shared prefix is not containment, or the canary weights would be
    // grafted as if they sat in stable's tree.
    assert.equal(rootOwning(['/udd'], '/udd-canary/OptGuideOnDeviceModel/1'), undefined)
    // And a CHROME_MODEL_DIR outside every root has no owner at all.
    assert.equal(rootOwning(roots, '/tmp/borrowed/weights'), undefined)
    assert.equal(rootOwning(roots, undefined), undefined)
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
    assert.match(err.message, /Installed instead/u)
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

  it('takes the entry the hash names when another component requests the same version', () => {
    // Versions are dates, and two components can be requesting the same one.
    // Matching either half accepted whichever entry came first, so a profile
    // linking one model could be handed the standing request for another.
    const shared = {
      hashother: { asset_id: 'some_other_component', requested_version: '2026.1.1.1000' },
      hash2b: { asset_id: 'gemma4_component', requested_version: '2026.1.1.1000' },
    }
    const guide = { model_execution: { manifest_asset_ledger: shared } }
    assert.deepEqual(
      portableGuide(guide, DIRS.twoB).optimization_guide.model_execution.manifest_asset_ledger,
      { hash2b: shared.hash2b },
    )
  })

  it('takes the entry the row names when a version is all the path carries', () => {
    // The flat store has no hash in its path, so a version two components
    // share would otherwise be the only thing to go on — and whichever came
    // first would win. The row names the component outright.
    const shared = {
      hashother: { asset_id: 'some_other_component', requested_version: '2025.1.1.1000' },
      hashnano: { asset_id: 'nano_v3_gpu_component', requested_version: '2025.1.1.1000' },
    }
    const guide = { model_execution: { manifest_asset_ledger: shared } }
    assert.deepEqual(
      portableGuide(guide, DIRS.nano, 'nano_v3').optimization_guide.model_execution.manifest_asset_ledger,
      { hashnano: shared.hashnano },
    )
  })

  it('still finds the entry when the request has moved past what is installed', () => {
    // requested_version is a REQUEST, free to name a version this profile has
    // not got yet. Demanding that it match the directory too would find
    // nothing here — and a profile that asks for no model does not load one.
    const ahead = { hash2b: { asset_id: 'gemma4_component', requested_version: '2026.9.9.9999' } }
    const guide = { model_execution: { manifest_asset_ledger: ahead } }
    assert.deepEqual(
      portableGuide(guide, DIRS.twoB).optimization_guide.model_execution.manifest_asset_ledger,
      { hash2b: ahead.hash2b },
    )
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

describe('chrome create failure', () => {
  // What Chrome says on its own is "The device is unable to create a session
  // to run the model. Please check the result of availability() first." —
  // which names neither the row nor the variant, and hands the caller an
  // instruction instead of an answer.
  const chromeSays = 'create failed: InvalidStateError: The device is unable to create a session to run the model.'
  // The page hands the name back beside the message, because the message is
  // the only place it appeared and every create failure carries an
  // availability reading — see the last test here.
  const refused = () => ({ name: 'InvalidStateError', message: chromeSays, availability: 'available' })

  it('names the row, the variant, and keeps the browser\'s own reason', () => {
    const error = refused()
    explainCreateFailure(error, 'chrome/gemma-4-12b-it', 'gemma4_12b')
    assert.match(error.message, /chrome\/gemma-4-12b-it/u)
    assert.match(error.message, /model_version\/v4_12b/u)
    // Chrome's text is kept rather than replaced — it is the only part that
    // improves if Chrome ever starts explaining itself.
    assert.match(error.message, /unable to create a session/u)
    // Not a missing model: availability() found it, so saying otherwise
    // sends the reader after the wrong thing.
    assert.match(error.message, /nothing is missing/u)
    assert.match(error.message, /chrome:\/\/on-device-internals/u)
  })

  it('says so when availability contradicts the failure', () => {
    // Chrome's message ends "check the result of availability() first", and
    // availability() answers `available`. Repeating that advice sends the
    // reader in a circle, so what is left to have failed is named instead.
    const error = refused()
    explainCreateFailure(error, 'chrome/gemma-4-12b-it', 'gemma4_12b')
    assert.match(error.message, /running the weights/u)
    assert.match(error.message, /too\s+large for this device/u)
  })

  it('says the plain thing when availability agrees with the failure', () => {
    const error = { ...refused(), availability: 'unavailable' }
    explainCreateFailure(error, 'chrome/gemma-4-12b-it', 'gemma4_12b')
    assert.match(error.message, /will not run the variant/u)
    assert.doesNotMatch(error.message, /nothing is missing/u)
  })

  it('does not invent a use case for the row that has none', () => {
    // nano answers the default use case, so there is no model_version to cite.
    const error = { ...refused(), availability: 'unavailable' }
    explainCreateFailure(error, 'chrome/gemini-nano-v3', 'nano_v3')
    assert.doesNotMatch(error.message, /model_version/u)
    assert.match(error.message, /chrome\/gemini-nano-v3/u)
  })

  it('leaves a create failure that is NOT the device refusal exactly as Chrome reported it', () => {
    // The catch in the page reads availability() for every create failure, so
    // the reading is not what makes one of them a device refusal. An
    // oversized history came back through here too, and was answered with a
    // story about a model too large for the machine and an assurance that
    // nothing was missing.
    const message = 'create failed: QuotaExceededError: The input is too large.'
    const error = { name: 'QuotaExceededError', message, availability: 'available' }
    explainCreateFailure(error, 'chrome/gemma-4-e2b-it', 'gemma4_2b')
    assert.equal(error.message, message)
  })
})

describe('chrome turn request', () => {
  it('carries a bound on create into the page, alongside the body', () => {
    // page.evaluate() has none of its own, so this is all that stands between
    // a model that never comes up and a caller that waits for the browser.
    const body = CHROME_SHAPE.buildRequestBody('chrome/gemma-4-e2b-it', 4096, 'sys', [{ role: 'user', content: 'go' }])
    const req = turnRequest(body)
    assert.ok(req.createTimeoutMs > 0, `expected a create bound, got ${req.createTimeoutMs}`)
    assert.equal(req.prompt, body.prompt)
    // The caller's body is theirs: it is the cache's view of the request.
    assert.equal(Object.hasOwn(body, 'createTimeoutMs'), false)
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

describe('chrome launch options', () => {
  const options = () => launchOptions('/some/model/dir', 'nano_v3')

  it('opens the context offline', () => {
    // Half of the no-network guarantee; --component-updater is the other half
    // and covers what a context option cannot.
    assert.equal(options().offline, true)
  })

  it('keeps the process sandbox on, and lets a caller with nowhere to put it opt out', (t) => {
    // Playwright's default is off, which for a page running someone's model
    // puts a renderer compromise in the caller's own account.
    assert.equal(options().chromiumSandbox, true)
    assert.ok(!launchArgs('/some/model/dir', 'nano_v3').some((arg) => arg.includes('no-sandbox')))
    t.after(() => { delete process.env.CHROME_SANDBOX })
    process.env.CHROME_SANDBOX = '0'
    assert.equal(options().chromiumSandbox, false)
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
  const build = (messages, opts) => CHROME_SHAPE.buildRequestBody('chrome/gemma-4-e2b-it', 4096, 'be terse', messages, opts)

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

  it('treats an empty tool list as no tools at all', () => {
    // `anyOf: []` is a constraint nothing can satisfy, so a request that
    // wanted no tools came back a Prompt API failure.
    const body = CHROME_SHAPE.buildRequestBody('chrome/gemma-4-e2b-it', 4096, 'sys', [{ role: 'user', content: 'go' }], { tools: [] })
    assert.equal(body.responseConstraint, undefined)
    assert.equal(body.initialPrompts[0].content, 'sys')
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
    const initial = (userContent) => CHROME_SHAPE.buildInitialUserMessage('chrome/gemma-4-e2b-it', userContent)
    // A list, which is what ask() passes now. Concatenating with `+` gave
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
    // The constraint parsed, but the args inside it did not — ask() ends the
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

  it('replays what the model SAID alongside the calls it made', () => {
    // The constraint requires both halves, so a turn can carry prose and
    // calls together. Reconstructing only the calls dropped the prose before
    // the next turn ever saw it.
    const messages = [{ role: 'user', content: 'go' }]
    const raw = JSON.stringify({
      text: 'Reading it now.',
      tool_calls: [{ name: 'read_file', arguments: { path: 'a.js' } }],
    })
    const json = toChatCompletions({ text: raw }, true)
    CHROME_SHAPE.appendToolResults(messages, json, CHROME_SHAPE.extractToolCalls(json), ['contents of a.js'])

    const replayed = JSON.parse(messages[1].content)
    assert.equal(replayed.text, 'Reading it now.')
    assert.deepEqual(replayed.tool_calls, [{ name: 'read_file', arguments: { path: 'a.js' } }])
  })

  it('threads a second turn back into a well-formed body', () => {
    const messages = [{ role: 'user', content: 'go' }]
    const json = toChatCompletions({ text: JSON.stringify({ tool_calls: [{ name: 'list_dir', arguments: {} }] }) }, true)
    CHROME_SHAPE.appendToolResults(messages, json, CHROME_SHAPE.extractToolCalls(json), ['a.js\nb.js'])
    const body = CHROME_SHAPE.buildRequestBody('chrome/gemma-4-e2b-it', 4096, 'sys', messages, { tools: TOOLS })
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
    // ask() hands calls to the caller's handler without revalidating — so a
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

describe('chrome launch failure', () => {
  // A browser that fails at a chosen step, and says whether it was closed.
  const browserFailingAt = (step) => {
    const state = { closed: false }
    const tab = {
      on() {},
      goto: () => (step === 'goto' ? Promise.reject(new Error('goto failed')) : Promise.resolve()),
    }
    return {
      state,
      newPage: () => (step === 'newPage' ? Promise.reject(new Error('newPage failed')) : Promise.resolve(tab)),
      close: () => { state.closed = true; return Promise.resolve() },
    }
  }

  for (const step of ['newPage', 'goto']) {
    it(`closes the browser when ${step} fails`, async () => {
      // Nothing else can: the rejected launch is dropped from the session map,
      // so closeProvider() never sees this browser, and an open Chrome holds
      // the process open.
      const browser = browserFailingAt(step)
      await assert.rejects(openTab(browser, tmpdir(), false))
      assert.equal(browser.state.closed, true)
    })
  }

  it('leaves the browser open when the tab comes up', async () => {
    const browser = browserFailingAt(undefined)
    assert.ok(await openTab(browser, tmpdir(), false))
    assert.equal(browser.state.closed, false)
  })
})

describe('chrome exit cleanup', () => {
  // Ctrl+C for real, in a process of its own: nothing else can say whether
  // the handler is wired to the signal rather than merely correct.
  const skip = process.platform === 'win32' ? 'signals are a POSIX thing' : false

  it('hands the process back once no profile of ours is left in it', () => {
    // Owning a process's signals for the rest of its life is not a library's
    // to do: while a profile exists there is something to clean up, and after
    // that the application's own handlers are the only ones that should run.
    const listening = () => process.listenerCount('SIGINT')
    const outside = listening()
    const profile = claimProfile('/nowhere')
    assert.ok(listening() > outside, 'should listen while a profile of ours exists')
    dropProfile(profile)
    assert.equal(listening(), outside, 'should have stopped listening')
    assert.equal(existsSync(profile), false)
  })

  it('does not hand the signal back to a process that is already handling it', { skip, timeout: 30_000 }, (t) => {
    // Re-sending is only how the default gets restored. An application's own
    // handler already had the original, and would run its shutdown twice.
    const out = join(mkdtempSync(join(tmpdir(), 'ai-chrome-test-signal-')), 'report')
    t.after(() => rmSync(dirname(out), { recursive: true, force: true }))
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
      import { appendFileSync, writeFileSync } from 'node:fs'
      import { claimProfile } from ${JSON.stringify(new URL('../src/chrome/index.js', import.meta.url).href)}
      writeFileSync(process.env.PROFILE_OUT, claimProfile('/nowhere'))
      let seen = 0
      process.on('SIGINT', () => {
        appendFileSync(process.env.PROFILE_OUT, \`\nseen \${++seen}\`)
        // Long enough for a second delivery to land if one is coming.
        if (seen === 1) setTimeout(() => process.exit(0), 300)
      })
      process.kill(process.pid, 'SIGINT')
      setInterval(() => {}, 1000)
    `], { encoding: 'utf8', timeout: 20_000, env: { ...process.env, PROFILE_OUT: out } })

    const report = readFileSync(out, 'utf8')
    assert.equal(report.match(/seen /gu)?.length, 1, `the application handler ran more than once: ${report}`)
    assert.equal(existsSync(report.split('\n')[0]), false, 'the profile should still have gone')
    assert.equal(child.status, 0, child.stderr)
  })

  it('refuses a scratch root it does not own outright', (t) => {
    // /tmp is world-writable and the name is predictable, so another account
    // can get there first. mkdir's mode only lands when it creates the
    // directory, and one already there is trusted otherwise.
    if (!process.getuid) return t.skip('ownership and mode are POSIX')
    const sandbox = mkdtempSync(join(tmpdir(), 'ai-chrome-test-root-'))
    const restore = {}
    t.after(() => {
      for (const [key, value] of Object.entries(restore)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(sandbox, { recursive: true, force: true })
    })
    for (const key of ['TMPDIR', 'TMP', 'TEMP']) {
      restore[key] = process.env[key]
      process.env[key] = sandbox
    }

    // A symlink where the root should be: mkdir -p follows it without
    // complaint, and every profile after would land wherever it points.
    const elsewhere = join(sandbox, 'elsewhere')
    mkdirSync(elsewhere)
    symlinkSync(elsewhere, profileRoot(), 'junction')
    assert.throws(() => claimProfile('/nowhere'), /not a directory/u)
    rmSync(profileRoot(), { force: true })

    mkdirSync(profileRoot(), { recursive: true })
    chmodSync(profileRoot(), 0o777)
    assert.throws(() => claimProfile('/nowhere'), /others can read or write/u)

    // And the same root, put right, is accepted.
    chmodSync(profileRoot(), 0o700)
    const profile = claimProfile('/nowhere')
    assert.equal(existsSync(profile), true)
    dropProfile(profile)
  })

  it('takes its profile with it when a signal ends the process', { skip, timeout: 30_000 }, (t) => {
    const out = join(mkdtempSync(join(tmpdir(), 'ai-chrome-test-signal-')), 'profile-path')
    t.after(() => rmSync(dirname(out), { recursive: true, force: true }))
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
      import { writeFileSync } from 'node:fs'
      import { claimProfile } from ${JSON.stringify(new URL('../src/chrome/index.js', import.meta.url).href)}
      // The path goes to a file rather than stdout: process.exit can drop a
      // pipe write, and this has to be readable after the process is gone.
      writeFileSync(process.env.PROFILE_OUT, claimProfile('/nowhere'))
      process.kill(process.pid, 'SIGINT')
      setInterval(() => {}, 1000)
    `], { encoding: 'utf8', timeout: 20_000, env: { ...process.env, PROFILE_OUT: out } })

    assert.equal(child.error, undefined, `child failed: ${child.error?.message}`)
    const profile = readFileSync(out, 'utf8')
    assert.match(profile, /chrome-/u, `expected a profile path, got ${profile}`)
    assert.equal(existsSync(profile), false, 'the profile should have gone with the process')
    // Killed by the signal, not exited with a code: the handler hands SIGINT
    // back once it has cleaned up, so the process ends the way it would have
    // with nothing listening at all.
    assert.equal(child.signal, 'SIGINT', child.stderr)
  })
})

describe('chrome idle close', () => {
  // Its own temp dir: the observable end of closeChrome with nothing open is
  // that it takes the shared directory, so that is what says it ran.
  const sandbox = mkdtempSync(join(tmpdir(), 'ai-chrome-test-idle-'))
  const restore = {}
  before(() => {
    for (const key of ['TMPDIR', 'TMP', 'TEMP']) {
      restore[key] = process.env[key]
      process.env[key] = sandbox
    }
    restore.CHROME_IDLE_MS = process.env.CHROME_IDLE_MS
    process.env.CHROME_IDLE_MS = '20'
  })
  after(() => {
    for (const [key, value] of Object.entries(restore)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(sandbox, { recursive: true, force: true })
  })

  const settle = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

  it('closes the browser once nothing has asked for a turn', async () => {
    mkdirSync(profileRoot(), { recursive: true })
    await trackTurn(() => Promise.resolve({ text: 'ok' }))
    assert.equal(existsSync(profileRoot()), true, 'closed before the idle window was up')
    await settle(120)
    assert.equal(existsSync(profileRoot()), false, 'should have closed itself')
  })

  it('does not close while turns keep arriving', async () => {
    mkdirSync(profileRoot(), { recursive: true })
    for (let i = 0; i < 4; i++) {
      await trackTurn(() => Promise.resolve({ text: 'ok' }))
      await settle(10)
    }
    assert.equal(existsSync(profileRoot()), true, 'a turn should push the close back')
    await settle(120)
    assert.equal(existsSync(profileRoot()), false)
  })

  it('leaves a turn that outlasts the window alone', async () => {
    mkdirSync(profileRoot(), { recursive: true })
    await trackTurn(() => Promise.resolve({ text: 'ok' }))
    let answer
    const slow = trackTurn(() => new Promise((resolve) => { answer = resolve }))
    await settle(120)
    assert.equal(existsSync(profileRoot()), true, 'closed under a turn still in flight')
    answer({ text: 'ok' })
    await slow
    await settle(120)
    assert.equal(existsSync(profileRoot()), false, 'and closes once that one is done')
  })

  it('counts the launch as pending, not only the turn in the page', async (t) => {
    // A cold launch takes longer than the window, so it has to hold the close
    // off too. Pointed at weights that are not there, so this fails inside the
    // launch — which still arms the close only because the launch is tracked.
    t.after(() => { delete process.env.CHROME_MODEL_DIR })
    process.env.CHROME_MODEL_DIR = join(sandbox, 'no-weights-here')
    mkdirSync(profileRoot(), { recursive: true })
    await assert.rejects(sendChromeTurn('chrome/gemini-nano-v3', {}), /CHROME_MODEL_DIR/u)
    await settle(120)
    assert.equal(existsSync(profileRoot()), false, 'a launch that failed should still arm the close')
  })
})

describe('chrome close while a turn is in flight', () => {
  it('waits for the turn instead of closing the browser under it', async () => {
    // Parallel callers share a browser, and each closes the provider when its
    // own turn returns. Closing on the first one to finish is what left the
    // rest with "Target page, context or browser has been closed".
    let answer
    const turn = trackTurn(() => new Promise((resolve) => { answer = resolve }))

    let closed = false
    const closing = closeChrome().then(() => { closed = true; return closed })
    await new Promise(setImmediate)
    assert.equal(closed, false, 'closed while a turn was still in flight')

    answer({ text: 'done' })
    await turn
    await closing
    assert.equal(closed, true)
  })
})

describe('chrome scratch-profile cleanup', () => {
  it('recognises only its own scratch profiles', () => {
    // The predicate, not the delete. Asking removeProfileDir to refuse ''
    // or '/' would, the day the guard regressed, delete the cwd or the root
    // from inside the test written to catch that — so nothing here calls a
    // function that can remove a file.
    for (const bad of ['', undefined, null, 0, {}, [], '/', '/tmp', tmpdir(),
      profileRoot(), join(profileRoot(), 'chrome-'), join(profileRoot(), 'notaprofile'),
      // Inside the temp dir but not inside ours, and inside a directory that
      // merely starts the same way.
      join(tmpdir(), 'chrome-abc123'), join(`${profileRoot()}-elsewhere`, 'chrome-abc123'),
      join(homedir(), 'preventive-ai', 'chrome-abc123')]) {
      assert.equal(isScratchProfile(bad), false, `should not accept ${JSON.stringify(bad)}`)
    }
    // A prefix test on the raw string accepts this, and rmSync resolves it.
    assert.equal(isScratchProfile(join(profileRoot(), 'chrome-abc123', '..', '..', 'elsewhere')), false)
    assert.equal(isScratchProfile(join(profileRoot(), 'chrome-abc123', 'nested')), false)
    assert.equal(isScratchProfile(join(profileRoot(), 'chrome-abc123')), true)
  })

  // The sweep runs on launch and deletes other processes' leftovers, so what
  // it spares matters as much as what it takes. Real directories under the
  // real temp dir, since it reads mtimes and pids off the filesystem.
  describe('the stale sweep', () => {
    const AGED = new Date(Date.now() - 7 * 60 * 60 * 1000)
    const aged = (owner) => {
      const dir = scratchProfile()
      if (owner !== undefined) writeFileSync(join(dir, 'owner.pid'), String(owner))
      utimesSync(dir, AGED, AGED)
      return dir
    }
    // A pid no process can have, so "not running" is a fact rather than a
    // guess about what else is on the machine.
    const deadPid = () => [4_194_305, 999_999, 99_999].find((pid) => {
      try { process.kill(pid, 0); return false } catch (err) { return err.code === 'ESRCH' }
    })

    it('leaves a profile alone while the process that made it is still running', (t) => {
      // Age does not mean abandoned: a session is meant to be reused, and the
      // profile ROOT's mtime stops moving as soon as Chrome settles into
      // writing inside it. On age alone, the next run deleted a live profile
      // out from under the first.
      const live = aged(process.pid)
      t.after(() => rmSync(live, { recursive: true, force: true }))
      sweepStaleProfiles()
      assert.equal(existsSync(live), true)
    })

    it('takes one whose owner is gone', (t) => {
      const pid = deadPid()
      // Only if the machine somehow has all three running; plain `assert`
      // calls are not what t.plan counts, so the skip stands on its own.
      if (pid === undefined) return t.skip('every candidate pid is in use')
      const abandoned = aged(pid)
      t.after(() => rmSync(abandoned, { recursive: true, force: true }))
      sweepStaleProfiles()
      assert.equal(existsSync(abandoned), false)
    })

    it('takes an aged profile from before the marker existed', (t) => {
      const old = aged(undefined)
      t.after(() => rmSync(old, { recursive: true, force: true }))
      sweepStaleProfiles()
      assert.equal(existsSync(old), false)
    })

    it('takes a profile of any age once its owner is gone', (t) => {
      // A marker whose process no longer exists settles it: nobody is coming
      // back for that directory, so it does not have to age out first — which
      // is how a Ctrl+C leftover used to sit around for six hours.
      const pid = deadPid()
      if (pid === undefined) return t.skip('every candidate pid is in use')
      const abandoned = scratchProfile()
      writeFileSync(join(abandoned, 'owner.pid'), String(pid))
      t.after(() => rmSync(abandoned, { recursive: true, force: true }))
      sweepStaleProfiles()
      assert.equal(existsSync(abandoned), false)
    })

    it('leaves a young profile alone, marker or not', (t) => {
      // The other half of why both conditions are needed: a profile made
      // moments ago has not written its marker yet, and reads as ownerless.
      const fresh = scratchProfile()
      t.after(() => rmSync(fresh, { recursive: true, force: true }))
      sweepStaleProfiles()
      assert.equal(existsSync(fresh), true)
    })

    it('reads only our own directory, so an unrelated temp dir is never a candidate', (t) => {
      // The whole reason profiles moved under one root: the sweep used to
      // readdir the temp dir itself, where everything on the machine lives.
      const bystander = mkdtempSync(join(tmpdir(), 'chrome-'))
      utimesSync(bystander, AGED, AGED)
      t.after(() => rmSync(bystander, { recursive: true, force: true }))
      sweepStaleProfiles()
      assert.equal(existsSync(bystander), true)
    })
  })

  it('removes a directory that IS one of ours', () => {
    const ours = scratchProfile()
    writeFileSync(join(ours, 'Local State'), '{}')
    removeProfileDir(ours)
    assert.equal(existsSync(ours), false)
  })

  describe('the shared directory', () => {
    // Pointed at a temp dir of its own, so what is or is not left in the
    // shared directory is this test's doing rather than the machine's.
    const sandbox = mkdtempSync(join(tmpdir(), 'ai-chrome-test-tmp-'))
    const restore = {}
    before(() => {
      for (const key of ['TMPDIR', 'TMP', 'TEMP']) {
        restore[key] = process.env[key]
        process.env[key] = sandbox
      }
    })
    after(() => {
      for (const [key, value] of Object.entries(restore)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(sandbox, { recursive: true, force: true })
    })

    it('goes once the last profile is out of it', () => {
      const ours = scratchProfile()
      removeProfileDir(ours)
      pruneProfileRoot()
      assert.equal(existsSync(profileRoot()), false)
    })

    it('stays while anything is still in it', (t) => {
      const other = scratchProfile()
      t.after(() => rmSync(other, { recursive: true, force: true }))
      pruneProfileRoot()
      assert.equal(existsSync(other), true, 'a live profile should not be taken')
      assert.equal(existsSync(profileRoot()), true)
    })
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
    symlinkSync(model, join(profile, 'OptGuideOnDeviceModel'), 'junction')

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
    assert.throws(() => chromePreflight(), /No on-device model found/u)
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

  it('runs two turns at once in the one tab', { skip, timeout: 20_000 }, async () => {
    // One browser and one tab serve every turn on a row, so turns have to be
    // able to overlap. Neither prompt here resolves until BOTH have started,
    // so a tab that ran them one after the other deadlocks rather than
    // passing slowly.
    await page.evaluate(`
      globalThis.__started = 0
      globalThis.__both = new Promise((resolve) => { globalThis.__release = resolve })
      globalThis.LanguageModel = {
        availability: async () => 'available',
        create: async () => ({
          contextUsage: 0,
          contextWindow: 8192,
          prompt: async (text) => {
            if (++globalThis.__started === 2) globalThis.__release()
            await globalThis.__both
            return \`answered \${text}\`
          },
          destroy() {},
        }),
      }`)
    const turn = (prompt) => page.evaluate(turnInPage, { initialPrompts: [], prompt })
    assert.deepEqual(
      (await Promise.all([turn('a'), turn('b')])).map((r) => r.text),
      ['answered a', 'answered b'],
    )
  })

  it('passes the constraint through and shapes tool calls out of the answer', { skip }, async () => {
    await page.evaluate(STUB('JSON.stringify({ text: "", tool_calls: [{ name: options.responseConstraint.properties.tool_calls.items.anyOf[0].properties.name.enum[0], arguments: {} }] })'))
    const body = CHROME_SHAPE.buildRequestBody('chrome/gemma-4-e2b-it', 4096, 'sys', [{ role: 'user', content: 'go' }], { tools: TOOLS })
    const json = toChatCompletions(await page.evaluate(turnInPage, body), true)
    assert.deepEqual(CHROME_SHAPE.extractToolCalls(json), [{ id: 'call_0', name: 'read_file', args: {} }])
  })

  it('serves a turn while availability() still says unavailable', { skip }, async () => {
    // Why there is no availability() gate: it answers `unavailable` for a
    // model that is merely unloaded, and only create() loads one.
    await page.evaluate(`
      globalThis.__creates = 0
      globalThis.LanguageModel = {
        availability: async () => 'unavailable',
        create: async () => {
          globalThis.__creates++
          await new Promise((r) => setTimeout(r, 50))
          return { prompt: async () => 'answered', destroy() {} }
        },
      }`)
    const result = await page.evaluate(turnInPage, { initialPrompts: [], prompt: 'x' })
    assert.equal(result.text, 'answered')
    // One session, and the turn's own: a load this slow used to be paid twice.
    assert.equal(await page.evaluate(() => globalThis.__creates), 1)
  })

  it('watches no download, because there is never one to watch', { skip }, async () => {
    // This provider only ever runs weights Chrome already has, so it registers
    // no `monitor` — and an earlier version that did aborted every legitimate
    // load about ten seconds in, because `downloadprogress` also fires while
    // Chrome prepares weights it already has.
    await page.evaluate(`
      globalThis.__sawMonitor = null
      globalThis.LanguageModel = {
        availability: async () => 'unavailable',
        create: async (options) => {
          globalThis.__sawMonitor = Object.hasOwn(options, 'monitor')
          return { prompt: async () => 'ok', destroy() {} }
        },
      }`)
    await page.evaluate(turnInPage, { initialPrompts: [], prompt: 'x' })
    assert.equal(await page.evaluate(() => globalThis.__sawMonitor), false)
  })

  it('gives up on a create that never settles, and drops the session it was owed', { skip, timeout: 10_000 }, async () => {
    // Without this the caller waits as long as the browser lives, and the
    // session that arrives late has nothing left holding it.
    await page.evaluate(`
      globalThis.__destroyed = false
      globalThis.__settle = null
      globalThis.LanguageModel = {
        availability: async () => 'available',
        create: () => new Promise((resolve) => {
          globalThis.__settle = () => resolve({ destroy() { globalThis.__destroyed = true } })
        }),
      }`)
    const result = await page.evaluate(turnInPage, { initialPrompts: [], prompt: 'x', createTimeoutMs: 50 })
    assert.match(result.error.message, /never settled within 0\.05s/u)
    assert.equal(await page.evaluate(async () => {
      globalThis.__settle()
      await new Promise((r) => { setTimeout(r, 0) })
      return globalThis.__destroyed
    }), true, 'the session that arrived late should have been destroyed')
  })

  it('reports a Chromium with no Prompt API as such', { skip }, async () => {
    await page.evaluate('delete globalThis.LanguageModel')
    const result = await page.evaluate(turnInPage, { initialPrompts: [], prompt: 'x' })
    assert.match(result.error.message, /not a branded Chrome/u)
  })
})
