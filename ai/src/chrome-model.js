import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { specNamesFor } from './models.js'

// Where the on-device weights are, which is a separate question from how the
// browser is driven — see chrome.js for that.

// Two stores, different shapes: nano_v3 lives under the first, gemma4 and
// gemma4_4b under the second, keyed by a content hash above the version.
export const MODEL_COMPONENTS = ['OptGuideOnDeviceModel', 'OptGuideManifestModel']

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
export function modelComponentRoots() {
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
// Chrome names the same model two ways: chrome://on-device-internals lists
// the variant (nano_v3_gpu_high_tier_model, which the registry ids come
// from), while the component manifest declares a BaseModelSpec — "v3Nano".
// Those do not match as strings, which is how a strict check rejected a
// working nano_v3.
//
// Nor is the difference a rule that can be computed: the three specs in the
// wild are "v3Nano", "gemma4-2b-it" and "gemma-4-E4B-it", which share no
// shape. Anything loose enough to relate gemma4 to gemma4-2b-it also relates
// it to gemma-4-E4B-it, and quietly picking the wrong one is the bug this
// check exists to prevent. So the accepted names live on the registry row and
// are compared here, ignoring case and punctuation only.
function normalizeSpec(name) {
  return String(name).toLowerCase().replaceAll(/[^a-z0-9]+/gu, '')
}

// The manifest's declared name, when there is one to read.
export function declaredSpec(dir) {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
    return manifest?.BaseModelSpec?.name ?? null
  } catch { return null }
}

export function identifiesAs(dir, specNames) {
  const declared = declaredSpec(dir)
  if (!declared) return false
  return specNames.some((name) => normalizeSpec(name) === normalizeSpec(declared))
}

// Weights for a base model spec, or the newest installed when none is named.
//
// A named spec that cannot be identified is an error rather than a fallback.
// Falling back looked harmless and was not: the turn would be labelled and
// CACHED as chrome/gemma4 while nano_v3 actually answered it — a wrong answer
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
  if (all.length === 0) return undefined
  all.sort((a, b) => compareVersions(a.version, b.version))
  if (!baseModel) return all.at(-1).dir
  const specNames = specNamesFor(baseModel)
  const matches = all.filter(({ dir }) => identifiesAs(dir, specNames))
  if (matches.length > 0) return matches.at(-1).dir
  throw new Error(
    `No installed on-device model declares itself as ${specNames.map((n) => `"${n}"`).join(' or ') || `"${baseModel}"`}. ` +
    `Found: ${all.map((m) => `${declaredSpec(m.dir) ?? 'unnamed'} at ${m.dir}`).join('; ')}. ` +
    'Add the name to specNames in models.js, or set CHROME_MODEL_DIR.',
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
