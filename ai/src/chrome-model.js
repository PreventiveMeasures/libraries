import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { specNamesFor } from './models.js'

// Where the on-device weights are, which is a separate question from how the
// browser is driven — see chrome.js for that.

// Two stores, different shapes: nano_v3 lives under the first, the gemma
// models under the second, keyed by a content hash above the version.
const MODEL_COMPONENTS = ['OptGuideOnDeviceModel', 'OptGuideManifestModel']

// Grafted into the scratch profile but never searched for weights: this one
// records which manifest models exist rather than holding any. Small, and not
// a model, so it goes across whole.
const LEDGER_COMPONENT = 'OptimizationGuideModelsManifest'

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

// The user data dir the weights came from, so state can be seeded from the
// same profile that owns them.
function activeUserDataDir() {
  for (const dir of USER_DATA_DIRS[process.platform] ?? []) {
    if (MODEL_COMPONENTS.some((component) => existsSync(join(dir, component)))) return dir
  }
  return undefined
}

// What to link into a scratch profile, as {from, rel} pairs: `from` is the
// real path, `rel` is where it goes relative to the profile root.
//
// Only the ONE model that was asked for. Linking the component roots whole
// put every installed model in front of the browser, which is both more than
// the run needs and more than it should be offered — the requested model is
// known here, so nothing else has to be visible. The paths are mirrored
// rather than flattened, since the two stores nest differently
// (OptGuideOnDeviceModel/<version> against
// OptGuideManifestModel/<hash>/<version>) and Chrome reads the shape.
//
// The ledger goes across whole: it is a record of which manifest models
// exist, not a model, and there is nothing in it to narrow.
export function graftPlan(modelDir) {
  return graftPlanIn(activeUserDataDir(), modelDir)
}

// The decision, separated from finding the profile it applies to, so it can be
// stated against paths rather than against whichever Chrome the machine
// running the tests happens to have.
export function graftPlanIn(userDataDir, modelDir) {
  if (!userDataDir) return []
  const plan = []
  const ledger = join(userDataDir, LEDGER_COMPONENT)
  if (existsSync(ledger)) plan.push({ from: ledger, rel: LEDGER_COMPONENT })
  // A CHROME_MODEL_DIR pointing outside the user data dir has no position
  // inside the profile to mirror; the override switch names it outright and
  // is enough on its own.
  const rel = modelDir ? relative(userDataDir, modelDir) : ''
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) plan.push({ from: modelDir, rel })
  return plan
}

// What a scratch profile inherits from the real one: one entry of one map,
// named rather than arrived at by deleting the rest. Nothing else is read, so
// a subtree nobody has reasoned about cannot come along by being overlooked
// when Chrome starts writing a new one.
//
// `optimization_guide.model_execution.manifest_asset_ledger` holds a standing
// REQUEST per component — an asset_id and a requested_version — and the entry
// for the linked model is what makes the browser go and load it. Only that
// entry travels, because the entries name models: carried whole, the others
// have Chrome fetch components it cannot find, which is a nano launch pulling
// gemma4 and a gemma4 launch pulling nano_v3. The entry itself is passed
// through, so a field Chrome adds to it still arrives.
//
// What used to travel and does not, each established by a profile that
// answers rather than by argument:
//
//   on_device               the cached performance class and the GPU it was
//                           measured on. Every launch already passes
//                           --optimization-guide-performance-class, and a
//                           profile inheriting nothing still records the
//                           forced class — then confirmed against the real
//                           model, which answers without it.
//   last_usage_by_feature   a timestamp per use case the real profile has
//                           exercised, which listed every other use case as
//                           Pending Assets. A scratch profile has exercised
//                           nothing, so it declares nothing.
//   everything else         the model store metadata, the cache key mapping,
//                           the prediction model fetcher state, and an id
//                           identifying the browser it came from.
function optimizationGuidePrefs(modelDir) {
  const dir = activeUserDataDir()
  if (!dir) return {}
  try {
    return portableGuide(JSON.parse(readFileSync(join(dir, 'Local State'), 'utf8'))?.optimization_guide, modelDir)
  } catch { return {} }
}

// The ledger is keyed by the content hash a manifest model sits under, and
// `requested_version` is its version directory — so the linked model's own
// path names its entry, under either layout:
//
//   OptGuideManifestModel/<hash>/<version>   both halves match
//   OptGuideOnDeviceModel/<version>          the version matches
function findLedgerEntry(ledger, modelDir) {
  if (!ledger || !modelDir) return undefined
  const parts = new Set(modelDir.split(/[/\\]/u))
  return Object.entries(ledger).find(([hash, entry]) => parts.has(hash) || parts.has(entry?.requested_version))
}

