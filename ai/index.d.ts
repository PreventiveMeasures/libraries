// The typed contract for ai/index.js, hand-written because the layer is
// plain JavaScript and its one TypeScript consumer (the server) runs with
// allowJs off. One file rather than a .d.ts per module: index.js IS the
// surface, so the declarations below should read against it name for name,
// in the same order and under the same headings.
//
// Keep it honest. Nothing checks these against the implementation — a
// declaration that drifts is a silent lie to every caller that trusts it,
// so a change to an exported signature belongs in the same commit as the
// change here.
//
// The shapes below are declared, not exported: they exist to write the
// signatures with, and no caller outside ai/ names one. Exporting one is a
// word's change when a caller does.

// What a request cost, in tokens and in dollars. `cacheRead` /
// `cacheWrite5m` / `cacheWrite1h` are prompt-cache tokens, priced off the
// model's input rate; `cost` is the provider's own number when it ships one
// and the price table's otherwise.
interface Usage {
  input: number
  output: number
  cacheRead: number
  cacheWrite5m: number
  cacheWrite1h: number
  cost: number
}

// A tool offered to the model, in the Anthropic spelling the adapters
// translate from.
interface Tool {
  name: string
  description: string
  input_schema: unknown
}

// One tool call out of a response: `args` on success, `argsError` when the
// model produced JSON that didn't parse. `id` is whatever the provider
// needs back to match the result to the call.
interface ToolCall {
  id: string
  name: string
  args?: unknown
  argsError?: string | undefined
}

// One completed turn, as the cache stores it and as a resume replays it.
// `request` and `response` are provider-shaped; `messages` is the pre-turn
// snapshot the loop rebuilds its state from.
interface HistoryEntry {
  request: unknown
  response: unknown
  messages: unknown[]
  toolCalls: ToolCall[]
  results: string[]
  provider?: string | undefined
  error?: string | undefined
}

// One entry as it comes back off disk: the response text, the turn history
// stored beside it, the on-disk key, and which candidate content it was
// found under.
interface CacheEntry {
  userContent: string
  text: string
  json: unknown
  key: string
}

// What addresses one cache entry: the request type, the model, the system
// prompt, the resolved think/effort, and an optional extra id for a caller
// whose requests vary on something the model message does not carry.
interface CacheOpts {
  type: string
  model: string
  systemPrompt: string
  think: boolean
  effort?: string | undefined
  bundleId?: string | undefined
}

// The model registry: which models exist, what they cost, what they can be
// asked to do, and the usage arithmetic that goes with the price table.
//
// The capability predicates take `unknown` on purpose: the server asks them
// about a model id straight off a request, before anything has established
// it is even a string.
export declare const DEFAULT_MODEL: string
export declare const EFFORT_LEVELS: readonly string[]
// The price table's model names — what the console OFFERS, never what the
// API allows: `model` is free text and an unknown one is simply unpriced.
export declare const KNOWN_MODELS: readonly string[]
export declare const TASK_BUDGET_MODELS: ReadonlySet<string>
export declare const TASK_BUDGET_MODES: readonly string[]
export declare function addUsage(total: Usage, usage: Usage | null | undefined): void
export declare function calculateCost(model: string, usage: Usage): number | null
export declare function canDisableThink(model: unknown): boolean
export declare function canEffort(model: unknown): boolean
export declare function canTaskBudget(model: unknown): boolean
export declare function canThink(model: unknown): boolean
export declare function effortsFor(model: unknown): readonly string[] | undefined
export declare function emptyUsage(): Usage
export declare function getMaxTokens(model: string): number
export declare function isRecognizedModel(model: unknown): boolean
export declare function normalizeThinkEffort(model: string, think: unknown, effort?: string): { useThink: boolean, useEffort: string | undefined }
export declare function resolveModel(model: string): string
// normalizeThinkEffort for a request about to go out: throws where that one
// silently drops what the model cannot do.
export declare function resolveThinkEffort(model: string, think: unknown, effort?: string): { useThink: boolean, useEffort: string | undefined }
export declare function unknownModelMessage(model: unknown, flag: string): string
// Throws when the model is blocked, or when its free/paid status disagrees
// with the `free` flag.
export declare function validateModel(model: string, opts?: { free?: boolean | undefined }): void

// One conversation, end to end: `ask()` issues the turns, hands tool calls
// back to the caller, and resumes a partial one left behind by an
// interrupted run; the two helpers read what it cost.
interface AskOptions {
  model: string
  maxTokens: number
  systemPrompt: string
  // One string, or a list of blocks whose LAST one is the part that varies.
  // On routes that read a cache marker, one is placed immediately before that
  // block, so variants sharing a preamble read one entry for it instead of
  // each writing its own. The cache key is the blocks joined, so how a
  // message is split never changes what it is keyed on.
  userContent: string | string[]
  think?: boolean | undefined
  effort?: string | undefined
  // Both or neither: a tool the caller can't answer is a caller error.
  tools?: Tool[] | undefined
  handleToolCall?: ((call: ToolCall) => string | Promise<string>) | undefined
  maxToolTurns?: number | undefined
  // Surviving an interruption, both halves of it: the cache options a
  // running history is written under after every turn, and the partial this
  // call looks for before its first request. One process resumes a given
  // partial once, so a retry of a rejected answer starts fresh.
  partial?: CacheOpts | undefined
  // The turns being resumed, `[]` on a fresh run, before the first request
  // goes out — for a caller whose tools carry state those turns rebuild.
  onStart?: ((history: HistoryEntry[]) => void | Promise<void>) | undefined
  debug?: boolean | undefined
  debugRequests?: boolean | undefined
  label?: string | undefined
  taskBudget?: string | undefined
}

