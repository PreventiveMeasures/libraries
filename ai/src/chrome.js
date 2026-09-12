import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { baseModelFor } from './models.js'
import { chromePreflight, findModelDir, graftPlan, localStateFor } from './chrome-model.js'
import { outputLanguage, toChatCompletions } from './chrome-wire.js'

// Re-exported so callers keep one entry point for the provider.
export { chromePreflight, findModelDir, localStateFor } from './chrome-model.js'

// The one provider that isn't an endpoint: Chrome's built-in Prompt API
// (developer.chrome.com/docs/ai/prompt-api), reached over CDP with
// playwright-core. No key, no URL, no network — the model is already on the
// machine, inside a browser the user has installed.
//
// playwright-core rather than puppeteer-core: zero dependencies against six
// (23 packages transitively, 30 MB against 14 MB). `-core` ships no browsers,
// and `channel: 'chrome'` points it at the branded Chrome already installed,
// so nothing is downloaded to reach a model that is already here.
//
// Chromium will not do. Open-source builds compile the Prompt API in but
// expose no binding — verified against 141, where `LanguageModel` is
// undefined under --enable-blink-features=AIPromptAPI, --enable-features=
// AIPromptAPI and --enable-experimental-web-platform-features alike, while
// Summarizer, Translator and LanguageDetector are all present. Branded Chrome
// only, and NOT Chrome for Testing: it exposes the binding, but
// #if BUILDFLAG(CHROME_FOR_TESTING) pins the device performance class to
// kGpuBlocked, so it can only ever reach the CPU backend — a separate model
// build most machines do not have. There is no CI-friendly way to get this;
// see chrome-ondevice.test.js, which skips on CI for that reason.
//
// Two constraints shape the rest.
//
// The weights are never ours to download. Chrome keeps its on-device model
// under the USER DATA DIR (component_updater's DIR_COMPONENT_USER), not under
// the profile inside it, so a scratch --user-data-dir sees nothing and pulls
// its own ~4 GB copy. We borrow the copy already there, and leave
// --disable-component-update (playwright sets it) in place, which turns
// "please don't re-download" into "cannot": with no resident model a request
// fails loudly instead of quietly costing four gigabytes.
//
// No server. `LanguageModel` is gated on a secure context, and about:blank
// and data: URLs are opaque origins where it is simply absent — measured, not
// assumed. file:// is potentially trustworthy and does expose it, so the page
// is file:///dev/null, the same trick @exodus/test uses to reach crypto.subtle.

// Playwright disables a set of Chrome features for test determinism, and one
// of them is fatal here: `OptimizationHints`, which its source annotates
// "Prevents downloading optimization hints on startup." That feature is the
// optimization guide, and the on-device model hangs off the same keyed
// service — with it off, the model service never starts, availability()
// answers `unavailable` forever, and chrome://on-device-internals sits on
// "Device performance class: Loading...". Removing this one entry is what
// makes the class resolve (to "High" on a capable machine).
//
// It cannot be undone with --enable-features: Chromium's FeatureList gives
// disable precedence over enable, so the only fix is to not disable it. Our
// own --disable-features wins because Chrome reads the last occurrence of a
// switch and playwright does no merging — it just appends its list, and ours
// comes after.
//
// This mirrors playwright 1.63's list minus that one entry. Drift is benign:
// a newer playwright disabling something new simply means we do not inherit
// it, and nothing here needs any of them.
const DISABLED_FEATURES = [
  'AvoidUnnecessaryBeforeUnloadCheckSync', 'DestroyProfileOnBrowserClose', 'DialMediaRouteProvider',
  'GlobalMediaControls', 'HttpsUpgrades', 'LensOverlay', 'MediaRouter', 'PaintHolding',
  'ThirdPartyStoragePartitioning', 'BlockOriginHeaderModificationOnRedirect', 'Translate',
  'AutoDeElevate', 'msForceBrowserSignIn', 'msEdgeUpdateLaunchServicesPreferredVersion',
]

// Overriding --enable-features the same way would silently drop playwright's
// own entry, so carry it along rather than clobbering it.
const ENABLED_FEATURES = [
  'CDPScreenshotNewSurface',
  'OptimizationGuideOnDeviceModel:on_device_model_bypass_perf_requirement/true',
]

// Playwright's two software-GL defaults. Both have to go for Chrome to reach
// a real GPU; see the launch below for why that is not optional.
const SOFTWARE_GL = ['--enable-unsafe-swiftshader', '--use-angle=swiftshader-webgl']