// Separated from reading the file so what is selected can be stated against a
// subtree written by hand rather than against whichever Chrome the machine
// running the tests happens to have.
//
// No ledger entry found means no ledger. That case is a CHROME_MODEL_DIR
// outside the component tree, where graftPlan links nothing either and the
// execution override names the directory outright — and where carrying the
// real profile's ledger would claim components this profile does not have,
// which is the fetch it exists to prevent.
export function portableGuide(guide, modelDir) {
  const found = findLedgerEntry(guide?.model_execution?.manifest_asset_ledger, modelDir)
  if (!found) return {}
  return { optimization_guide: { model_execution: { manifest_asset_ledger: { [found[0]]: found[1] } } } }
}


// The component root — one subdirectory per installed version. Wanted whole
// rather than just the version: the root is what gets grafted into the
// scratch profile, a version inside it is what gets named on the command line.
// Numeric, not lexicographic. Component versions are dotted numbers, and a
// string sort puts 2025.8.8 after 2025.8.11 — so "newest" quietly selected an
// OLDER build whenever a minor number crossed ten.
function compareVersions(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d !== 0) return d
  }
  return 0
}

// Every component root that exists, not the first. A stale or empty stable
// root used to hide a Canary install that actually had the weights.
function modelComponentRoots() {
  const roots = []
  for (const dir of USER_DATA_DIRS[process.platform] ?? []) {
    for (const component of MODEL_COMPONENTS) {
      const root = join(dir, component)
      if (existsSync(root)) roots.push(root)
    }
  }
  return roots
}

// Directories holding weights, across both component layouts:
// OptGuideOnDeviceModel/<version>/ is flat, while OptGuideManifestModel nests
// a content hash above the version. A superseded version's directory is left
// behind and an interrupted install leaves one with no weights at all, so the
// file is the test rather than the directory.
function candidateModelDirs(root, depth = 2) {
  const found = []
  let entries = []
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return found }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(root, entry.name)
    if (existsSync(join(dir, 'weights.bin'))) found.push({ dir, version: entry.name })
    else if (depth > 1) found.push(...candidateModelDirs(dir, depth - 1))
  }
  return found
}

// Whether a directory holds the model a row asked for.
//
// The same model has three names, and no two of them match. Google publishes
// gemma-4-E2B-it, which the registry rows follow; chrome://on-device-internals
// lists a deployment variant, gemma4_gpu_high_tier_model, which baseModel
// follows; and the component manifest declares a BaseModelSpec, gemma4-2b-it,
// which is what a directory on disk actually says about itself. Comparing the
// first two as strings is how a strict check once rejected a working nano_v3,
// whose spec is "v3Nano".
//
// Nor is the difference computable. The specs in the wild are "v3Nano",
// "gemma4-2b-it" and "gemma-4-E4B-it": anything loose enough to relate
// gemma4_2b to gemma4-2b-it also relates it to gemma-4-E4B-it, and quietly
// picking the wrong one is the bug this check exists to prevent. So the
// accepted names live on the registry row and are compared here, ignoring
// case and punctuation only.
function normalizeSpec(name) {
  return String(name).toLowerCase().replaceAll(/[^a-z0-9]+/gu, '')
}

// The manifest's declared name, when there is one to read.
//
// Not every manifest has a BaseModelSpec. The three that do give the generic
// component name "Optimization Guide On Device Model" at the top level and the
// real identity underneath; the 12B one has no BaseModelSpec at all and puts
// its identity in the top-level name instead:
//
//   { "name": "Optimization Guide On-Device Gemma4 12B Model",
//     "version": "<version>" }
//
// So the spec wins where it exists and the name stands in where it does not.
// The generic name is distinct enough from the 12B one after normalising
// (…ondevicemodel against …ondevicegemma412bmodel) that the fallback cannot
// make a spec-carrying manifest match a row it should not.
function declaredSpec(dir) {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
    return manifest?.BaseModelSpec?.name ?? manifest?.name ?? null
  } catch { return null }
}

// The other half, for manifests that declare no spec: the component name is a
// template, so it can be derived from the row's id rather than transcribed.
// "Optimization Guide On-Device Gemma4 12B Model" is
// `optimization_guide_on-device_${baseModel}_model` for a baseModel of
// gemma4_12b, once both are normalised, and a future size drops in with no
// edit here. What separates it from the generic name the spec-carrying
// manifests use — "Optimization Guide On Device Model" — is the size segment
// in the middle, not the hyphen, which normalising discards from both.
function componentNameFor(baseModel) {
  return `optimization_guide_on-device_${baseModel}_model`
}

