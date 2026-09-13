import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { baseModelFor, modelVersionFor } from '../models.js'
import { findModelDir, graftPlan, localStateFor } from './model.js'
import { explainCreateFailure, outputLanguage, toChatCompletions } from './wire.js'

// One entry point for the provider: providers.js wires the adapter from here.
export { chromePreflight, findModelDir, localStateFor } from './model.js'
export { CHROME_SHAPE } from './wire.js'

// Chrome's built-in Prompt API (developer.chrome.com/docs/ai/prompt-api),
// driven over CDP by playwright-core. No key, no URL, no network. Zero
// dependencies, no bundled browsers, and `channel: 'chrome'` resolves the
// branded Chrome already installed.
//
// Branded Chrome only. Chromium builds compile the API in but expose no
// binding under any flag, and Chrome for Testing exposes it while pinning the
// device performance class to kGpuBlocked (#if BUILDFLAG(CHROME_FOR_TESTING)),
// leaving only a CPU backend most machines do not have.
//
// Two constraints shape the rest.
//
// The weights are never ours to download. Chrome keeps the model under the
// USER DATA DIR (component_updater's DIR_COMPONENT_USER) rather than the
// profile inside it, so a scratch --user-data-dir sees nothing and pulls its
// own ~4 GB copy. This borrows the resident one.
//
// No server. `LanguageModel` needs a secure context, and about:blank and
// data: URLs are opaque origins where it is absent. file:// is potentially
// trustworthy, so the page is file:///dev/null.

// Playwright's own disabled-feature list, minus `OptimizationHints`
// ("Prevents downloading optimization hints on startup"). The on-device model
// hangs off that same keyed service: with it off the model service never
// starts and availability() answers `unavailable` forever. --enable-features
// cannot undo it, since FeatureList gives disable precedence, so the list is
// re-sent without that entry — Chrome reads the last occurrence of a switch,
// and playwright appends rather than merges.
//
// Mirrors playwright 1.63. Drift is benign: nothing here needs any of them.
const DISABLED_FEATURES = [
  'AvoidUnnecessaryBeforeUnloadCheckSync', 'DestroyProfileOnBrowserClose', 'DialMediaRouteProvider',
  'GlobalMediaControls', 'HttpsUpgrades', 'LensOverlay', 'MediaRouter', 'PaintHolding',
  'ThirdPartyStoragePartitioning', 'BlockOriginHeaderModificationOnRedirect', 'Translate',
  'AutoDeElevate', 'msForceBrowserSignIn', 'msEdgeUpdateLaunchServicesPreferredVersion',
]

// The enable side takes the opposite treatment. Playwright appends its
// --enable-features AFTER ours, so leaving it in place discards everything we
// add: theirs is dropped and ours carries their entry.
//
// ignoreDefaultArgs matches by exact string (`indexOf(arg) === -1`), hence the
// whole switch rather than its name. Should playwright change that string,
// the filter stops matching and the gemma rows silently revert to Chrome's
// default variant.
const PLAYWRIGHT_ENABLE_FEATURES = '--enable-features=CDPScreenshotNewSurface'

const ENABLED_FEATURES = [
  'CDPScreenshotNewSurface',
  'OptimizationGuideOnDeviceModel:on_device_model_bypass_perf_requirement/true',
]

// Which Gemma answers. The Prompt API does not ask for a model, it asks for a
// USE CASE, and the manifest Google delivers maps them:
//
//   PromptApiFeatureConfig {
//     default_use_case: "prompt_api"
//     experimental_use_cases: { "v4":    "prompt_api_gemma4"
//                               "v4_4b": "prompt_api_gemma4_4b"
//                               "v4_12b":"prompt_api_gemma4_12b" }
//   }
//
// AIApiFoundationalModel:model_version is a KEY into that map, so the param
// picks the variant. chrome://flags/#gemma4-for-built-in-ai cannot: it hard
// codes v4. The two features the flag also enables are therefore passed
// alongside it — 153 expands the flag to exactly these plus model_version,
// 155 to these minus the LiteRT-LM backend, its default runtime there. A
// feature name Chrome does not know is ignored, so one list serves both.
const GEMMA4_FEATURES = ['OptimizationGuideManifestBroker', 'OnDeviceModelLitertLmBackend']

function enabledFeatures(baseModel) {
  const version = modelVersionFor(baseModel)
  // v3 is Gemini Nano: the default use case, which needs none of this.
  if (!version || version === 'v3') return ENABLED_FEATURES
  return [...ENABLED_FEATURES, `AIApiFoundationalModel:model_version/${version}`, ...GEMMA4_FEATURES]
}