// Which Chrome, in playwright's terms. A path wins when one is given;
// otherwise the channel names an installed branded build — 'chrome',
// 'chrome-beta', 'chrome-dev', 'chrome-canary' — and playwright resolves it,
// reporting the path it looked at when there is nothing there.
export function chromeTarget() {
  if (process.env.CHROME_PATH) return { executablePath: process.env.CHROME_PATH }
  return { channel: process.env.CHROME_CHANNEL || 'chrome' }
}


// A secure origin with no server behind it. /dev/null is not a thing on
// Windows, so there the scratch profile gets an empty page written into it.
function blankPage(profile) {
  if (process.platform !== 'win32') return 'file:///dev/null'
  const page = join(profile, 'blank.html')
  writeFileSync(page, '<!doctype html><meta charset="utf-8"><title>ai</title>')
  return pathToFileURL(page).href
}

// An optional peer, loaded on demand: a caller on the hosted providers never
// pays for a browser driver it will not use, and only ever meets this the
// first time it selects `chrome`. The bare module-not-found that would
// otherwise surface names neither the package nor the reason it is wanted.
async function loadPlaywright() {
  try {
    return await import('playwright-core')
  } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err
    throw new Error('The `chrome` provider needs playwright-core: install it alongside this package (it is an optional peer dependency).', { cause: err })
  }
}

// Scratch profiles, so they can be removed again. A leaked one is not huge on
// its own, but a launch leaves one every run and a failing launch used to
// leave two, which is how a tmp dir fills with ai-chrome-* directories.
//
// Removing one never touches the model: the component tree inside it is a
// SYMLINK, and a recursive delete unlinks the link rather than following it.
// Verified, because getting this wrong deletes several gigabytes belonging to
// the user rather than to us.
const profiles = new Set()

const PROFILE_PREFIX = 'ai-chrome-'
// Old enough that a concurrent run cannot own it. Profiles are only swept on
// age, never by trying to guess whether another process still holds one.
const STALE_MS = 6 * 60 * 60 * 1000

// The single place this file deletes anything recursively.
//
// Every path handed here is built by mkdtemp from PROFILE_PREFIX, so the
// check can only fail if something upstream has gone wrong — which is
// precisely when a recursive delete must not run. The blast radius if it ever
// did is not a temp directory: these profiles contain a symlink to the user's
// model store, so a wrong path plus a wrong follow is gigabytes of somebody
// else's data.
// The decision, separated from the act so it can be tested without calling
// anything that deletes. Checking the guard by asking removeProfileDir to
// refuse '' or '/' means a regressed guard deletes the cwd or the root during
// the very test meant to catch it.
//
// Not "contains" — starts with. Every profile is built by mkdtemp from
// exactly this prefix, so anchoring to it rules out a path that merely has
// ai-chrome- somewhere inside, and rules out anything outside the temp dir
// whatever it is called. Recomputed per call rather than cached, so it still
// matches how the path was built if TMPDIR moves under us.
export function isScratchProfile(dir) {
  const root = join(tmpdir(), PROFILE_PREFIX)
  return typeof dir === 'string' && dir.startsWith(root) && dir.length > root.length
}

export function removeProfileDir(dir) {
  assert.ok(
    isScratchProfile(dir),
    `refusing to recursively delete a path that is not one of our scratch profiles (expected ${join(tmpdir(), PROFILE_PREFIX)}*): ${dir}`,
  )
  rmSync(dir, { recursive: true, force: true })
}

function dropProfile(dir) {
  profiles.delete(dir)
  try { removeProfileDir(dir) } catch { /* already gone, or not ours to touch */ }
}

// Best effort, on launch: clear what earlier runs left behind, including the
// ones this bug already produced.
function sweepStaleProfiles() {
  const now = Date.now()
  let dirs = []
  try { dirs = readdirSync(tmpdir()).filter((n) => n.startsWith(PROFILE_PREFIX)) } catch { return }
  for (const name of dirs) {
    const dir = join(tmpdir(), name)
    if (profiles.has(dir)) continue
    try { if (now - statSync(dir).mtimeMs > STALE_MS) removeProfileDir(dir) } catch { /* in use, or gone */ }
  }
}

// A caller that never reaches closeProvider — a crash, a bare `node script.js`
// — would otherwise leak its profile. rmSync is synchronous, so an exit hook
// can still finish the job.
let exitHookInstalled = false
function installExitCleanup() {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.on('exit', () => {
    for (const dir of profiles) {
      try { removeProfileDir(dir) } catch { /* exiting anyway */ }
    }
  })
}

