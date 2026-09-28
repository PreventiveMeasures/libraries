import { assert } from '#assert'
import { serializeHistory, serializeInvalid } from './cache-history.js'
import { ensureDir, join, move, moveIfExists, readTextOrNull, removeBestEffort, removeIfExists, writeAtomic } from '#fs'

// Where entries live, which is the caller's to decide and nobody else's: this layer has no idea
// what the host is, what it calls its cache, or where a deployment wants one. So there is no
// default and no environment variable read here — a default would put a run's entries somewhere
// nobody chose, and every entry the last run wrote would read as a miss.
//
// Required, therefore: every path below resolves through cacheDir(), so a caller that forgets gets
// one clear error at its first cache operation rather than a tree under a directory named
// `undefined`.
let root

export function setCacheDir(dir) {
  assert(typeof dir === 'string' && dir.length > 0, 'setCacheDir: expected a directory path')
  root = dir
}

export function cacheDir() {
  assert(root, 'Cache directory is not set — call setCacheDir() before using the cache')
  return root
}

// A few helpers below are exported for cache-scan.js alone — the entry layout is this file's, and
// the scans that walk it need to address an entry the same way. They are not on the ai/ surface.
//
// Re-exported for the callers and tests that have always imported the history helpers from here;
// they live in cache-history.js now.
export { nullAfterFirst } from './cache-history.js'

let uniqueRerun

export function setUniqueRerun(key) {
  uniqueRerun = key
}

// Process-wide tally of model-request cache lookups, counted at the caller's request sites rather
// than inside getCached — getCached also serves searches of the cache that are not requests of the
// run at all (looking for an entry written under a different context, say). A hit is a cached
// result the caller actually used; an entry rejected by the caller's format checks counts as a miss
// alongside plain not-in-cache (the run couldn't use it either way). Counters are monotonic for the
// process lifetime — consumers snapshot getCacheStats() and diff (see printCacheStats) so
// multi-input invocations report per-run windows without a reset API.
const cacheStats = { hits: 0, misses: 0 }

export function recordCacheHit() {
  cacheStats.hits += 1
}

export function recordCacheMiss() {
  cacheStats.misses += 1
}

export function getCacheStats() {
  return { ...cacheStats }
}

// Web Crypto, which a page has and node:crypto is not. Byte-identical to
// `createHash('sha256').update(str).digest('hex')`, so every key in every existing cache still
// resolves — one byte's difference would orphan all of them. Async only because `subtle.digest` is,
// which is what makes cacheKey, modelSubdir and resolveCachePaths async too.
const utf8 = new TextEncoder()

async function sha256(data) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', utf8.encode(data))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function modelSubdir(type, model, systemPrompt) {
  const safeModel = model.replaceAll('/', '-')
  assert(/^[a-zA-Z0-9._:-]+$/u.test(safeModel), `Invalid model name: ${model}`)
  // `.` and `..` clear the charset above — dots are legitimate inside a name — but as a whole
  // segment they are not a directory, they are a move. `..` would put this run's cache one level
  // ABOVE the cache root it was given, which for the server means outside the per-token directory
  // that isolates one caller's cache from another's. `/` is already folded to `-` above, so these
  // two are the only segments that can traverse.
  assert(safeModel !== '.' && safeModel !== '..', `Invalid model name: ${model}`)
  const promptHash = (await sha256(systemPrompt)).slice(0, 8)
  return join(safeModel, `${type}-${promptHash}`)
}

// One-shot migrations for cache-dir layout changes: a type a caller has since renamed, whose
// entries were written under the old name. The prompt content is unchanged across such a rename, so
// the hash and the per-entry filenames are identical — we rename the dir as a whole and let any
// failure surface. Compatibility data, not a rule about any one caller: a `new -> old` row here is
// what keeps a rename from orphaning a cache.
async function migrateTypeRename(oldType, newType, model, systemPrompt) {
  const oldDir = join(cacheDir(), await modelSubdir(oldType, model, systemPrompt))
  const newDir = join(cacheDir(), await modelSubdir(newType, model, systemPrompt))
  try {
    if (!await moveIfExists(oldDir, newDir)) return
    console.log(`[cache] migrated ${oldType} -> ${newType}`)
  } catch (err) {
    throw new Error(`Cache migration ${oldDir} -> ${newDir} failed: ${err.message}`, { cause: err })
  }
}

