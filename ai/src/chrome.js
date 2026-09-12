import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { baseModelFor } from './models.js'
import { parseArgs } from './wire-formats.js'

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
// only; Chrome for Testing counts, which is the CI-friendly way to get one.
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

const MODEL_COMPONENT = 'OptGuideOnDeviceModel'

// Where Chrome keeps its user data, and so the component tree inside it.
// Only consulted to FIND already-downloaded weights — which Chrome runs is
// playwright's business, via the channel below.
const USER_DATA_DIRS = {
  darwin: [
    `${homedir()}/Library/Application Support/Google/Chrome`,
    `${homedir()}/Library/Application Support/Google/Chrome Canary`,
  ],
  linux: [`${homedir()}/.config/google-chrome`, `${homedir()}/.config/google-chrome-unstable`],
  win32: [
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\User Data`,
    `${process.env.LOCALAPPDATA}\\Google\\Chrome SxS\\User Data`,
  ],
}

// The component root — one subdirectory per installed version. Wanted whole
// rather than just the version: the root is what gets grafted into the
// scratch profile, a version inside it is what gets named on the command line.
function modelComponentRoot() {
  for (const dir of USER_DATA_DIRS[process.platform] ?? []) {
    const root = join(dir, MODEL_COMPONENT)
    if (existsSync(root)) return root
  }
  return undefined
}

// Weights for a base model spec, or for whatever is installed when none is
// named. Chrome leaves a superseded version's directory behind, and an
// interrupted install leaves one that never had a weights.bin at all, so the
// file is the test rather than the directory, and the newest survivor wins.
//
// Matching a spec is best-effort: which base model a component holds is not
// something Chrome documents a file for, so the version's manifest is scanned
// for the name and a miss falls back to the newest weights present. Being
// wrong here costs an unexpected model rather than a download — the id is a
// cache key and a directory hint, never a guarantee (see models.js).
export function findModelDir(baseModel) {
  if (process.env.CHROME_MODEL_DIR) return process.env.CHROME_MODEL_DIR
  const root = modelComponentRoot()
  if (!root) return undefined
  const versions = readdirSync(root).filter((v) => existsSync(join(root, v, 'weights.bin'))).sort()
  if (versions.length === 0) return undefined
  const named = baseModel && versions.findLast((v) => manifestNames(join(root, v), baseModel))
  return join(root, named || versions.at(-1))
}

function manifestNames(dir, baseModel) {
  const manifest = join(dir, 'manifest.json')
  if (!existsSync(manifest)) return false
  try { return readFileSync(manifest, 'utf8').includes(baseModel) } catch { return false }
}

// Which Chrome, in playwright's terms. A path wins when one is given;
// otherwise the channel names an installed branded build — 'chrome',
// 'chrome-beta', 'chrome-dev', 'chrome-canary' — and playwright resolves it,
// reporting the path it looked at when there is nothing there.
export function chromeTarget() {
  if (process.env.CHROME_PATH) return { executablePath: process.env.CHROME_PATH }
  return { channel: process.env.CHROME_CHANNEL || 'chrome' }
}

// Fail at setProvider, the way a missing API key does, rather than on the
// first turn. Only the weights are checked here: which Chrome to run resolves
// at launch, and playwright's own error names the path it expected, which
// beats anything guessed here. The message names the fix, because needing to
// have opened Chrome once and let it fetch the model is not something a
// caller can be expected to infer from "unavailable".
export function chromePreflight() {
  assert.ok(
    findModelDir(),
    `No on-device model found under ${MODEL_COMPONENT}. Open Chrome, visit chrome://on-device-internals and let it download the model, then retry — this provider will not download a second copy. Set CHROME_MODEL_DIR to point at an existing one.`,
  )
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
  const profile = mkdtempSync(join(tmpdir(), 'ai-chrome-'))
  const root = modelComponentRoot()
  // The override switch below is what Chrome reads to load the model, but the
  // component installer is what decides whether anything is MISSING, and a
  // profile that looks complete never starts a download. Best effort: the
  // switch alone is enough on its own, and a filesystem that refuses the link
  // should not take the provider down with it.
  if (root) {
    try { symlinkSync(root, join(profile, MODEL_COMPONENT), 'junction') } catch { /* the switch covers us */ }
  }
  const { chromium } = await loadPlaywright()
  const browser = await chromium.launchPersistentContext(profile, {
    ...chromeTarget(),
    headless: process.env.CHROME_HEADLESS !== '0',
    args: [
      // Name the borrowed directory outright. Besides pointing at the
      // weights, this waives the base-model version check Chrome would apply
      // to a profile that has never registered a component of its own.
      `--optimization-guide-ondevice-model-execution-override=${modelDir}`,
      // The eligibility gate, which reads "unavailable" on plenty of hardware
      // that runs the model perfectly well once past it.
      '--enable-features=OptimizationGuideOnDeviceModel:on_device_model_bypass_perf_requirement/true',
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    ],
  })
  const tab = await browser.newPage()
  // Page-side failures are otherwise silent: evaluate returns the value and
  // says nothing about what the model logged on the way.
  if (debug) {
    tab.on('console', (msg) => console.debug(`[chrome] ${msg.text()}`))
    tab.on('pageerror', (err) => console.error(`[chrome] ${err}`))
  }
  await tab.goto(blankPage(profile))
  return { browser, tab }
}

// Reused across turns: a launch costs about a second, and no turn leaves
// state behind on the browser side — each creates and destroys its own
// LanguageModel session.
function ensureSession(baseModel, debug) {
  // Retried once, the way @exodus/test retries its launchers: a cold start
  // occasionally times out and the second attempt reliably does not.
  const key = baseModel ?? ''
  if (!sessions.has(key)) {
    sessions.set(key, launch(baseModel, debug).catch(() => launch(baseModel, debug)))
  }
  return sessions.get(key)
}

export async function closeChrome() {
  const open = [...sessions.values()]
  sessions.clear()
  // A launch that failed already rejected to its caller; settling it again
  // here would surface the same error a second time as an unhandled one.
  await Promise.all(open.map((s) => s.then((live) => live.browser.close(), () => {})))
}

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
  const availability = await LanguageModel.availability()
  // Anything but `available` means the weights are not resident. Refuse
  // rather than wait: component updates are off, so `downloadable` can only
  // resolve by Chrome fetching its own copy — the one outcome this provider
  // exists to prevent.
  if (availability !== 'available') {
    return { error: { message: `on-device model not ready (availability: ${availability})` } }
  }
  let ses
  try {
    ses = await LanguageModel.create({ initialPrompts: req.initialPrompts })
  } catch (err) {
    return { error: { message: `create failed: ${err.name}: ${err.message}` } }
  }
  const before = ses.contextUsage ?? 0
  try {
    const options = req.responseConstraint ? { responseConstraint: req.responseConstraint } : undefined
    const text = await ses.prompt(req.prompt, options)
    return {
      text,
      usage: { prompt_tokens: before, completion_tokens: Math.max((ses.contextUsage ?? 0) - before, 0) },
      contextWindow: ses.contextWindow ?? null,
    }
  } catch (err) {
    return { error: { message: `${err.name}: ${err.message}` } }
  } finally {
    ses.destroy()
  }
}
/* eslint-enable no-undef */

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
    chrome: { contextWindow: result.contextWindow },
  }
}

export async function sendChromeTurn(model, body, { debug, label } = {}) {
  const { tab } = await ensureSession(baseModelFor(model), debug)
  if (debug && label) console.debug(`[debug] ${label}`)
  return toChatCompletions(await tab.evaluate(turnInPage, body), Boolean(body.responseConstraint))
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