// One browser per base model, not one per process: the weights directory is
// named on the command line, so two rows backed by different weights cannot
// share a browser. In the common case only one is ever used and only one is
// ever launched.
const sessions = new Map()

async function launch(baseModel, debug) {
  const modelDir = findModelDir(baseModel)
  chromePreflight()
  // A persistent context rather than launch(): the profile has to exist
  // before Chrome starts so the component tree can be grafted into it.
  sweepStaleProfiles()
  installExitCleanup()
  const profile = mkdtempSync(join(tmpdir(), PROFILE_PREFIX))
  profiles.add(profile)
  writeFileSync(join(profile, 'Local State'), JSON.stringify(localStateFor(baseModel)))
  // Everything from here on can throw — a missing peer dependency, a browser
  // that will not start, a page that will not navigate — and every one of
  // those used to leave the profile behind, because only the readiness wait
  // was wrapped. The sweep deliberately skips young directories, so those
  // strays survived until they aged out.
  try {
    return await openBrowser(profile, modelDir, debug)
  } catch (err) {
    dropProfile(profile)
    throw err
  }
}

// The switch list, out here rather than inline, because every entry is a
// fix for something that failed silently and a test can hold each one in
// place. Order matters only for --use-angle and the feature lists, which
// deliberately come after playwright's.
export function launchArgs(modelDir) {
  return [
    // --use-angle is re-added outside the ignorable set, so it has to be
    // overridden rather than dropped. The last occurrence of a switch is the
    // one Chrome reads, and `default` hands the backend choice back to it.
    '--use-angle=default',
    // Name the borrowed directory outright. Besides pointing at the
    // weights, this waives the base-model version check Chrome would apply
    // to a profile that has never registered a component of its own.
    `--optimization-guide-ondevice-model-execution-override=${modelDir}`,
    // Both lists replace playwright's; see DISABLED_FEATURES for why the
    // disable side is not optional.
    `--disable-features=${DISABLED_FEATURES.join(',')}`,
    `--enable-features=${ENABLED_FEATURES.join(',')}`,
    // The gate that actually stops a scratch profile. Eligibility needs a
    // device performance class, and a profile that has never computed one
    // runs a GPU benchmark to get it — chrome://on-device-internals sits on
    // "Device performance class: Loading..." while it does. availability()
    // answers `unavailable` throughout, so a turn issued at launch loses a
    // race it never announces. Forcing the class skips the benchmark.
    //
    // The value is an INTEGER, not a name: Chrome parses it with
    // StringToInt and a name silently becomes kUnknown, which is
    // indistinguishable from not passing the switch at all. 6 is VeryHigh
    // (0 Unknown, 1 Error, 2 VeryLow, 3 Low, 4 Medium, 5 High, 6 VeryHigh);
    // the numbering is fixed by the UMA enum, not by declaration order.
    `--optimization-guide-performance-class=${process.env.CHROME_PERFORMANCE_CLASS || '6'}`,
    // Never fetch a model. Asking for Gemma 4 also turns on the manifest
    // broker, and the broker will go and get whichever Gemma it decides the
    // machine should run — a 6.1 GB gemma4_12b, in the run that caught this,
    // written through the grafted symlinks into the user's REAL component
    // directories rather than into the scratch profile that asked for it.
    //
    // --disable-component-update does not cover it: playwright passes that
    // already, and while dropping it takes component registrations from 1 to
    // 20, the broker registers its assets itself at runtime. What does cover
    // it is the configurator, which every component fetch goes through
    // whoever registered it. Read off --log-net-log, overriding url-source
    // sends the update requests to the named address (3 of them) and none to
    // Google. Port 1 is on Chrome's restricted list, so the attempt dies
    // locally as ERR_UNSAFE_PORT — no socket, no DNS, no proxy.
    //
    // Weights already on disk are unaffected: they are loaded from the
    // override directory above, not fetched. A model that is genuinely
    // missing stays missing, which is this provider's whole promise —
    // chromePreflight says as much, and points at Chrome itself for getting
    // one.
    '--component-updater=url-source=http://127.0.0.1:1/no-downloads',
    ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
  ]
}


