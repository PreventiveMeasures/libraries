import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { specNamesFor } from '../models.js'

// Where the on-device weights are, which is a separate question from how the
// browser is driven — see index.js for that.

// Two stores, different shapes: nano_v3 lives under the first, the gemma
// models under the second, keyed by a content hash above the version.
const MODEL_COMPONENTS = ['OptGuideOnDeviceModel', 'OptGuideManifestModel']

// Grafted whole but never searched for weights: it records which manifest
// models exist rather than holding any.
const LEDGER_COMPONENT = 'OptimizationGuideModelsManifest'

// Where Chrome keeps its user data, and so the component tree inside it. Only
// consulted to FIND resident weights; which Chrome runs is playwright's.
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

// Whether a path sits inside a root, and where.
function positionIn(root, dir) {
  if (!root || !dir) return undefined
  const rel = relative(root, dir)
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : undefined
}

// Which candidate root a model directory belongs to.
export function rootOwning(roots, modelDir) {
  return (roots ?? []).find((root) => positionIn(root, modelDir))
}

// The user data dir to seed state from: the root that HOLDS the model, since
// discovery searches every channel and the first root with any component can
// be a different Chrome's.
function activeUserDataDir(modelDir) {
  const roots = USER_DATA_DIRS[process.platform] ?? []
  // No owner means a CHROME_MODEL_DIR outside every root: nothing to mirror,
  // and the execution override names it outright, so any root will do here.
  return rootOwning(roots, modelDir) ??
    roots.find((dir) => MODEL_COMPONENTS.some((component) => existsSync(join(dir, component))))
}

// What to link into a scratch profile, as {from, rel} pairs: `from` is the
// real path, `rel` where it goes relative to the profile root.
//
// Only the ONE model asked for, so nothing else is in front of the browser.
// Paths are mirrored rather than flattened, since the two stores nest
// differently and Chrome reads the shape.
export function graftPlan(modelDir) {
  return graftPlanIn(activeUserDataDir(modelDir), modelDir)
}

// The decision, separated from finding the profile it applies to.
export function graftPlanIn(userDataDir, modelDir) {
  if (!userDataDir) return []
  const plan = []
  const ledger = join(userDataDir, LEDGER_COMPONENT)
  if (existsSync(ledger)) plan.push({ from: ledger, rel: LEDGER_COMPONENT })
  // A CHROME_MODEL_DIR outside the user data dir has no position to mirror;
  // the override switch names it outright.
  const rel = positionIn(userDataDir, modelDir)
  if (rel) plan.push({ from: modelDir, rel })
  return plan
}

// What a scratch profile inherits from the real one: one entry of one map,
// named rather than arrived at by deleting the rest, so nothing unexamined
// comes along.
//
// `optimization_guide.model_execution.manifest_asset_ledger` holds a standing
// REQUEST per component — an asset_id and a requested_version — and the entry
// for the linked model is what makes the browser load it. Only that entry
// travels: the others name models this profile does not have, and Chrome goes
// and fetches them. The entry itself is passed through, so a field Chrome
// adds to it still arrives.
function optimizationGuidePrefs(modelDir) {
  const dir = activeUserDataDir(modelDir)
  if (!dir) return {}
  try {
    return portableGuide(JSON.parse(readFileSync(join(dir, 'Local State'), 'utf8'))?.optimization_guide, modelDir)
  } catch { return {} }
}

// The ledger is keyed by the content hash a manifest model sits under, and
// `requested_version` is its version directory — so the linked model's own
// path names its entry, under either layout:
//
//   OptGuideManifestModel/<hash>/<version>   the hash, which is the component
//   OptGuideOnDeviceModel/<version>          the version, all the flat layout
//                                            carries
//
// In that order, because the halves are not equally identifying: versions are
// dates and two components can share one, while the hash is the component.
// An order rather than a requirement — `requested_version` may point past
// what is installed, and demanding both would then match nothing, leaving a
// profile that asks for no model at all.
function findLedgerEntry(ledger, modelDir) {
  if (!ledger || !modelDir) return undefined
  const parts = new Set(modelDir.split(/[/\\]/u))
  const entries = Object.entries(ledger)
  return entries.find(([hash]) => parts.has(hash)) ?? entries.find(([, entry]) => parts.has(entry?.requested_version))
}

// No ledger entry found means no ledger: that is a CHROME_MODEL_DIR outside
// the component tree, where the real profile's ledger would claim components
// this one does not have — the fetch all of this exists to prevent.
export function portableGuide(guide, modelDir) {
  const found = findLedgerEntry(guide?.model_execution?.manifest_asset_ledger, modelDir)
  if (!found) return {}
  return { optimization_guide: { model_execution: { manifest_asset_ledger: { [found[0]]: found[1] } } } }
}


// Numeric, not lexicographic: component versions are dotted numbers, and a
// string sort puts 2025.8.8 after 2025.8.11.
function compareVersions(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d !== 0) return d
  }
  return 0
}

// Every component root that exists, not the first: a stale or empty stable
// root would otherwise hide a Canary install that has the weights.
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

