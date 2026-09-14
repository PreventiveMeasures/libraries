import { assert } from '#assert'
import { byteLength, join, readDirOrEmpty, readText, writeAtomic } from '#fs'

import { isInvalidEntry } from './cache.js'
import { serializeHistory } from './cache-history.js'
import { appendTurn, isStoredHistory } from './chat.js'

// Bringing stored histories into the shape the writers use now. Its own module because it is the
// one thing in the cache that reaches for the conversation loop: proving a dropped snapshot is
// reproducible means replaying it through the same adapter that built it, and neither cache.js nor
// cache-scan.js should pull the provider layer in at load just to hold this.

// Both sides of every comparison here came out of JSON.parse, or out of an adapter building on
// what did, so this covers every value either can hold — and does it without node:util, which a
// browser build has no half for.
function sameJson(a, b) {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => key in b && sameJson(a[key], b[key]))
}

// Rewrite one stored history in the form serializeHistory writes now: entry 0 keeps its request
// and its `messages` snapshot, every later entry keeps neither. For files written before the
// snapshots came out — the ones that grew with the square of the session — since nothing rewrites
// an entry that is never asked for again.
//
// Nothing is dropped on trust. The slim text is produced first and read back, and every snapshot
// it no longer holds is rebuilt from THAT — not from the history in hand — and compared to what
// the old file recorded. A file that does not come back identical throws untouched.
//
// `selectProvider` (optional) is handed the stamp the entries carry, before the replay and only
// when there is one, for a caller normalizing a directory written by more than one provider: the
// replay runs through whichever adapter is set, and under the wrong one it builds the wrong
// shapes. It is called once per file at most, so the parse happens once — these are the files that
// grew with the square of a session, and reading one twice to learn one string is the most
// expensive thing here.
//
// Returns what it did and what it cost: `skipped` for a file that holds no history, `unchanged`
// for one already in this form, `normalized` otherwise.
export async function normalizeCacheFile(path, { selectProvider } = {}) {
  const raw = await readText(path)
  // Bytes, not UTF-16 units: the caller reports these as a size on disk.
  const size = byteLength(raw)
  const same = (status) => ({ status, before: size, after: size })
  let history
  try {
    history = JSON.parse(raw)
  } catch {
    return same('skipped')
  }
  if (!isStoredHistory(history)) return same('skipped')

  const slim = serializeHistory(history)
  if (slim === raw) return same('unchanged')

  // Only when there is a snapshot to prove, which is also the only time an adapter is needed: a
  // file already in this form, or one that never held snapshots, is rewritten without asking for
  // one — so a second run over the same directory needs no key for a provider it will not use.
  if (history.slice(1).some((entry) => Array.isArray(entry.messages))) {
    await selectProvider?.(history[0].provider)
    assert(Array.isArray(history[0].messages), `${path}: entry 0 carries no snapshot to replay the others from`)
    const rebuilt = JSON.parse(slim)
    // One walk for the whole file, not one rebuild per entry: `messages` grows a turn at a time,
    // and each snapshot is compared against the state the walk is standing in. Only the part no
    // earlier entry has already vouched for is compared, since a prefix that matched once matches
    // still — which is what keeps a 200-turn file linear in both the replay and the comparison.
    const messages = [...rebuilt[0].messages]
    let vouched = messages.length
    for (let i = 1; i < rebuilt.length; i++) {
      appendTurn(messages, rebuilt[i - 1])
      const stored = history[i].messages
      if (!Array.isArray(stored)) continue
      assert(
        stored.length === messages.length && sameJson(stored.slice(vouched), messages.slice(vouched)),
        `${path}: entry ${i}'s snapshot is not what replaying the new file produces, so dropping it `
        + `would lose something. Written under provider ${history[0].provider}; is that the one set now?`,
      )
      vouched = messages.length
    }
  }

  await writeAtomic(path, slim)
  return { status: 'normalized', before: size, after: byteLength(slim) }
}

// Every history under a directory, in a stable order. Entries live two levels down — a directory
// per model, one per request type and system prompt — so the walk recurses rather than listing.
// `<key>.json` is a stored history; `<key>.invalid.json` is a rejected response kept for a person
// to read, which nothing replays and nothing here should touch.
async function* historyFiles(dir) {
  const entries = (await readDirOrEmpty(dir)).toSorted((a, b) => (a.name < b.name ? -1 : 1))
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* historyFiles(path)
    else if (entry.name.endsWith('.json') && !isInvalidEntry(entry.name)) yield path
  }
}

// Every stored history under a directory, rewritten the same way, yielding one result per file as
// it goes — `{ path, status, before, after }`, or `{ path, error }` for one left alone, since a
// single unreadable file is no reason to stop migrating the rest. Here rather than in a script so
// that a caller of the package can migrate its own cache without re-deriving the walk and the
// rule for which files are histories.
export async function* normalizeCache(dir, { selectProvider } = {}) {
  for await (const path of historyFiles(dir)) {
    try {
      yield { path, ...await normalizeCacheFile(path, { selectProvider }) }
    } catch (error) {
      yield { path, error }
    }
  }
}