// Playwright's software-GL defaults. Both have to go for Chrome to reach a
// real GPU; see launchPersistentContext for why that is not optional.
const SOFTWARE_GL = ['--enable-unsafe-swiftshader', '--use-angle=swiftshader-webgl']

export const IGNORED_DEFAULT_ARGS = [...SOFTWARE_GL, PLAYWRIGHT_ENABLE_FEATURES]


// CHROME_CHANNEL takes playwright's channel names: chrome, chrome-beta,
// chrome-dev, chrome-canary.
export function chromeTarget() {
  if (process.env.CHROME_PATH) return { executablePath: process.env.CHROME_PATH }
  return { channel: process.env.CHROME_CHANNEL || 'chrome' }
}


// A secure origin with no server behind it. /dev/null is not a thing on
// Windows, so there the scratch profile gets an empty page of its own.
function blankPage(profile) {
  if (process.platform !== 'win32') return 'file:///dev/null'
  const page = join(profile, 'blank.html')
  writeFileSync(page, '<!doctype html><meta charset="utf-8"><title>ai</title>')
  return pathToFileURL(page).href
}

// An optional peer, loaded on demand, so a caller on the hosted providers
// never pays for a browser driver it will not use. The bare module-not-found
// names neither the package nor the reason it is wanted.
async function loadPlaywright() {
  try {
    return await import('playwright-core')
  } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err
    throw new Error('The `chrome` provider needs playwright-core: install it alongside this package (it is an optional peer dependency).', { cause: err })
  }
}

// Scratch profiles, so they can be removed again. Removing one never touches
// the model: the component tree inside it is a SYMLINK, and a recursive
// delete unlinks the link rather than following it.
const profiles = new Set()

// One directory of our own inside the temp dir, so the sweep reads it rather
// than everything the machine has put there. Recomputed per call, so it
// follows TMPDIR.
const PROFILE_ROOT = 'preventive-ai'
const PROFILE_PREFIX = 'chrome-'
const profileRoot = () => join(tmpdir(), PROFILE_ROOT)

// Old enough that a profile made moments ago, before its owner marker was
// written, cannot be mistaken for one left behind.
const STALE_MS = 6 * 60 * 60 * 1000

// Lets another process sweeping the temp dir tell a profile in use from one
// left behind. Chrome ignores files it does not know at the profile root.
const OWNER_FILE = 'owner.pid'

// The guard on the single place this file deletes anything recursively. A
// profile holds a symlink into the user's model store, so a wrong path here
// is gigabytes of somebody else's data.
//
// starts-with, not contains: every profile is built by mkdtemp from exactly
// this prefix inside exactly that directory, which rules out a path that
// merely has the name somewhere inside it.
export function isScratchProfile(dir) {
  const root = join(profileRoot(), PROFILE_PREFIX)
  return typeof dir === 'string' && dir.startsWith(root) && dir.length > root.length
}

export function removeProfileDir(dir) {
  assert.ok(
    isScratchProfile(dir),
    `refusing to recursively delete a path that is not one of our scratch profiles (expected ${join(profileRoot(), PROFILE_PREFIX)}*): ${dir}`,
  )
  rmSync(dir, { recursive: true, force: true })
}

// Take the shared directory too, once it is empty. Non-recursive, so a
// profile still in it — this process's or another's — is ENOTEMPTY and stays.
export function pruneProfileRoot() {
  try { rmdirSync(profileRoot()) } catch { /* still in use, or already gone */ }
}

function dropProfile(dir) {
  profiles.delete(dir)
  try { removeProfileDir(dir) } catch { /* already gone, or not ours to touch */ }
}

// A session has no lifetime, and the profile ROOT's mtime stops moving once
// Chrome is writing inside it, so age alone cannot tell a live profile from
// an abandoned one. EPERM means a process by that number exists and belongs
// to someone else — still a reason to leave the directory alone.
function ownerAlive(dir) {
  let pid
  try { pid = Number(readFileSync(join(dir, OWNER_FILE), 'utf8')) } catch { return false }
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (err) { return err.code === 'EPERM' }
}

