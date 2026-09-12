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
  addUsage, calculateCost, canDisableThink, canTaskBudget, canThink, effortsFor,
  emptyUsage, getMaxTokens, isRecognizedModel, normalizeThinkEffort, resolveModel,
  resolveThinkEffort, unknownModelMessage, validateModel,
} from './src/models.js'

// One conversation, end to end: `chat()` issues the turns and hands tool
// calls back to the caller, `isResumableHistory` says whether a cached
// partial can be replayed into it, and the two helpers read what it cost.
export { chat, isResumableHistory, logTurnCost, normalizeUsage } from './src/chat.js'

// Which provider the requests go to, and the two pieces of its response
// shape a caller has to see: what a stored turn's text was, and which wire
// format wrote it.
export { setProvider, providerStamp, extractResponseText } from './src/providers.js'

// The transport under those requests: how many are in flight at once, and
// how often a transient upstream failure is re-asked.
export { RETRIES, setFetchConcurrency, setFetchRetries } from './src/fetch.js'

// The response cache on disk: where it lives — which the caller sets,
// there being no default — how an entry is addressed, and the reads and
// writes over it: final entries, resumable partials, rejected responses
// kept for a person to read...
export {
  buildCacheOpts, cacheDir, cacheKey, clearPartial, getCacheStats, getCached,
  getPartial, invalidResponseError, recordCacheHit, recordCacheMiss, setCache,
  setCacheDir, setInvalid, setPartial, setUniqueRerun,
} from './src/cache.js'
// ...and the two scans that walk what it has accumulated.
export { listCacheEntries, rehashCache } from './src/cache-scan.js'

// Turning a conversation into the JSON an entry stores, for a caller that
// writes one itself rather than through setCache.
export { serializeHistory, serializeInvalid } from './src/cache-history.js'