// Every name a row will answer to: what its manifest may declare as a spec,
// and the component name it would carry if it declares none.
function acceptedNames(baseModel) {
  return [...specNamesFor(baseModel), componentNameFor(baseModel)]
}

export function identifiesAs(dir, baseModel) {
  const declared = declaredSpec(dir)
  if (!declared) return false
  return acceptedNames(baseModel).some((name) => normalizeSpec(name) === normalizeSpec(declared))
}

// Weights for a base model spec, or the newest installed when none is named.
//
// A named spec that cannot be identified is an error rather than a fallback.
// Falling back looked harmless and was not: the turn would be labelled and
// CACHED as chrome/gemma-4-e2b-it while nano_v3 actually answered it — a wrong answer
// filed under a name that gets trusted later.
export function findModelDir(baseModel) {
  const override = process.env.CHROME_MODEL_DIR
  if (override) {
    // Checked here so a typo fails at setProvider rather than after a
    // two-minute wait for a model that was never going to load.
    assert.ok(existsSync(join(override, 'weights.bin')), `CHROME_MODEL_DIR has no weights.bin: ${override}`)
    return override
  }
  const all = modelComponentRoots().flatMap((root) => candidateModelDirs(root))
  // The unnamed call is a "is there anything at all" probe — chromePreflight
  // and the on-device tests both use it that way — so it answers rather than
  // throws.
  if (!baseModel) return all.length > 0 ? all.sort((a, b) => compareVersions(a.version, b.version)).at(-1).dir : undefined
  all.sort((a, b) => compareVersions(a.version, b.version))
  const matches = all.filter(({ dir }) => identifiesAs(dir, baseModel))
  if (matches.length > 0) return matches.at(-1).dir
  throw new Error(missingModelMessage(baseModel, all))
}

// Asking for a model Chrome does not have is a stop, not something to work
// around: the provider does not download, and the browser it launches cannot
// either. So the message says where the model does come from.
//
// The list of what IS installed distinguishes the two ways to get here. If
// nothing resembles the request, it was never downloaded. If something does,
// Chrome has renamed it and the fix is a one-line edit rather than a
// multi-gigabyte fetch — which is why the spec names live on the registry row
// in the first place.
function missingModelMessage(baseModel, all) {
  const wanted = acceptedNames(baseModel)
  const found = all.length > 0
    ? all.map((m) => `${declaredSpec(m.dir) ?? 'unnamed'} at ${m.dir}`).join('; ')
    : 'nothing'
  return (
    `Chrome has no on-device model for ${baseModel}. Open Chrome, go to chrome://on-device-internals, ` +
    'and request it there — this provider reuses what Chrome has downloaded and will not download a ' +
    `copy of its own. Installed instead: ${found}. ` +
    `If one of those IS ${baseModel}, Chrome has renamed it: the expected names are ` +
    `${wanted.map((n) => `"${n}"`).join(' or ')}, so add the new one to specNames in models.js, ` +
    'or point CHROME_MODEL_DIR at the directory.'
  )
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
    `No on-device model found under ${MODEL_COMPONENTS[0]}. Open Chrome, visit chrome://on-device-internals and let it download the model, then retry — this provider will not download a second copy. Set CHROME_MODEL_DIR to point at an existing one.`,
  )
}


// The prefs a scratch profile starts with. Split out because none of it
// announces a mistake: an unknown key, or a known one at the wrong nesting
// depth, is not an error Chrome reports — it is a pref that quietly never
// applies, and a test can say what the shape should be.
//
// Which Gemma answers is NOT decided here. It rides a feature param on the
// command line; see enabledFeatures in chrome.js for why the chrome://flags
// entry cannot express it.
export function localStateFor(modelDir) {
  return {
    // chrome://on-device-internals is behind a master toggle, backed by this
    // one pref. Seeding it costs nothing and is the only way to ask the
    // browser which model it actually loaded — which is not the same question
    // as which directory we pointed it at.
    internal_only_uis_enabled: true,
    // Without this the gemma components read "Not Installed" however many
    // directories are linked in: their install state is a pref, not a file.
    // Narrowed to the model being launched — see above for what the other
    // entries cost.
    ...optimizationGuidePrefs(modelDir),
  }
}