// Best effort, on launch: clear what earlier runs left behind. Both
// conditions are needed — liveness alone takes a profile whose owner has not
// written its marker yet, age alone takes profiles still in use.
export function sweepStaleProfiles() {
  const now = Date.now()
  let dirs = []
  try { dirs = readdirSync(profileRoot()).filter((n) => n.startsWith(PROFILE_PREFIX)) } catch { return }
  for (const name of dirs) {
    const dir = join(profileRoot(), name)
    if (profiles.has(dir)) continue
    try {
      if (now - statSync(dir).mtimeMs > STALE_MS && !ownerAlive(dir)) removeProfileDir(dir)
    } catch { /* in use, or gone */ }
  }
}

// A crash, or a bare `node script.js`, never reaches closeProvider. rmSync is
// synchronous, so an exit hook can still finish the job.
let exitHookInstalled = false
function installExitCleanup() {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.on('exit', () => {
    for (const dir of profiles) {
      try { removeProfileDir(dir) } catch { /* exiting anyway */ }
    }
    pruneProfileRoot()
  })
}

// One browser per base model: the weights directory is named on the command
// line, so two rows backed by different weights cannot share one.
const sessions = new Map()

async function launch(baseModel, debug) {
  // Throws when the row's weights are not installed, naming what is.
  const modelDir = findModelDir(baseModel)
  // A persistent context rather than launch(): the profile has to exist
  // before Chrome starts so the component tree can be grafted into it.
  sweepStaleProfiles()
  installExitCleanup()
  mkdirSync(profileRoot(), { recursive: true })
  const profile = mkdtempSync(join(profileRoot(), PROFILE_PREFIX))
  profiles.add(profile)
  // Before anything slow, so a concurrent sweep can already see an owner.
  writeFileSync(join(profile, OWNER_FILE), String(process.pid))
  writeFileSync(join(profile, 'Local State'), JSON.stringify(localStateFor(modelDir)))
  // Everything below can throw — a missing peer, a browser that will not
  // start, a page that will not navigate — and the profile goes with it. The
  // sweep skips young directories, so a stray would sit there until it ages.
  try {
    return await openBrowser(profile, modelDir, baseModel, debug)
  } catch (err) {
    dropProfile(profile)
    throw err
  }
}

// Order matters only for --use-angle and the two feature lists, which
// deliberately come after playwright's.
export function launchArgs(modelDir, baseModel) {
  return [
    // Playwright re-adds --use-angle outside the ignorable set, so it has to
    // be overridden rather than dropped; `default` hands the backend choice
    // back to Chrome.
    '--use-angle=default',
    // Besides naming the borrowed weights, this waives the base-model version
    // check Chrome applies to a profile that has registered no component of
    // its own.
    `--optimization-guide-ondevice-model-execution-override=${modelDir}`,
    // Both lists replace playwright's.
    `--disable-features=${DISABLED_FEATURES.join(',')}`,
    `--enable-features=${enabledFeatures(baseModel).join(',')}`,
    // Eligibility needs a device performance class, and a profile without one
    // runs a GPU benchmark to get it while availability() answers
    // `unavailable`. Forcing the class skips the benchmark.
    //
    // The value is an INTEGER: Chrome parses it with StringToInt, and a name
    // becomes kUnknown, indistinguishable from not passing the switch. 6 is
    // VeryHigh (0 Unknown, 1 Error, 2 VeryLow, 3 Low, 4 Medium, 5 High,
    // 6 VeryHigh), numbered by the UMA enum rather than declaration order.
    `--optimization-guide-performance-class=${process.env.CHROME_PERFORMANCE_CLASS || '6'}`,
    // Never fetch a model. Asking for Gemma 4 turns on the manifest broker,
    // which will go and get whichever Gemma it decides the machine should
    // run — gigabytes, written through the grafted symlinks into the user's
    // REAL component directories.
    //
    // --disable-component-update does not cover that: playwright passes it
    // already, and the broker registers its assets at runtime. The
    // configurator does, since every component fetch goes through it whoever
    // registered the component. Port 1 is on Chrome's restricted list, so an
    // attempt dies locally as ERR_UNSAFE_PORT — no socket, no DNS, no proxy.
    //
    // Resident weights are unaffected: they load from the override directory
    // above rather than being fetched. A model that is genuinely missing
    // stays missing, which chromePreflight says outright.
    '--component-updater=url-source=http://127.0.0.1:1/no-downloads',
    ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
  ]
}


