import assert from 'node:assert/strict'

import { Queue } from '@chalker/queue'

import { cacheDir, cacheKey, isInvalidEntry, modelSubdir, readCachedJSON, runTypeMigrations } from './cache.js'
import { join, move, moveIfExists, readDirOrEmpty, readText } from '#fs'
import { canAdaptive } from './models.js'

// The two scans that walk what a cache has accumulated, rather than addressing one entry: listing a
// config's entries, and recomputing every key after the way keys are built has changed. Split from
// cache.js, which owns the entry layout and the read/write paths, because these read the STORED
// REQUEST back — a different problem, with the provider shapes in it.

// The inverse, for the one caller that walks a model's cache instead of addressing an entry:
// recover the request type from a subdirectory name. The prompt hash is a fixed 8 hex chars, so the
// type is everything before the last dash — dashes inside a type (`null-low`) survive. Returns null
// for a name modelSubdir didn't write, which a caller leaves alone rather than guessing about.
const SUBDIR_RE = /^(?<type>.+)-[0-9a-f]{8}$/u

function subdirType(name) {
  return SUBDIR_RE.exec(name)?.groups.type ?? null
}

function flattenContent(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((b) => b?.text ?? '').join('')
  return null
}

// Extract the cacheKey inputs from an Anthropic request body. Returns null for non-Anthropic
// requests (OpenRouter puts the system message inside `messages`, not at the top level).
function anthropicRequestKey(req, model) {
  if (!req || typeof req !== 'object' || !req.system) return null
  const systemPrompt = flattenContent(req.system)
  if (!systemPrompt) return null
  const firstMsg = req.messages?.[0]
  if (!firstMsg || firstMsg.role !== 'user') return null
  const userContent = flattenContent(firstMsg.content)
  if (!userContent) return null
  // `{ type: 'disabled' }` is an explicit no-think (needsExplicitNoThink models), so the field's
  // presence alone doesn't mean thinking was on — reading it that way would rehash those entries to
  // a key no lookup generates.
  const think = Boolean(req.thinking) && req.thinking.type !== 'disabled'
  let effort
  if (req.thinking?.type === 'adaptive') {
    effort = req.output_config?.effort
  } else if (req.thinking?.type === 'enabled' && canAdaptive(model)) {
    // An adaptive-capable model with explicit enabled+budget thinking means the user asked for
    // --effort manual.
    effort = 'manual'
  }
  return { systemPrompt, userContent, think, effort }
}

// Pull the request's userContent (prefix + any suffix) back out of a stored request, across
// provider shapes. Anthropic/OpenRouter carry the chat in `messages` (system is separate / first);
// OpenAI Responses uses `input`. In all three the first `role: 'user'` entry holds it. Multi- block
// Anthropic content (the cached-prefix split) is flattened back to the single string the cache key
// was hashed over, so the value round-trips exactly through cacheKey(). Returns null for shapes
// that don't carry a user message.
function requestUserContent(req) {
  // Chrome's Prompt API body: history in `initialPrompts`, the asked turn here.
  if (typeof req?.prompt === 'string') return req.prompt
  const list = Array.isArray(req?.messages) ? req.messages : (Array.isArray(req?.input) ? req.input : null)
  if (!list) return null
  const user = list.find((m) => m && m.role === 'user')
  if (!user) return null
  return flattenContent(user.content)
}