// `text` is null exactly when `error` is set — a failed request, malformed
// tool args, or the turn cap. `usage` and `history` are whole either way,
// so the caller can account for and cache what it did spend.
interface AskResult {
  text: string | null
  error?: string | undefined
  usage: Usage
  history: HistoryEntry[]
}

export declare function ask(options: AskOptions): Promise<AskResult>
export declare function logTurnCost(label: string, model: string, usage: Usage, pass?: string | undefined): void
// Sums a stored history, or reads a single stored response. Null when
// nothing in it carried usage.
export declare function normalizeUsage(data: unknown): Usage | null

// Which provider the requests go to, and the two pieces of its response
// shape a caller has to see: what a stored turn's text was, and which wire
// format wrote it.
//
// Throws on an unknown provider name, a missing API key, or a gateway with
// no configured URL. `chrome` is the local one: no key and no URL, but it
// throws here too when Chrome has no on-device model downloaded to borrow.
export declare function setProvider(name: string): void
// Release what the active provider holds open. A no-op for every provider
// but `chrome`, whose browser keeps the event loop alive until it is closed,
// so a caller can end a run with this unconditionally.
export declare function closeProvider(): Promise<void>
// Names the wire format a history entry was written under, so a partial is
// never replayed into a request the other format's shapes can't fill.
export declare function providerStamp(model: string): string | undefined
export declare function extractResponseText(response: unknown): string

// The transport under those requests: how many are in flight at once, and
// how often a transient upstream failure is re-asked.
export declare const RETRIES: number
export declare function setFetchConcurrency(limit: number): void
// Anything but a positive integer restores the RETRIES floor, so an unset
// flag can be passed through without thought.
export declare function setFetchRetries(n: unknown): void

// The response cache on disk: where it lives, how an entry is addressed,
// and the reads and writes over it — final entries, rejected responses kept
// for a person to read, the retiring of one no run should pick up again,
// and the two scans that walk what has accumulated.
//
// The directory is the caller's to set, and there is no default: every
// other call here throws until setCacheDir has been given one.
export declare function setCacheDir(dir: string): void
export declare function cacheDir(): string
export declare function buildCacheOpts(type: string, resolved: {
  model: string
  systemPrompt: string
  useThink: boolean
  useEffort?: string | undefined
  bundleId?: string | undefined
}): CacheOpts
export declare function cacheKey(systemPrompt: string, userContent: string, opts?: {
  think?: boolean | undefined
  effort?: string | undefined
  bundleId?: string | undefined
}): string
// Takes the entry at this key out of service, for a caller holding an answer no later run should
// serve or resume onto — one that failed its format check, say. The answer goes; its turn history
// moves to `.invalid.json`, over any dump already there, where a person can still read it.
export declare function invalidateCacheEntry(userContent: string, opts: CacheOpts): Promise<void>
// Monotonic for the process lifetime: snapshot and diff for a per-run window.
export declare function getCacheStats(): { hits: number, misses: number }
// `json` is the stored turn history, `key` the entry's on-disk basename,
// `userContent` the candidate this entry was found under.
//
// `validate` judges the entry — returning what the caller needs out of it,
// or anything falsy for one this run cannot use — and declares the lookup a
// request of the run, so exactly one hit or miss is counted for it. What it
// returned comes back as `value`. Without it nothing is counted.
//
// `userContent` may be a list of candidate keys, tried in order: still one
// request, counted once. The opposite of what a list means to ask(), which
// joins its blocks into one key — so join them before looking one up here.
export declare function getCached<T>(userContent: string | string[], opts: CacheOpts, options: {
  validate: (entry: CacheEntry) => T | Promise<T>
}): Promise<(CacheEntry & { value: Awaited<T> }) | null>
export declare function getCached(userContent: string | string[], opts: CacheOpts): Promise<CacheEntry | null>
// Keeps the rejected response for inspection, then hands back the Error to
// throw — for a call site that gives up rather than returns.
export declare function invalidResponseError(error: string, userContent: string, history: HistoryEntry[], opts: CacheOpts): Promise<Error>
export declare function listCacheEntries(type: string, model: string, systemPrompt: string, opts?: {
  think?: boolean | undefined
  effort?: string | undefined
  concurrency?: number | undefined
}): Promise<{ key: string, userContent: string }[]>
export declare function recordCacheHit(): void
export declare function recordCacheMiss(): void
// `skipType` names the request types whose entries must not be touched —
// see index.js. Never throws on a cache it cannot read: the counts say what
// happened.
export declare function rehashCache(model: string, opts?: {
  skipType?: ((type: string) => boolean) | undefined
}): Promise<{ scanned: number, renamed: number, unchanged: number, skipped: number, errors: number }>
// Returns the entry's cache key, so a caller can name what it just wrote.
export declare function setCache(userContent: string, result: string, history: HistoryEntry[], opts: CacheOpts): Promise<string>
// Diagnostic only, and never throws: a failed write warns and returns.
export declare function setInvalid(userContent: string, history: HistoryEntry[], opts: CacheOpts, info: { reason: string, text?: string | undefined }): Promise<void>
// Folds an extra key into every cache key for this process, so a run can be
// repeated without reading what the last one wrote.
export declare function setUniqueRerun(key: string): void

// Turning a conversation into the JSON an entry stores, for a caller that
// writes one itself rather than through setCache.
export declare function serializeHistory(history: HistoryEntry[]): string
export declare function serializeInvalid(reason: string, history: HistoryEntry[]): string