async function openBrowser(profile, modelDir, baseModel, debug) {
  // The override switch is what Chrome reads to load the model, but the
  // component installer decides whether anything is MISSING, and a profile
  // that looks complete starts no download. Best effort: the switch alone
  // suffices, so a filesystem that refuses a link is not fatal.
  for (const { from, rel } of graftPlan(modelDir)) {
    try {
      mkdirSync(join(profile, dirname(rel)), { recursive: true })
      symlinkSync(from, join(profile, rel), 'junction')
    } catch { /* the switch covers us */ }
  }
  const { chromium } = await loadPlaywright()
  const browser = await chromium.launchPersistentContext(profile, {
    ...chromeTarget(),
    headless: process.env.CHROME_HEADLESS !== '0',
    // Playwright forces a software rasterizer for deterministic rendering.
    // Every on-device model Chrome ships is GPU-tier, so under SwiftShader the
    // on_device_model service never starts: availability() reads
    // `unavailable` and create() says "the service is not running".
    ignoreDefaultArgs: IGNORED_DEFAULT_ARGS,
    args: launchArgs(modelDir, baseModel),
    // Nothing here needs the network: the page is file:///dev/null and the
    // model is on disk, so a socket is a symptom and should fail rather than
    // succeed quietly. On the context, so every page inherits it. Does NOT
    // cover the component updater, which is a browser-process fetch — that is
    // what --component-updater=url-source is for, in launchArgs.
    offline: true,
  })
  const tab = await browser.newPage()
  // evaluate() hands back the value and nothing the page logged on the way.
  if (debug) {
    tab.on('console', (msg) => { if (!isBoilerplate(msg.text())) console.debug(`[chrome] ${msg.text()}`) })
    tab.on('pageerror', (err) => console.error(`[chrome] ${err}`))
  }
  await tab.goto(blankPage(profile))
  // Otherwise a failed launch leaves its window open, and the next attempt
  // opens another beside it.
  try {
    await waitUntilReady(tab, debug)
  } catch (err) {
    await browser.close().catch(() => {})
    throw err
  }
  return { browser, tab, profile }
}

// A cold profile has to register the component before Chrome will admit to
// having a model, and that is tens of seconds.
const READY_TIMEOUT_MS = 120_000

/* eslint-disable no-undef */
// Warm the model by asking for a session, which is the only thing that loads
// it. availability() cannot be polled here: in a cold profile it answers
// `unavailable` until the model is loaded, so the wait would block on a state
// only the call it gates can produce. One throwaway session is the whole
// wait, since create() does not return until the model is loaded or it
// fails.
export async function waitUntilReady(tab, debug) {
  const outcome = await tab.evaluate(async ({ lang, timeoutMs }) => {
    if (typeof LanguageModel === 'undefined') return 'no-binding'
    // Bounded in the page, beside the call it bounds.
    const expired = new Promise((resolve) => { setTimeout(() => resolve('timeout'), timeoutMs) })
    try {
      const probe = await Promise.race([
        LanguageModel.create({ expectedOutputs: [{ type: 'text', languages: [lang] }] }),
        expired,
      ])
      if (probe === 'timeout') return 'timeout'
      probe.destroy()
      return 'ready'
    } catch (err) {
      return `${err.name}: ${err.message}`
    }
  }, { lang: outputLanguage(), timeoutMs: READY_TIMEOUT_MS })
  if (outcome === 'ready') {
    if (debug) console.debug('[chrome] model warm')
    return
  }
  if (outcome === 'no-binding') throw new Error('LanguageModel is not exposed — this is not a branded Chrome')
  if (outcome === 'timeout') throw new Error(`On-device model never became usable within ${READY_TIMEOUT_MS / 1000}s`)
  throw new Error(`On-device model could not start: ${outcome}`)
}
/* eslint-enable no-undef */

// Reused across turns: no turn leaves state behind on the browser side, since
// each creates and destroys its own LanguageModel session.
function ensureSession(baseModel, debug) {
  if (!sessions.has(baseModel)) {
    // A rejected promise left in the map would be handed to every later turn,
    // failing the rest of the run instantly.
    const pending = launch(baseModel, debug)
    pending.catch(() => sessions.delete(baseModel))
    sessions.set(baseModel, pending)
  }
  return sessions.get(baseModel)
}

export async function closeChrome() {
  const open = [...sessions.values()]
  sessions.clear()
  const shut = async (pending) => {
    // A launch that rejected already surfaced to its caller; raising it again
    // here would go unhandled.
    const live = await pending.catch(() => null)
    if (!live) return
    await live.browser.close().catch(() => {})
    dropProfile(live.profile)
  }
  await Promise.all(open.map(shut))
  pruneProfileRoot()
}