async function openBrowser(profile, modelDir, debug) {
  // The override switch below is what Chrome reads to load the model, but the
  // component installer decides whether anything is MISSING, and a profile
  // that looks complete never starts a download. Only the requested model is
  // linked, at the same depth it sits in the real profile. Best effort on
  // each: the switch alone suffices, and a filesystem that refuses a link
  // should not take the provider down with it.
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
    // Playwright forces a software rasterizer so rendering is deterministic
    // across machines. That is fatal here: every on-device model Chrome ships
    // is GPU-tier ("GPU (highest quality)" in chrome://on-device-internals),
    // so under SwiftShader the on_device_model service never starts at all —
    // availability() reads `unavailable`, create() says "the service is not
    // running", and no eligibility reason is even recorded, because nothing
    // got far enough to weigh one.
    ignoreDefaultArgs: SOFTWARE_GL,
    args: launchArgs(modelDir),
  })
  const tab = await browser.newPage()
  // Page-side failures are otherwise silent: evaluate returns the value and
  // says nothing about what the model logged on the way.
  if (debug) {
    tab.on('console', (msg) => { if (!isBoilerplate(msg.text())) console.debug(`[chrome] ${msg.text()}`) })
    tab.on('pageerror', (err) => console.error(`[chrome] ${err}`))
  }
  await tab.goto(blankPage(profile))
  // Close the browser if the model never arrives. Without this, a failed
  // launch leaves its window open and the next attempt opens another beside
  // it — two windows, one of them abandoned.
  try {
    await waitUntilReady(tab, debug)
  } catch (err) {
    await browser.close().catch(() => {})
    throw err
  }
  return { browser, tab, profile }
}

// What Chrome actually loaded, as opposed to what we asked for. Those are
// different questions: the override names a directory, and whether it steers
// the BASE model is unproven — the only consumer of that switch findable in
// Chromium steers adaptation models. Reported rather than enforced, because a
// scraper written against a page I cannot run here is not something to fail
// requests on. On its own page so the turn's tab is left alone.
/* eslint-disable no-undef */
// What Chrome actually loaded, as opposed to which directory we pointed it
// at. Those are different questions, and the difference is not academic:
// asking for three different rows currently produces indistinguishable runs,
// so the override may not steer the base model at all.
//
// chrome://on-device-internals answers it under Broker State, in real tables
// rather than prose — Models is Name / Folder Size / Weights Path / Backend
// Type, Use Cases is Name / Requested / Unavailable Reason. Parsed as tables
// for that reason: a regex over the page text cannot say which column a value
// came from, and reading the wrong column is how this went wrong before.
//
// Reported, never enforced, and only under --debug: a scraper written against
// a page that cannot be exercised here is not something to fail requests on.
async function reportLoadedModel(browser) {
  let page
  try {
    page = await browser.newPage()
    await page.goto('chrome://on-device-internals')
    await page.waitForTimeout(3000)
    const tables = await page.evaluate(readInternalsTables)
    for (const name of ['Models', 'Use Cases', 'Assets']) {
      const rows = tables[name] ?? []
      // Row 0 is the header, so anything less is a table with no content.
      if (rows.length < 2) continue
      for (const row of rows.slice(1)) console.debug(`[chrome] ${name}: ${row.join(' | ')}`)
    }
    const log = (tables['Event Logs'] ?? []).slice(1).filter((r) => /model|load/iu.test(r.join(' ')))
    for (const row of log.slice(-4)) console.debug(`[chrome] log: ${row.at(-1)}`)
  } catch (err) {
    console.debug(`[chrome] could not read on-device-internals: ${err.message}`)
  } finally {
    await page?.close().catch(() => {})
  }
}

// Runs in the page. Every <table> on it, keyed by the <h2> that introduces
// it, reached through the shadow roots the WebUI is built from.
function readInternalsTables() {
  const roots = []
  const collect = (root) => {
    roots.push(root)
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) collect(el.shadowRoot)
  }
  collect(document)
  // The <h2> that introduces a table is a previous sibling of the table or of
  // one of its ancestors, so walk outwards until one turns up.
  const headingFor = (table) => {
    for (let node = table; node; node = node.parentElement) {
      for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
        const h = sib.tagName === 'H2' ? sib : sib.querySelector?.('h2')
        if (h) return h.textContent.trim()
      }
    }
    return 'unnamed'
  }
  const rowsOf = (table) => [...table.querySelectorAll('tr')]
    .map((tr) => [...tr.querySelectorAll('th,td')].map((cell) => cell.textContent.trim()))
    .filter((cells) => cells.length > 0)

  const out = {}
  for (const root of roots) {
    for (const table of root.querySelectorAll('table')) out[headingFor(table)] = rowsOf(table)
  }
  return out
}
/* eslint-enable no-undef */

