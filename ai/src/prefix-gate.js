// Serializes the first request through each distinct cache prefix.
//
// A prompt-cache entry only becomes readable once the request that wrote it has replied. Fire N
// requests sharing a prefix at once and none of them can read what the others are still writing —
// every one pays the write premium instead of one write and N-1 reads at 0.1x. The runner fans out
// at `--concurrency` (20 by default), so a scan pays that on the first batch of every pass.
//
// So the first request through a given prefix goes alone and everyone else waits for it to reply,
// then proceeds in parallel against a warm entry. Only the head turn is gated: the rest of a tool
// loop is sequential anyway, and the lock is released as soon as the head replies rather than held
// for the whole chain.
//
// Requests served from the local disk cache never reach here — the caller returns before issuing —
// so a local hit neither waits nor becomes the head. That matters: a local hit writes nothing
// server-side, so treating one as the head would release the others against a prefix nobody had
// warmed.
const heads = new Map()

const NOOP = () => {}

// Everything ahead of the per-request content in the rendered prefix, which is what a cache entry
// is keyed on. Caches are model-scoped; tools render before the system prompt, so one system prompt
// with and without a given tool warms two different entries; and a run that uses several system
// prompts warms one per prompt.
export function prefixKey(model, tools, systemPrompt) {
  const toolNames = tools ? tools.map((tool) => tool.name).join(',') : ''
  return `${model}\u0000${toolNames}\u0000${systemPrompt}`
}

// Returns the function that releases the waiters. The head gets a real one and must call it once
// its response is in (a rejected request releases too, or every sibling would hang behind a
// failure); everyone else gets a no-op, having already waited.
export async function claimPrefix(key) {
  const head = heads.get(key)
  if (head) {
    await head
    return NOOP
  }
  let release
  heads.set(key, new Promise((resolve) => { release = resolve }))
  return release
}

// The settled promise stays in the map as the "already warm" marker, so this is only for tests that
// need a clean slate between cases.
export function resetPrefixGates() {
  heads.clear()
}