const TYPE_RENAMES = new Map([
  ['solidity.security', 'solidity'],
])

const migratedTypes = new Set()
export async function runTypeMigrations(type, model, systemPrompt) {
  if (migratedTypes.has(type)) return
  migratedTypes.add(type)
  const previous = TYPE_RENAMES.get(type)
  if (previous) await migrateTypeRename(previous, type, model, systemPrompt)
}

// Degrading an unreadable entry to a miss is right — a run should not die over one — but silently is
// not: each phantom miss re-spends a model request and overwrites the entry, so consecutive warm runs
// report different hit/miss totals. Hence the warning before the null.
async function tryRead(path) {
  try {
    return await readTextOrNull(path)
  } catch (err) {
    console.warn(`[cache] read failed (${err.code ?? err.message}) for ${path} — treating as a miss`)
    return null
  }
}

// Cache-key shape used by every model-call site. Accepts the resolved useThink/useEffort values
// from normalizeThinkEffort() so the cache key reflects exactly what hits the wire — folding the
// defaults in at resolution time is what stops a no-effort request and an effort=high one from
// sharing a slot because one path applied the default later.
//
// `bundleId` (optional) is an extra id folded into the key by a caller whose requests vary on
// something the model message does NOT carry — a whole workspace reached through tools, say, rather
// than sent. Only such callers pass it; for everyone else it is undefined and omitted, so their
// keys (and the returned opts shape) are unchanged by its existence.
export function buildCacheOpts(type, { model, systemPrompt, useThink, useEffort, bundleId }) {
  const opts = { type, model, systemPrompt, think: useThink, effort: useEffort }
  if (bundleId !== undefined) opts.bundleId = bundleId
  return opts
}

export async function cacheKey(systemPrompt, userContent, { think = false, effort, bundleId } = {}) {
  const info = { systemPrompt, userContent }
  if (think) info.think = true
  if (effort) info.effort = effort
  // Distinguishes one caller's inputs from another's without putting the id in userContent (the
  // model message). Omitted when absent so callers that pass none hash the exact same shape and
  // keep their entries.
  if (bundleId !== undefined) info.bundleId = bundleId
  if (uniqueRerun) info.uniqueRerun = uniqueRerun
  return await sha256(JSON.stringify(info))
}