// How long a cold profile gets to become ready. Registration is not
// instant — the component updater has to run before Chrome will admit to
// having a model, and that is seconds, not milliseconds.
const READY_TIMEOUT_MS = 120_000
const READY_POLL_MS = 500

// The bug that cost four wrong fixes: a fresh profile answers `unavailable`
// to everything until the on-device model component finishes registering,
// and asking once at launch loses that race by two orders of magnitude —
// milliseconds against the ten-plus seconds registration actually takes.
// chrome://on-device-internals shows the same state as "Device performance
// class: Loading...". `unavailable` is not a verdict here, it is "not yet".
//
// So wait for a real answer instead of taking the first one. A profile that
// genuinely cannot serve the model still ends up here, and still fails —
// just with a message that says how long it waited.
/* eslint-disable no-undef */
// Warm the model, by asking for a session rather than by waiting to be told
// one is possible.
//
// Polling availability() here was a deadlock: in a cold profile it answers
// `unavailable` until the model has been loaded, and nothing loads it except
// create(). So the wait blocked on a state only the call it was gating could
// produce. Running `await LanguageModel.create()` by hand in devtools broke
// the deadlock and made every subsequent turn work, which is exactly the
// shape of that bug.
//
// So: attempt a throwaway session, retry while the service is still coming
// up, and abort the moment a real download starts — a session is free when
// the weights are already here, and this provider must never pay for its own
// copy of them.
export async function waitUntilReady(tab, debug) {
  const deadline = Date.now() + READY_TIMEOUT_MS
  const language = outputLanguage()
  let last = 'unknown'
  while (Date.now() < deadline) {
    last = await tab.evaluate(async (lang) => {
      if (typeof LanguageModel === 'undefined') return 'no-binding'
      try {
        const probe = await LanguageModel.create({
          expectedOutputs: [{ type: 'text', languages: [lang] }],
          // Watched, not policed. `downloadprogress` also fires while Chrome
          // prepares weights it ALREADY has, so treating a sub-complete event
          // as a network fetch aborted every legitimate warm-up — which is
          // what it did, about ten seconds into every run.
          //
          // Nothing is needed here to prevent a download anyway:
          // --disable-component-update, which playwright passes and this
          // launch keeps, is what actually stops Chrome fetching its own
          // copy. A guard in the page was never the thing holding that line.
          monitor: (m) => m.addEventListener('downloadprogress', (e) => {
            globalThis.__aiChromeProgress = e.loaded
          }),
        })
        probe.destroy()
        return 'ready'
      } catch (err) {
        return `${err.name}: ${err.message}`
      }
    }, language)
    if (last === 'ready') {
      if (debug) console.debug('[chrome] model warm')
      return
    }
    if (last === 'no-binding') throw new Error('LanguageModel is not exposed — this is not a branded Chrome')
    if (debug) {
      const loaded = await tab.evaluate(() => globalThis.__aiChromeProgress)
      console.debug(`[chrome] warming: ${last}${loaded === undefined ? '' : ` (progress ${(loaded * 100).toFixed(0)}%)`}`)
    }
    await new Promise((resolve) => { setTimeout(resolve, READY_POLL_MS) })
  }
  throw new Error(`On-device model never became usable within ${READY_TIMEOUT_MS / 1000}s. Last attempt: ${last}`)
}
/* eslint-enable no-undef */

// Reused across turns: a launch costs about a second, and no turn leaves
// state behind on the browser side — each creates and destroys its own
// LanguageModel session.
function ensureSession(baseModel, debug) {
  const key = baseModel ?? ''
  if (!sessions.has(key)) {
    // A failure must not be cached. Left in the map, a rejected promise is
    // handed to every later turn, which is why one bad launch failed the
    // rest of a run in under a millisecond each.
    const pending = launch(baseModel, debug)
    pending.catch(() => sessions.delete(key))
    sessions.set(key, pending)
  }
  return sessions.get(key)
}

export async function closeChrome() {
  const open = [...sessions.values()]
  sessions.clear()
  // A launch that failed already rejected to its caller; settling it again
  // here would surface the same error a second time as an unhandled one.
  const shut = async (pending) => {
    // A launch that rejected already surfaced to its caller; settling it again
    // here would raise the same error a second time, unhandled.
    const live = await pending.catch(() => null)
    if (!live) return
    await live.browser.close().catch(() => {})
    dropProfile(live.profile)
  }
  await Promise.all(open.map(shut))
}