// Chrome greets every page that touches the Prompt API with a feedback
// banner. Filtered by content rather than by silencing the console, since a
// real message from the page is what --debug is for.
const BOILERPLATE = /uses Chrome's Built-In AI features/u

const isBoilerplate = (text) => BOILERPLATE.test(text)

// Runs inside the page: serialized across, so it closes over nothing and
// takes everything as one argument. Exported so it can be run against a page
// holding a stub in place of `LanguageModel`; package.json's `exports` map
// does not expose this file, so that seam reaches no consumer.
/* eslint-disable no-undef */
export async function turnInPage(req) {
  if (typeof LanguageModel === 'undefined') {
    return { error: { message: 'LanguageModel is not exposed — this is not a branded Chrome' } }
  }
  // No availability() gate: it reports `unavailable` for a model that is
  // merely unloaded, which would refuse turns the browser can serve. A
  // create() that cannot work fails below with the browser's own reason.
  let ses
  const createStarted = performance.now()
  let createdAt = 0
  try {
    ses = await LanguageModel.create({
      initialPrompts: req.initialPrompts,
      // Without this Chrome warns "An output language should be specified to
      // ensure optimal output quality and properly attest to output safety."
      expectedOutputs: [{ type: 'text', languages: [req.language] }],
    })
    createdAt = performance.now() - createStarted
  } catch (err) {
    // Chrome's message for the interesting failure ends "Please check the
    // result of availability() first", so do that and report the answer
    // rather than passing the instruction on. `unavailable` here means the
    // device will not run the variant asked for, not the merely-unloaded
    // state waitUntilReady has already cleared. The option is repeated
    // because a bare availability() logs "No output language was specified in
    // a LanguageModel API request".
    const availability = await LanguageModel
      .availability({ expectedOutputs: [{ type: 'text', languages: [req.language] }] })
      .catch((e) => `unreadable (${e.name})`)
    return { error: { name: err.name, message: `create failed: ${err.name}: ${err.message}`, availability } }
  }
  const before = ses.contextUsage ?? 0
  try {
    const options = req.responseConstraint ? { responseConstraint: req.responseConstraint } : undefined
    // The prompt itself is INPUT, and the post-prompt delta covers prompt,
    // constraint context and generated text together, so measuring it
    // separately is what keeps it out of the completion count.
    let promptTokens = 0
    try { promptTokens = await ses.measureContextUsage(req.prompt, options) ?? 0 } catch { promptTokens = 0 }
    const started = performance.now()
    const text = await ses.prompt(req.prompt, options)
    const delta = Math.max((ses.contextUsage ?? 0) - before, 0)
    return {
      text,
      usage: { prompt_tokens: before + promptTokens, completion_tokens: Math.max(delta - promptTokens, 0) },
      contextWindow: ses.contextWindow ?? null,
      // "Slow" here has two causes: create() pays to load gigabytes into the
      // GPU the first time, prompt() is the generation. One is amortised
      // across a run, the other is not.
      createMs: Math.round(createdAt),
      promptMs: Math.round(performance.now() - started),
    }
  } catch (err) {
    return { error: { message: `${err.name}: ${err.message}` } }
  } finally {
    ses.destroy()
  }
}
/* eslint-enable no-undef */


export async function sendChromeTurn(model, body, { debug, label } = {}) {
  const baseModel = baseModelFor(model)
  // Undefined means the registry has no chrome/* row for this id, so which
  // local weights were meant is unknowable. Launching anyway would answer an
  // anthropic/* id, or a typo, with whatever happens to be installed.
  assert.ok(baseModel, `Provider \`chrome\` cannot serve ${model}. Use one of the chrome/* models.`)
  const launched = Date.now()
  const session = await ensureSession(baseModel, debug)
  const { tab } = session
  const startup = Date.now() - launched
  if (debug && label) console.debug(`[debug] ${label}`)
  const result = await tab.evaluate(turnInPage, body)
  if (result.error?.availability) explainCreateFailure(result.error, model, baseModel)
  if (debug) {
    // A cold run pays for browser startup, component registration and the
    // first load of the weights; only the last number is the model working.
    console.debug(`[chrome] startup=${startup}ms create=${result.createMs ?? '-'}ms prompt=${result.promptMs ?? '-'}ms`)
  }
  return toChatCompletions(result, Boolean(body.responseConstraint))
}