// Enumerate cached request/response entries for one request config (type + model + systemPrompt +
// think/effort), returning each entry's on-disk key alongside the userContent recovered from its
// stored request. Only entries whose stored key reproduces from their own userContent under the
// requested think/effort are returned — the filename IS the cache key, so this gate drops
// mismatched think/effort AND, for free, entries written with a bundleId or under a foreign
// unique-rerun key (both fold extra fields into the stored key that the recompute here omits). Runs
// the same type migrations getCached does so a legacy (pre-rename) dir is still found. Returns []
// when the directory doesn't exist. The .md result text is NOT read here — callers that match an
// entry fetch it via getCached(userContent, …), which recomputes the same key and reads the
// companion .md.
//
// The per-entry read + parse + key-recompute is the dominant cost (a cache worth searching has
// accreted across many runs), so the scan fans out under `concurrency` — overlapping the disk I/O
// the way a caller's own fan-out does. `out` is pushed from parallel tasks so its order is
// nondeterministic; callers that care re-sort it.
export async function listCacheEntries(type, model, systemPrompt, { think = false, effort, concurrency = 20 } = {}) {
  await runTypeMigrations(type, model, systemPrompt)
  const dir = join(cacheDir(), await modelSubdir(type, model, systemPrompt))
  const dirents = await readDirOrEmpty(dir)
  const queue = new Queue(concurrency)
  const out = []
  await Promise.all(dirents.map(async (dirent) => {
    // `.invalid.json` is a dump of a response that never parsed, not an entry — reading it here
    // would cost a parse only to reject it.
    if (!dirent.isFile() || !dirent.name.endsWith('.json') || isInvalidEntry(dirent.name)) return
    await queue.claim()
    try {
      const key = dirent.name.slice(0, -'.json'.length)
      const json = await readCachedJSON(dir, key)
      if (!json) return
      // Cache JSON is either a single { request, response } or an array of turns. serializeHistory
      // nulls `request` on every entry but the first, so only json[0].request is reliable here —
      // fine, the key was hashed from the first turn's userContent.
      const firstTurn = Array.isArray(json) ? json[0] : json
      const userContent = requestUserContent(firstTurn?.request ?? firstTurn)
      if (userContent === null) return
      if (await cacheKey(systemPrompt, userContent, { think, effort }) !== key) return
      out.push({ key, userContent })
    } finally {
      queue.release()
    }
  }))
  return out
}

// Scan cache files for the given model, recompute each key from the logged Anthropic request, and
// rename .json/.md pairs whose filename no longer matches. Useful after changing how cacheKey is
// computed.
//
// `skipType` names the request types whose entries must NOT be touched, and is the caller's to
// supply: this directory answers for model requests and the cache they land in, and which types
// exist is the caller's own business. It defaults to skipping nothing, so a caller whose cache
// holds entries this can't rehash — anything keyed on a bundleId, whose key cannot be recomputed
// from the stored request — has to say so.
export async function rehashCache(model, { skipType = () => false } = {}) {
  const safeModel = model.replaceAll('/', '-')
  assert.ok(/^[a-zA-Z0-9._:-]+$/u.test(safeModel), `Invalid model name: ${model}`)
  const modelDir = join(cacheDir(), safeModel)

  const result = { scanned: 0, renamed: 0, unchanged: 0, skipped: 0, errors: 0 }
  const subdirs = await readDirOrEmpty(modelDir)
  for (const entry of subdirs) {
    if (!entry.isDirectory()) continue
    const entryType = subdirType(entry.name)
    if (entryType !== null && skipType(entryType)) continue
    const dir = join(modelDir, entry.name)
    const files = await readDirOrEmpty(dir)
    for (const file of files) {
      // Never rehash a rejected-response dump: renaming it to a recomputed key would turn it into
      // `<key>.json`, which every later run then loads as a real cached result.
      if (!file.isFile() || !file.name.endsWith('.json') || isInvalidEntry(file.name)) continue
      result.scanned += 1
      const oldKey = file.name.slice(0, -'.json'.length)
      const jsonPath = join(dir, `${oldKey}.json`)
      let parsed
      try {
        parsed = JSON.parse(await readText(jsonPath))
      } catch (err) {
        console.warn(`[rehash] ${jsonPath}: failed to parse (${err.message})`)
        result.errors += 1
        continue
      }

      // Cache JSON is either a single { request, response } or an array of turns. Only
      // json[0].request survives serializeHistory's slimming (later entries are nulled); the key
      // recomputes from the first turn anyway.
      const firstTurn = Array.isArray(parsed) ? parsed[0] : parsed
      const keyInput = anthropicRequestKey(firstTurn?.request ?? firstTurn, model)
      if (!keyInput) {
        result.skipped += 1
        continue
      }

      const newKey = await cacheKey(keyInput.systemPrompt, keyInput.userContent, {
        think: keyInput.think, effort: keyInput.effort,
      })
      if (newKey === oldKey) {
        result.unchanged += 1
        continue
      }

      try {
        await move(jsonPath, join(dir, `${newKey}.json`))
        await moveIfExists(join(dir, `${oldKey}.md`), join(dir, `${newKey}.md`))
        result.renamed += 1
        console.log(`[rehash] ${dir}: ${oldKey} -> ${newKey}`)
      } catch (err) {
        console.warn(`[rehash] ${jsonPath}: rename failed (${err.message})`)
        result.errors += 1
      }
    }
  }
  return result
}