// Chrome greets every page that touches the Prompt API with a banner about
// submitting feedback. It says nothing about this run and is printed once per
// launch, so it only makes --debug harder to read. Filtered by content rather
// than by suppressing console output wholesale — a real message from the page
// is exactly what --debug is for.
//
// The missing-output-language warning is deliberately NOT filtered: it should
// no longer appear now that a language is sent, and if it does, that is worth
// seeing rather than hiding.
const BOILERPLATE = /uses Chrome's Built-In AI features/u

const isBoilerplate = (text) => BOILERPLATE.test(text)

// Runs inside the page. Serialized across, so it closes over nothing and
// takes everything as one argument.
//
// Exported as a seam: this half runs where `LanguageModel` lives, so the only
// way to exercise it without a downloaded model is to hand it to a page that
// has a stub in place of one. Internal — index.js does not re-export it and
// package.json's `exports` map does not expose this file, so the seam is
// reachable from tests/ and nowhere a consumer can stand.
/* eslint-disable no-undef */
export async function turnInPage(req) {
  if (typeof LanguageModel === 'undefined') {
    return { error: { message: 'LanguageModel is not exposed — this is not a branded Chrome' } }
  }
  // No availability() gate here. It reports `unavailable` for a model that is
  // merely unloaded, and waitUntilReady has already proved a session can be
  // had — re-checking would refuse turns the browser is perfectly able to
  // serve. A create() that genuinely cannot work still fails below, with the
  // browser's own reason instead of a one-word status.
  let ses
  const createStarted = performance.now()
  let createdAt = 0
  try {
    ses = await LanguageModel.create({
      initialPrompts: req.initialPrompts,
      // Chrome warns on every request without this: "An output language
      // should be specified to ensure optimal output quality and properly
      // attest to output safety." It accepts de, en, es, fr, ja.
      expectedOutputs: [{ type: 'text', languages: [req.language] }],
    })
    createdAt = performance.now() - createStarted
  } catch (err) {
    return { error: { message: `create failed: ${err.name}: ${err.message}` } }
  }
  const before = ses.contextUsage ?? 0
  try {
    const options = req.responseConstraint ? { responseConstraint: req.responseConstraint } : undefined
    // The prompt itself is INPUT. Measuring it separately keeps it out of the
    // completion count: the post-prompt delta covers the prompt, any
    // constraint context and the generated text all together, so charging the
    // whole delta to output overstated generation by the size of the request.
    let promptTokens = 0
    try { promptTokens = await ses.measureContextUsage(req.prompt, options) ?? 0 } catch { promptTokens = 0 }
    const started = performance.now()
    const text = await ses.prompt(req.prompt, options)
    const delta = Math.max((ses.contextUsage ?? 0) - before, 0)
    return {
      text,
      usage: { prompt_tokens: before + promptTokens, completion_tokens: Math.max(delta - promptTokens, 0) },
      contextWindow: ses.contextWindow ?? null,
      // Split out, because "slow" on this provider has two very different
      // causes: create() pays to load several gigabytes into the GPU the
      // first time the service touches them, prompt() is the actual
      // generation. One is amortised across a run, the other is not.
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
  // Undefined means the registry has no chrome/* row for this id, so there is
  // no way to know which local weights were meant. Launching anyway served
  // whatever happened to be installed — an anthropic/* id, or a typo, would
  // quietly get an answer from a different model entirely.
  assert.ok(baseModel, `Provider \`chrome\` cannot serve ${model}. Use one of the chrome/* models.`)
  const launched = Date.now()
  const session = await ensureSession(baseModel, debug)
  const { tab } = session
  const startup = Date.now() - launched
  if (debug && label) console.debug(`[debug] ${label}`)
  const result = await tab.evaluate(turnInPage, body)
  // After the turn, not before it: Use Cases and the event log only say what
  // was requested once something has requested it, and reading them at launch
  // showed empty tables. Once per browser, so a tool loop does not repeat it.
  if (debug && !session.reported) {
    session.reported = true
    await reportLoadedModel(session.browser)
  }
  if (debug) {
    // Attribute the wait. A cold run pays for browser startup, component
    // registration and the first load of the weights; a warm one pays for
    // none of those, and only the last number is the model actually working.
    console.debug(`[chrome] startup=${startup}ms create=${result.createMs ?? '-'}ms prompt=${result.promptMs ?? '-'}ms`)
  }
  return toChatCompletions(result, Boolean(body.responseConstraint))
}
