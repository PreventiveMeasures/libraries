import assert from 'node:assert/strict'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { baseModelFor, modelVersionFor } from '../models.js'
import { findModelDir, graftPlan } from './model.js'
import { claimProfile, dropProfile, pruneProfileRoot } from './profile.js'
import { explainCreateFailure, outputLanguage, toChatCompletions } from './wire.js'

// One entry point for the provider: providers.js wires the adapter from here.
export { chromePreflight, findModelDir, localStateFor } from './model.js'
export { claimProfile, isScratchProfile, pruneProfileRoot, removeProfileDir, sweepStaleProfiles } from './profile.js'
export { CHROME_SHAPE } from './wire.js'

// Chrome's built-in Prompt API (developer.chrome.com/docs/ai/prompt-api) over
// CDP, via playwright-core. Branded Chrome only: Chromium exposes no binding
// under any flag, and Chrome for Testing pins the device performance class to
// kGpuBlocked, leaving a CPU backend most machines do not have.

// Playwright's own list, minus `OptimizationHints`: the on-device model hangs
// off that keyed service, and with it off the model service never starts.
// A disable cannot be undone by --enable-features, so the list is re-sent.
const DISABLED_FEATURES = [
  'AvoidUnnecessaryBeforeUnloadCheckSync', 'DestroyProfileOnBrowserClose', 'DialMediaRouteProvider',
  'GlobalMediaControls', 'HttpsUpgrades', 'LensOverlay', 'MediaRouter', 'PaintHolding',
  'ThirdPartyStoragePartitioning', 'BlockOriginHeaderModificationOnRedirect', 'Translate',
  'AutoDeElevate', 'msForceBrowserSignIn', 'msEdgeUpdateLaunchServicesPreferredVersion',
]

// The enable side, the other way round: playwright appends its own AFTER ours
// and Chrome reads the last occurrence, so theirs is dropped and ours carries
// its entry. ignoreDefaultArgs matches by exact string, hence the whole switch.
const PLAYWRIGHT_ENABLE_FEATURES = '--enable-features=CDPScreenshotNewSurface'

const ENABLED_FEATURES = [
  'CDPScreenshotNewSurface',
  'OptimizationGuideOnDeviceModel:on_device_model_bypass_perf_requirement/true',
]

// Which Gemma answers: the Prompt API asks for a USE CASE, and
// AIApiFoundationalModel:model_version keys the manifest's map of them
// (v4 -> prompt_api_gemma4, v4_4b -> ..._4b, v4_12b -> ..._12b). The
// chrome://flags entry only ever says v4, so its features come from here.
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


// `LanguageModel` needs a secure context, and about:blank and data: URLs are
// opaque origins where it is absent — but file:// is potentially trustworthy.
// /dev/null is not a thing on Windows, so there the profile gets a page.
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


// One browser per base model: the weights directory is named on the command
// line, so two rows backed by different weights cannot share one.
const sessions = new Map()


async function launch(baseModel, debug) {
  // Throws when the row's weights are not installed, naming what is.
  const modelDir = findModelDir(baseModel)
  // A persistent context rather than launch(): the profile has to exist
  // before Chrome starts so the component tree can be grafted into it.
  const profile = claimProfile(modelDir, baseModel)
  // Everything below can throw — a missing peer, a browser that will not
  // start, a page that will not navigate — and the profile goes with it.
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
    // Eligibility needs a performance class, and a profile without one runs a
    // GPU benchmark for it while availability() answers `unavailable`. An
    // INTEGER: a name parses to kUnknown. 6 is VeryHigh (0 Unknown, 1 Error,
    // 2 VeryLow, 3 Low, 4 Medium, 5 High, 6 VeryHigh).
    `--optimization-guide-performance-class=${process.env.CHROME_PERFORMANCE_CLASS || '6'}`,
    // Never fetch a model: the manifest broker would pull gigabytes through
    // the grafted symlinks into the user's REAL component tree.
    // --disable-component-update misses it — it registers at runtime — but
    // every fetch goes through the configurator, and port 1 is restricted.
    '--component-updater=url-source=http://127.0.0.1:1/no-downloads',
  ]
}

