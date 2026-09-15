// Serialising a chat history for disk, shared by every cache writer: setCache's final `.json`,
// setPartial's resume snapshot, and setInvalid's rejected-response dump. Split out of cache.js,
// which owns the entry layout and the read/write paths, because "make a long conversation fit in a
// string" is a problem of its own.

// Serialise a chat history for disk (used by BOTH setPartial and the final setCache). Both fields
// that re-embed the conversation-so-far are dropped first, because every one of them but the two
// that get read is a copy of what the turns around it already say, and setPartial rewrites the
// whole file after every turn — so what a session pays for them is cubic in its length, not square.
//   1. Null `request` on every entry but the first. It re-embeds the conversation-so-far plus the
//      repeated system prompt and tool schemas, and only entry 0's is ever read back (cache-key
//      recovery via listCacheEntries / rehashCache); resume reads none of them. `keepRequests` is
//      for the one caller that cannot say that — see normalizeCacheFile, which meets histories
//      this layer did not write, whose answers are recorded nowhere else.
//   2. ALWAYS null `messages` on every entry but the first. It is that turn's pre-turn snapshot,
//      and a snapshot is not information: it is entry 0's, plus what appendToolResults makes of
//      each turn's own response, toolCalls and results — all of which the entries already carry.
//      Resume replays them (see ask()) rather than reading a recorded copy of the same thing.
// There is no recovery below that. A history that still overflows V8's max string length throws,
// and the caller deals with it: setPartial's failure is logged and the run carries on, setInvalid
// warns, setCache is the caller's to catch.
const SLIM = ['request', 'messages']

function serializeWith(history, fields, wrap) {
  return wrap(nullAfterFirst(history, ...fields))
}

export function serializeHistory(history, { keepRequests } = {}) {
  return serializeWith(history, keepRequests ? ['messages'] : SLIM, (h) => JSON.stringify(h, undefined, 2))
}

// The same size policy for a REJECTED response, wrapped in an envelope naming why it was rejected.
// An `.invalid.json` is read by a person asking "what did the model actually send?", never by the
// pipeline, so it has to explain itself; the raw provider response sits in the history underneath.
export function serializeInvalid(reason, history) {
  return serializeWith(history, SLIM, (h) => JSON.stringify({ reason, history: h }, undefined, 2))
}

// Null the named fields on every entry except the first, returning a new array. Entries are
// shallow-copied — the objects those fields held are shared by reference with the live
// conversation and are never mutated — and the kept first entry passes through as it is.
//
// A field an entry does not have stays away rather than arriving as a null: this runs over stored
// histories as well as live ones, and inventing a key there turns a rewrite that had nothing to
// drop into a file bigger than the one it replaced.
export function nullAfterFirst(history, ...fields) {
  return history.map((entry, i) => {
    if (i === 0) return entry
    const present = fields.filter((field) => entry[field] !== undefined)
    return { ...entry, ...Object.fromEntries(present.map((field) => [field, null])) }
  })
}
