// The model layer's public surface: everything outside `ai/` goes through
// this file, and nothing outside it reaches for a module by name. What is
// listed here is what the rest of the repo actually uses — a name absent
// from it is internal, free to move between the modules below without a
// single edit elsewhere. Adding to the surface is deliberate: an export
// belongs here once a caller genuinely needs it, not in advance.
//
// Inside, `ai/` stands alone — node: builtins and npm packages only, no
// import reaching back out (self-contained.test.js enforces it).
// So the layer can be read, tested, and lifted out whole.

// The model registry: which models exist, what they cost, what they can be
// asked to do, and the usage arithmetic that goes with the price table.
export {
  DEFAULT_MODEL, EFFORT_LEVELS, KNOWN_MODELS, TASK_BUDGET_MODELS, TASK_BUDGET_MODES,
  addUsage, calculateCost, canDisableThink, canEffort, canTaskBudget, canThink,
  effortsFor, emptyUsage, getMaxTokens, isRecognizedModel, normalizeThinkEffort,
  resolveModel, resolveThinkEffort, supportedModels, unknownModelMessage, validateModel,
} from './src/models.js'

// One conversation, end to end: `ask()` issues the turns, hands tool calls
// back to the caller, and resumes a partial one left behind by an
// interrupted run; the two helpers read what it cost.
export { ask, logTurnCost, normalizeUsage } from './src/chat.js'

// Which provider the requests go to, and the two pieces of its response
// shape a caller has to see: what a stored turn's text was, and which wire
// format wrote it. `closeProvider` releases whatever the active one holds
// open — only `chrome` holds anything, a browser, but a caller ending a run
// can call it without knowing which provider it picked.
export { setProvider, closeProvider, providerStamp, extractResponseText, turnCost } from './src/providers.js'

// The transport under those requests: how many are in flight at once, and
// how often a transient upstream failure is re-asked.
export { RETRIES, setFetchConcurrency, setFetchRetries } from './src/fetch-json.js'

// The response cache on disk: where it lives — which the caller sets,
// there being no default — how an entry is addressed, and the reads and
// writes over it: final entries, rejected responses kept for a person to
// read, and the retiring of one no run should pick up again...
export {
  buildCacheOpts, cacheDir, cacheKey, getCacheStats, getCached, invalidResponseError,
  invalidateCacheEntry, recordCacheHit, recordCacheMiss, setCache, setCacheDir,
  setInvalid, setUniqueRerun,
} from './src/cache.js'
// ...and the two scans that walk what it has accumulated.
export { listCacheEntries, rehashCache } from './src/cache-scan.js'

// Turning a conversation into the JSON an entry stores, for a caller that
// writes one itself rather than through setCache.
export { serializeHistory, serializeInvalid } from './src/cache-history.js'
