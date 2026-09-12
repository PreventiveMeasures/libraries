// Serialising a chat history for disk, shared by every cache writer:
// setCache's final `.json`, setPartial's resume snapshot, and setInvalid's
// rejected-response dump. Split out of cache.js, which owns the entry
// layout and the read/write paths, because "make a long conversation fit
// in a string" is a problem of its own, with a recovery policy of its own.

// V8 caps string length at ~2^29 bytes and JSON.stringify throws this exact
// RangeError when a value serialises past it. Lets serializeHistory tell an
// oversized-history overflow (recoverable by dropping data) apart from a
// genuine bug (circular structure, BigInt) that should surface.
export function isMaxStringLengthError(err) {
  return err instanceof RangeError && /Invalid string length/u.test(err.message)
}

// Serialise a chat history for disk (used by BOTH setPartial and the final
// setCache), with two size reductions since long sessions — a tool loop that
// runs for tens of turns especially — get huge:
//   1. ALWAYS null `request` on every entry but the first. A turn's `request`
//      re-embeds the whole conversation-so-far plus the (repeated) system
//      prompt and tool schemas — the biggest redundant term — yet the resume
//      path reads no requests at all, and only the FIRST entry's request is
//      ever consumed (cache-key recovery via listCacheEntries /
//      rehashCache). So everything past the first is dead weight on disk.
//   2. If the slimmed history STILL overflows V8's max string length, drop
//      thinking-block signatures from all but the last 10 entries. The
//      per-entry `messages` snapshots re-embed every prior turn's (large)
//      signature, so that's the dominant residual term once requests are gone
//      — but this removes only the signatures, NOT the thinking text or tool
//      output those snapshots also carry, so an extremely long session can
//      still overflow and rethrow (see dropping interior snapshots, deferred).
// A still-too-large result rethrows, and the caller deals with it. Only the
// failed-stringify RangeError is recovered; any other error surfaces.
function serializeWith(history, wrap) {
  const slim = dropRequestsAfterFirst(history)
  try {
    return wrap(slim)
  } catch (err) {
    if (!isMaxStringLengthError(err)) throw err
    return wrap(stripThinkingSignatures(slim, 10))
  }
}

export function serializeHistory(history) {
  return serializeWith(history, (h) => JSON.stringify(h, undefined, 2))
}

// The same size policy for a REJECTED response, wrapped in an envelope
// naming why it was rejected. An `.invalid.json` is read by a person
// asking "what did the model actually send?", never by the pipeline, so
// it has to explain itself; the raw provider response sits in the history
// underneath.
export function serializeInvalid(reason, history) {
  return serializeWith(history, (h) => JSON.stringify({ reason, history: h }, undefined, 2))
}

// Null the `request` field on every entry except the first, returning a new
// array. Only entry[0].request is ever read back (cache-key recovery); the
// resume path reads none. Entries are shallow-copied (the original `request`
// objects, shared by reference with the live conversation, are never
// mutated) and the kept first entry passes through by reference.
export function dropRequestsAfterFirst(history) {
  return history.map((entry, i) => (i === 0 ? entry : { ...entry, request: null }))
}

// Return a copy of a chat history with Anthropic thinking-block signatures
// removed from every top-level entry EXCEPT the last `keepLast` — they live
// in both the replayed request messages and the raw response, and both are
// dropped. The kept tail is the slice a resume actually replays to the API
// (chat rebuilds from the last entry's snapshot + response), so its
// signatures must survive or Anthropic rejects the replayed thinking blocks;
// keeping 10 rather than just the final entry is a safety margin. Stripped
// entries are deep-cloned via a JSON round-trip, so the live in-memory
// history — whose content blocks are shared by reference with the active
// `messages` array — is never mutated.
export function stripThinkingSignatures(history, keepLast = 10) {
  const cut = Math.max(0, history.length - keepLast)
  return history.map((entry, i) => (i < cut ? stripSignatures(entry) : entry))
}

function stripSignatures(value) {
  // `this` in a JSON replacer is the object holding `key`, so drop
  // `signature` only on thinking blocks and leave any unrelated field of the
  // same name (e.g. a tool-call arg) untouched. JSON.parse rebuilds a fresh
  // tree, so no shared block is mutated.
  return JSON.parse(JSON.stringify(value, function dropSignature(key, val) {
    return key === 'signature' && this?.type === 'thinking' ? undefined : val
  }))
}