// Directories holding weights, across both layouts: OptGuideOnDeviceModel is
// flat, OptGuideManifestModel nests a hash above the version. A superseded or
// interrupted install leaves a directory with no weights in it, so the file
// decides rather than the directory.
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

// The same model carries three names and no two match: Google publishes
// gemma-4-E2B-it, which the registry rows follow; Chrome lists a deployment
// variant, gemma4_gpu_high_tier_model, which baseModel follows; and the
// component manifest declares a BaseModelSpec, gemma4-2b-it, which is what a
// directory says about itself.
//
// Nor is the difference computable — the specs in the wild are
// "v3Nano", "gemma4-2b-it" and "gemma-4-E4B-it", and anything loose enough to
// relate gemma4_2b to gemma4-2b-it also relates it to gemma-4-E4B-it. So the
// accepted names live on the registry row, compared here ignoring case and
// punctuation only.
function normalizeSpec(name) {
  return String(name).toLowerCase().replaceAll(/[^a-z0-9]+/gu, '')
}

// Not every manifest has a BaseModelSpec. Those that do carry the generic
// "Optimization Guide On Device Model" at the top level and the real identity
// underneath; the 12B one has no spec and puts its identity in the top-level
// name instead:
//
//   { "name": "Optimization Guide On-Device Gemma4 12B Model",
//     "version": "<version>" }
//
// So the spec wins where it exists and the name stands in where it does not.
// Normalised, the generic name (…ondevicemodel) stays distinct from the 12B
// one (…ondevicegemma412bmodel), so the fallback cannot cross-match.
function declaredSpec(dir) {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
    return manifest?.BaseModelSpec?.name ?? manifest?.name ?? null
  } catch { return null }
}

// That top-level name is a template, so it is derived rather than
// transcribed: normalised, "Optimization Guide On-Device Gemma4 12B Model" is
// this for a baseModel of gemma4_12b, and a future size needs no edit here.
function componentNameFor(baseModel) {
  return `optimization_guide_on-device_${baseModel}_model`
}

// Every name a row answers to: the specs its manifest may declare, and the
// component name it carries if it declares none.
function acceptedNames(baseModel) {
  return [...specNamesFor(baseModel), componentNameFor(baseModel)]
}

export function identifiesAs(dir, baseModel) {
  const declared = declaredSpec(dir)
  if (!declared) return false
  return acceptedNames(baseModel).some((name) => normalizeSpec(name) === normalizeSpec(declared))
}

// Weights for a base model spec, or the newest installed when none is named.
// A named spec that cannot be identified is an error rather than a fallback:
// the turn would be labelled and CACHED under a row that another model
// answered.
export function findModelDir(baseModel) {
  const override = process.env.CHROME_MODEL_DIR
  if (override) {
    // Checked here so a typo fails at setProvider rather than after the
    // two-minute wait for a model that was never going to load.
    assert.ok(existsSync(join(override, 'weights.bin')), `CHROME_MODEL_DIR has no weights.bin: ${override}`)
    return override
  }
  const all = modelComponentRoots().flatMap((root) => candidateModelDirs(root))
  // The unnamed call is an "is there anything at all" probe, so it answers
  // rather than throws.
  if (!baseModel) return all.length > 0 ? all.sort((a, b) => compareVersions(a.version, b.version)).at(-1).dir : undefined
  all.sort((a, b) => compareVersions(a.version, b.version))
  const matches = all.filter(({ dir }) => identifiesAs(dir, baseModel))
  if (matches.length > 0) return matches.at(-1).dir
  throw new Error(missingModelMessage(baseModel, all))
}

// A model Chrome does not have is a stop: this provider does not download and
// the browser it launches cannot either, so the message says where one comes
// from. Listing what IS installed separates the two ways to get here —
// nothing resembling the request means it was never downloaded, something
// resembling it means Chrome renamed it, which is a one-line edit.
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

// Fails at setProvider, the way a missing API key does, rather than on the
// first turn. Only the weights: which Chrome to run resolves at launch, where
// playwright's own error names the path it expected.
export function chromePreflight() {
  assert.ok(
    findModelDir(),
    `No on-device model found under ${MODEL_COMPONENTS[0]}. Open Chrome, visit chrome://on-device-internals and let it download the model, then retry — this provider will not download a second copy. Set CHROME_MODEL_DIR to point at an existing one.`,
  )
}


// The prefs a scratch profile starts with. Nothing here announces a mistake:
// an unknown key, or a known one at the wrong depth, is not an error Chrome
// reports but a pref that quietly never applies.
//
// Which Gemma answers is NOT decided here — that rides a feature param; see
// enabledFeatures in index.js.
export function localStateFor(modelDir) {
  return {
    // Unlocks chrome://on-device-internals, which under CHROME_HEADLESS=0 is
    // where to see what the browser actually loaded — a different question
    // from which directory it was pointed at.
    internal_only_uis_enabled: true,
    // Without this the gemma components read "Not Installed" however many
    // directories are linked in: install state is a pref, not a file.
    ...optimizationGuidePrefs(modelDir),
  }
}