export async function readCachedJSON(dir, key) {
  const raw = await tryRead(join(dir, `${key}.json`))
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

// Resolve `(dir, key)` from a userContent + cacheOpts pair. `subdir` is returned alongside because
// the legacy-fallback path in getCached needs to compose `<root>/old/<subdir>/<key>.md` directly.
async function resolveCachePaths(userContent, { type, model, systemPrompt, think, effort, bundleId }) {
  const subdir = await modelSubdir(type, model, systemPrompt)
  const key = await cacheKey(systemPrompt, userContent, { think, effort, bundleId })
  return { subdir, dir: join(cacheDir(), subdir), key }
}

async function readEntry(userContent, opts) {
  const { subdir, dir, key } = await resolveCachePaths(userContent, opts)
  const mdPath = join(dir, `${key}.md`)

  const fromMd = await tryRead(mdPath)
  if (fromMd) return { userContent, text: fromMd, json: await readCachedJSON(dir, key), key }

  // Legacy location: ./old/file.md
  const legacyPath = join(cacheDir(), 'old', subdir, `${key}.md`)
  const result = await tryRead(legacyPath)
  if (result) {
    await ensureDir(dir)
    await move(legacyPath, mdPath)
    return { userContent, text: result, json: null, key }
  }

  return null
}

// Read the entry for this request, or null.
//
// `validate` (optional) does two things at once, because they are the same question. It JUDGES the
// entry — an answer that no longer parses, one written under a format since changed, one carrying a
// hallucinated tool call — by returning what the caller needs out of it, or anything falsy for an
// entry this run cannot use. And passing it declares the lookup a REQUEST of the run, which is what
// gets counted: exactly one hit or miss per call, an unusable entry counting as a miss because the
// request has to be made either way. A lookup that passes none counts nothing — getCached also
// serves searches of what the cache happens to hold, which are nobody's request.
//
// Counting here rather than at the call sites is what keeps the two in step: every way a lookup can
// fail runs through this one return.
//
// `userContent` may be a LIST of candidates, tried in order. A request that could be sitting under
// more than one key — a prompt whose shape changed, a listing rendered two ways — is still one
// request, counted once. The entry that wins says which `userContent` it was found under, and
// carries `value`, whatever `validate` returned, so the work of judging it is not repeated by the
// caller.
export async function getCached(userContent, opts, { validate } = {}) {
  await runTypeMigrations(opts.type, opts.model, opts.systemPrompt)
  for (const candidate of Array.isArray(userContent) ? userContent : [userContent]) {
    const entry = await readEntry(candidate, opts)
    if (!entry) continue
    if (!validate) return entry
    const value = await validate(entry)
    if (!value) continue
    recordCacheHit()
    return { ...entry, value }
  }
  if (validate) recordCacheMiss()
  return null
}

// Returns the entry's cache key (the on-disk basename), mirroring the `key` getCached stamps on a
// hit — so a caller can name the entry it just wrote, so a caller that later scans the cache can
// recognise its own requests by exact key — fresh writes as well as hits).
export async function setCache(userContent, result, history, opts) {
  // Serialise (the same slimming as the partial) before touching disk, so an overflow throws
  // before we write a dangling `.md` — preserving the all-or-nothing behaviour from when the
  // caller stringified the history itself.
  const json = serializeHistory(history)
  const { dir, key } = await resolveCachePaths(userContent, opts)
  await ensureDir(dir)
  // `.json` before `.md`: the `.md` is the entry's existence marker (getCached and getPartial both
  // gate on it), so it must land last — otherwise a crash between the two writes leaves an `.md`
  // whose companion history is missing or stale.
  await writeAtomic(join(dir, `${key}.json`), json)
  await writeAtomic(join(dir, `${key}.md`), result)
  // This key's last word is now a usable response, so the failure record beside it is stale — and a
  // stale one is worse than none, since it invites debugging something already fixed. Best-effort:
  // the entry above is written and valid either way.
  await removeBestEffort(join(dir, `${key}${INVALID_SUFFIX}`))
  return key
}

// Partial cache: the JSON history alone, without a `.md` companion. Written per-turn by
// long-running chats so an interrupted run can resume from the last completed turn. The final
// `setCache` writes both `.md` and `.json` and naturally supersedes any partial that lives under
// the same key — no separate finalise step needed.
export async function getPartial(userContent, opts) {
  const { dir, key } = await resolveCachePaths(userContent, opts)
  // A `.md` companion means the cache is final — defer to getCached.
  if (await tryRead(join(dir, `${key}.md`))) return null
  const json = await readCachedJSON(dir, key)
  return Array.isArray(json) ? json : null
}

const taken = new Set()

// One process resumes a given partial once. The run that takes it goes on to overwrite it turn by
// turn, so a caller that asks the same thing again — retrying after an answer it rejected — must
// start fresh instead of being handed back the answer it just threw away.
export async function takePartial(userContent, opts) {
  const { subdir, key } = await resolveCachePaths(userContent, opts)
  const id = `${subdir}/${key}`
  if (taken.has(id)) return null
  taken.add(id)
  return await getPartial(userContent, opts)
}

export async function setPartial(userContent, history, opts) {
  const { dir, key } = await resolveCachePaths(userContent, opts)
  await ensureDir(dir)
  await writeAtomic(join(dir, `${key}.json`), serializeHistory(history))
}

// Rejected responses land under this suffix and are NEVER read back. The loaders can't reach one by
// construction (they gate on `<key>.md` / `<key>.json`), but the two directory scanners below have
// to skip it explicitly — rehashCache especially, since it renames `<key>.json` to a recomputed key
// and would otherwise promote a response the run REJECTED into a live entry that every later run
// serves.
const INVALID_SUFFIX = '.invalid.json'

export function isInvalidEntry(fileName) {
  return fileName.endsWith(INVALID_SUFFIX)
}

// Keep a response the run couldn't use, for a person to read: a truncation that stopped mid-answer,
// output that didn't parse, a format check the text failed. Purely diagnostic — "what did the model
// actually send?" is otherwise unanswerable once the pass has skipped the file, because nothing
// about a rejected response is written anywhere.
//
// One case is deliberately NOT kept: an empty response. There is nothing in it to read, and the run
// already records those as `censored`. `text` is how that is told apart — null/undefined means the
// REQUEST failed (truncation, transport), where the history holds exactly what we want, while an
// empty string means the model answered with nothing.
//
// Overwrites whatever sits at the key: the newest rejection is the one describing this run, and a
// stale one would be read as evidence for it. setCache deletes it outright — a valid entry means
// the key's last word was a good response, and leaving the old failure beside it invites debugging
// a problem that is already fixed.
//
// Diagnostics must never break a run, so a failed write (full disk, a history past V8's string cap)
// warns and returns instead of throwing into a pass that was already giving up on this file.
//
// invalidResponseError below is the same thing for a call site that ends in a throw rather than a
// return: keep the response, then hand back the Error to raise. A caller that aborts on a bad
// response needs it — the response is gone the moment it does.
let announcedInvalid = false
export async function setInvalid(userContent, history, opts, { reason, text }) {
  if (typeof text === 'string' && text.trim() === '') return
  const { dir, key } = await resolveCachePaths(userContent, opts)
  const path = join(dir, `${key}${INVALID_SUFFIX}`)
  try {
    const json = serializeInvalid(reason, history)
    await ensureDir(dir)
    await writeAtomic(path, json)
    // Once per process: a line per rejection would double the warning the pass already printed, and
    // what the operator needs is to learn the convention exists, not to be told again for every
    // file.
    if (!announcedInvalid) {
      announcedInvalid = true
      console.warn(`[cache] rejected responses are kept for inspection as *${INVALID_SUFFIX} (never read back), e.g. ${path}`)
    }
  } catch (err) {
    console.warn(`[cache] could not save the rejected response to ${path}: ${err.message}`)
  }
}

export async function invalidResponseError(error, userContent, history, opts) {
  await setInvalid(userContent, history, opts, { reason: error })
  return new Error(error)
}

// Take the entry at one key out of service without throwing away what it held: the answer goes, and
// the turn history moves to `.invalid.json`, which nothing reads back and a person still can. For a
// caller that will not stand behind what it got — a response that failed its format check, say — so
// no later run serves it or resumes onto it. What lands there is the bare history, not the
// `{ reason, history }` setInvalid writes: a rename costs one syscall whatever the history weighs,
// and one too big to re-serialise is exactly the kind that gets rejected.
export async function invalidateCacheEntry(userContent, opts) {
  const { dir, key } = await resolveCachePaths(userContent, opts)
  // `.md` first: it is the entry's existence marker, which is why setCache writes it last. Removing
  // it first holds the same invariant if only one of the two calls lands.
  await removeIfExists(join(dir, `${key}.md`))
  // Over whatever dump was already there, the newer evidence being the more useful. Atomic, so no
  // reader sees the history under both names, or neither.
  await moveIfExists(join(dir, `${key}.json`), join(dir, `${key}${INVALID_SUFFIX}`))
}