// What the browser is launched with, out here for the same reason the switch
// list is: a guarantee nothing asserts is a guarantee until someone edits it.
export function launchOptions(modelDir, baseModel) {
  return {
    ...chromeTarget(),
    headless: process.env.CHROME_HEADLESS !== '0',
    // Playwright forces a software rasterizer. Every on-device model Chrome
    // ships is GPU-tier, so under SwiftShader the model service never starts:
    // create() answers "the service is not running".
    ignoreDefaultArgs: IGNORED_DEFAULT_ARGS,
    args: launchArgs(modelDir, baseModel),
    // Playwright turns the process sandbox OFF by default, which lands a
    // renderer compromise in the caller's own account. On, unless there is
    // nowhere to put it — as root, or in a container without user namespaces,
    // Chrome refuses to start and CHROME_SANDBOX=0 is the way out.
    chromiumSandbox: process.env.CHROME_SANDBOX !== '0',
    // Nothing here needs the network: a file:// page and a model on disk, so a
    // socket is a symptom. Does NOT cover the component updater, which is a
    // browser-process fetch — see --component-updater in launchArgs.
    offline: true,
  }
}


async function openBrowser(profile, modelDir, baseModel, debug) {
  // The override switch loads the model, but the component installer decides
  // whether anything is MISSING, and a complete-looking profile starts no
  // download. Best effort: the switch alone suffices.
  for (const { from, rel } of graftPlan(modelDir)) {
    try {
      mkdirSync(join(profile, dirname(rel)), { recursive: true })
      symlinkSync(from, join(profile, rel), 'junction')
    } catch { /* the switch covers us */ }
  }
  const { chromium } = await loadPlaywright()
  const browser = await chromium.launchPersistentContext(profile, launchOptions(modelDir, baseModel))
  return { browser, tab: await openTab(browser, profile, debug), profile }
}

// Everything between a browser existing and a turn being possible, all of it
// inside the close: a launch that rejects is dropped from `sessions`, so
// anything left open is unreachable, holds a window, and keeps node alive.
export async function openTab(browser, profile, debug) {
  try {
    const tab = await browser.newPage()
    // evaluate() hands back the value and nothing the page logged on the way.
    if (debug) {
      tab.on('console', (msg) => { if (!isBoilerplate(msg.text())) console.debug(`[chrome] ${msg.text()}`) })
      tab.on('pageerror', (err) => console.error(`[chrome] ${err}`))
    }
    await tab.goto(blankPage(profile))
    await waitUntilReady(tab, debug)
    return tab
  } catch (err) {
    await browser.close().catch(() => {})
    throw err
  }
}

// A cold profile has to register the component before Chrome will admit to
// having a model, and that is tens of seconds.
const READY_TIMEOUT_MS = 120_000

/* eslint-disable no-undef */
// Warm the model by asking for a session, the only thing that loads it.
// availability() cannot be polled: it answers `unavailable` until the model is
// loaded, so the wait would block on what the call it gates would produce.
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

// Everything a close has to wait for: the turn in the page, and the launch a
// turn is still waiting on. One browser and one tab serve a whole row, so
// closing on the first caller to finish takes the tab from under the rest.
const turns = new Set()

// How long the browser sits with nothing in flight or pending before closing
// itself. A caller that never reaches closeProvider stops paying for one, and
// node can exit, which an open browser otherwise prevents. Read per arm, so a
// caller can set its own — 0 keeps the browser until closeProvider says so.
const idleMs = () => Number(process.env.CHROME_IDLE_MS ?? 10_000)

let idleClose
function armIdleClose() {
  clearTimeout(idleClose)
  const ms = idleMs()
  if (!(ms > 0)) return
  // unref'd, so the timer is never itself what keeps the process alive.
  idleClose = setTimeout(() => {
    if (turns.size === 0) closeChrome().catch(() => {})
  }, ms)
  idleClose.unref?.()
}

export function trackTurn(work) {
  clearTimeout(idleClose)
  const turn = Promise.resolve().then(work)
  turns.add(turn)
  return turn.finally(() => {
    turns.delete(turn)
    if (turns.size === 0) armIdleClose()
  })
}

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
  clearTimeout(idleClose)
  // Close when idle, not on demand: a caller finishing its turn while another
  // is still mid-flight would otherwise close that one's browser. A turn
  // started during the drain keeps it going, which is the same promise.
  while (turns.size > 0) await Promise.allSettled([...turns])
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

// Runs inside the page: serialized across, so it closes over nothing and takes
// everything as one argument. Exported so a page holding a stub for
// `LanguageModel` can drive it; `exports` does not expose this file.
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
    // result of availability() first", so do that and report the answer: here
    // `unavailable` means the device will not run the variant asked for. The
    // option is repeated because a bare call logs the missing-language warning.
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
  // The launch counts as pending too: a cold one takes longer than the idle
  // window, so a browser that had just come up would close before its first
  // turn reached it.
  return await trackTurn(async () => {
    const launched = Date.now()
    const { tab } = await ensureSession(baseModel, debug)
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
  })
}
