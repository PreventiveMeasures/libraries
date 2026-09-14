import { assert } from '#assert'
import { byteLength, join, readDirOrEmpty, readText, writeAtomic } from '#fs'

import { isInvalidEntry } from './cache.js'
import { serializeHistory } from './cache-history.js'
import { appendTurn, isStoredHistory } from './chat.js'
import { getProvider } from './providers.js'

// Bringing stored histories into the shape the writers use now. Its own module because it is the
// one thing in the cache that reaches for the conversation loop: proving a dropped snapshot is
// reproducible means replaying it through the same adapter that built it, and neither cache.js nor
// cache-scan.js should pull the provider layer in at load just to hold this.

// Both sides of every comparison here came out of JSON.parse, or out of an adapter building on
// what did, so this covers every value either can hold — and does it without node:util, which a
// browser build has no half for.
//
// `Object.hasOwn` rather than `key in b`: JSON.parse turns a `"__proto__"` key into an OWN data
// property, so it reaches Object.keys on the left — while on the right `'__proto__' in b` is true
// for every object and reads back Object.prototype, which has no keys and so matches an empty
// object. That made `{ __proto__: {}, x: 1 }` and `{ x: 1, y: 2 }` compare equal, in the predicate
// that decides whether a snapshot may be deleted.
function sameJson(a, b) {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => Object.hasOwn(b, key) && sameJson(a[key], b[key]))
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
// expensive thing here. Whether it is passed or not, the adapter that is set has to be the one the
// entries name: asserted here rather than left to the comparison to notice, which it only does for
// a provider pair whose shapes differ.
//
// Reads and writes without a lock, so it should not be pointed at a cache a run is still writing:
// setPartial rewrites `<key>.json` after every turn, and a turn that lands between the read here
// and the rename below would be reverted. The file is re-read and compared before the rename, so
// such a turn costs the file its migration rather than its content.
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
  // `!= null` rather than Array.isArray: a snapshot in any other shape is still a record this file
  // is the only copy of, and gating on "is it an array" would drop it without looking at it at all.
  if (history.slice(1).some((entry) => entry.messages != null)) {
    await selectProvider?.(history[0].provider)
    // Named here rather than left to the comparison to notice. Without it a caller of the package
    // that never called setProvider gets a bare `Cannot read properties of undefined` per file,
    // which normalizeCache swallows into an `error` naming no cause; and two providers that share a
    // wire format — openrouter and moonshot both speak chat-completions — build identical shapes,
    // so the comparison cannot tell them apart and the refusal index.d.ts documents never happens.
    // A file carrying no stamp predates them and has only the comparison to rely on, as before.
    const current = getProvider()
    assert(current, `${path}: no provider is selected, and the replay needs the adapter that wrote this file`)
    const wrote = history[0].provider?.split(':')[0]
    assert(
      wrote === undefined || wrote === current.name,
      `${path}: written under provider ${history[0].provider}, but ${current.name} is the one set now`,
    )
    assert(Array.isArray(history[0].messages), `${path}: entry 0 carries no snapshot to replay the others from`)
    const rebuilt = JSON.parse(slim)
    // One walk for the whole file, not one rebuild per entry: `messages` grows a turn at a time,
    // and each snapshot is compared against the state the walk is standing in.
    //
    // Compared whole, not from where an earlier entry left off. Skipping the part some earlier
    // snapshot already matched would have been linear rather than quadratic, but it vouches for the
    // wrong array: what matched was entry i-1's snapshot, and entry i's is a different record off
    // disk whose prefix nothing has looked at. A snapshot that disagrees there — at the same total
    // length — would be deleted as reproducible when it is exactly the opposite. The cost is not
    // the one it looks like either: the files this exists for carry every prior message in every
    // snapshot, so reading and parsing one is already quadratic in its turns, and comparing all of
    // what was read is the same order as having read it.
    const messages = [...rebuilt[0].messages]
    for (let i = 1; i < rebuilt.length; i++) {
      appendTurn(messages, rebuilt[i - 1])
      const stored = history[i].messages
      // Already nothing, so nothing to lose. Anything else has to be an array the replay reproduces
      // — a snapshot in another shape is a record only this file holds, and no replay can vouch for
      // a shape no writer produces.
      if (stored == null) continue
      assert(
        Array.isArray(stored) && sameJson(stored, messages),
        `${path}: entry ${i}'s snapshot is not what replaying the new file produces, so dropping it `
        + `would lose something. Either it records something the turns do not account for — a history `
        + `concatenated from more than one ask() opens again mid-file — or it is not an array at all.`,
      )
    }
  }

  // Nothing held this file between the read and here, and the read is separated from the write by a
  // parse, a replay and a comparison — long enough for a live run's setPartial (or setCache) to have
  // written a further turn under the same key, which the rename would silently revert. Both writes
  // are atomic, so the loss would leave no trace at all: re-read and refuse rather than overwrite
  // what was not the text we proved.
  assert(await readText(path) === raw, `${path}: changed while it was being normalized — left alone`)
  await writeAtomic(path, slim)
  return { status: 'normalized', before: size, after: byteLength(slim) }
}

// Every history under a directory, in a stable order. Entries live two levels down — a directory
// per model, one per request type and system prompt — so the walk recurses rather than listing.
// `<key>.json` is a stored history; `<key>.invalid.json` is a rejected response kept for a person
// to read, which nothing replays and nothing here should touch.
//
// `isFile()`, as both scans in cache-scan.js require: a Dirent describes the link, not its target,
// so a symlink named `<key>.json` is neither a directory nor a file here — and rewriting one
// through writeAtomic renames a fresh file over the link, destroying it and leaving whatever it
// pointed at behind, unmigrated. A fifo or device node under the tree would hang the read.
async function* historyFiles(dir) {
  const entries = (await readDirOrEmpty(dir)).toSorted((a, b) => (a.name < b.name ? -1 : 1))
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* historyFiles(path)
    else if (entry.isFile() && entry.name.endsWith('.json') && !isInvalidEntry(entry.name)) yield path
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
