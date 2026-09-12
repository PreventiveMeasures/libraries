/* eslint-disable max-lines-per-function */
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { after, before, describe, it } from 'node:test'

import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildCacheOpts, cacheDir, cacheKey, clearPartial, dropRequestsAfterFirst, getCacheStats, getCached, getPartial, isInvalidEntry, isMaxStringLengthError, setCache, setCacheDir, setInvalid, setPartial, stripThinkingSignatures } from '../src/cache.js'
import { listCacheEntries, rehashCache } from '../src/cache-scan.js'

// Somewhere of this run's own. The layer has no default — the caller says
// where entries live — and these tests write real files.
const CACHE_DIR = join(tmpdir(), `ai-cache-test-${process.pid}`)
after(async () => { await rm(CACHE_DIR, { recursive: true, force: true }) })

// The cache root is one global for the whole process, and `--test-isolation=none`
// gives every test file the same process: all of their top levels run before
// any suite does, so a module-scope setCacheDir would leave whichever file
// was imported LAST holding the directory for everyone. Claiming it per
// suite is what keeps these tests reading their own.
const suite = (name, body) => describe(name, () => {
  before(() => setCacheDir(CACHE_DIR))
  body()
})

suite('buildCacheOpts', () => {
  it('renames useThink/useEffort to think/effort to match cache.js consumers', () => {
    assert.deepEqual(
      buildCacheOpts('validator', { model: 'm', systemPrompt: 's', useThink: true, useEffort: 'high' }),
      { type: 'validator', model: 'm', systemPrompt: 's', think: true, effort: 'high' },
    )
  })

  it('passes the analyzer type through verbatim — ai.js builds the type at runtime', () => {
    const out = buildCacheOpts('correctness', { model: 'm', systemPrompt: 's', useThink: false, useEffort: undefined })
    assert.equal(out.type, 'correctness')
  })

  it('preserves undefined think/effort (cache.js cacheKey skips falsy fields)', () => {
    const out = buildCacheOpts('deduplicate', { model: 'm', systemPrompt: 's', useThink: false, useEffort: undefined })
    assert.equal(out.think, false)
    assert.equal(out.effort, undefined)
  })

  it('every analyzer/post-processing site lands the same shape', () => {
    // The factory's whole point is shape-locking: same five keys in the
    // same order, regardless of the per-pass `type` string.
    const sites = ['validator', 'post-process', 'deduplicate', 'prioritize', 'security']
    for (const type of sites) {
      const out = buildCacheOpts(type, { model: 'm', systemPrompt: 's', useThink: true, useEffort: 'high' })
      assert.deepEqual(Object.keys(out), ['type', 'model', 'systemPrompt', 'think', 'effort'])
    }
  })

  it('appends bundleId only when the bundle analyzer supplies it', () => {
    // Non-bundle callers omit it → exact same 5-key shape as before, so
    // their cache keys are unchanged.
    const without = buildCacheOpts('terminal.null', { model: 'm', systemPrompt: 's', useThink: false, useEffort: undefined })
    assert.equal('bundleId' in without, false)
    // Bundle path passes it → appended as a sixth key.
    const withId = buildCacheOpts('terminal.null', { model: 'm', systemPrompt: 's', useThink: false, useEffort: undefined, bundleId: 'abc' })
    assert.deepEqual(Object.keys(withId), ['type', 'model', 'systemPrompt', 'think', 'effort', 'bundleId'])
    assert.equal(withId.bundleId, 'abc')
  })
})

// Per-test isolation: every test computes a unique `userContent` so its
// hashed cache key doesn't collide with neighbouring tests or with the
// real cache dir on disk.
function uniqueCacheOpts(extra = {}) {
  return {
    type: `_test-${randomBytes(8).toString('hex')}`,
    model: 'test/model-1.0',
    systemPrompt: 'test prompt',
    think: false,
    effort: undefined,
    ...extra,
  }
}

suite('partial cache (getPartial / setPartial / clearPartial)', () => {
  it('returns null when no partial exists for the key', async () => {
    const opts = uniqueCacheOpts()
    assert.equal(await getPartial('user-content-A', opts), null)
  })

  it('round-trips a history array via setPartial → getPartial', async () => {
    const opts = uniqueCacheOpts()
    const history = [{ request: { messages: [{ role: 'user', content: 'hi' }] }, response: { content: [] }, toolCalls: [], results: [] }]
    await setPartial('user-content-B', history, opts)
    const got = await getPartial('user-content-B', opts)
    assert.deepEqual(got, history)
    await clearPartial('user-content-B', opts)
  })

  it('setPartial persists only the first entry\'s request across a multi-turn history', async () => {
    // serializeHistory drops every request but the first (dead weight: nothing
    // reads them back on resume). Verify it via the on-disk round-trip.
    const opts = uniqueCacheOpts()
    const mk = (n) => ({ request: { messages: [{ role: 'user', content: `req ${n}` }] }, response: { content: [] }, messages: [{ role: 'user', content: `m${n}` }], toolCalls: [], results: [] })
    const history = [mk(0), mk(1), mk(2)]
    await setPartial('user-content-F', history, opts)
    const got = await getPartial('user-content-F', opts)
    assert.deepEqual(got[0].request, { messages: [{ role: 'user', content: 'req 0' }] }) // first kept
    assert.equal(got[1].request, null)
    assert.equal(got[2].request, null)
    assert.deepEqual(got[1].messages, [{ role: 'user', content: 'm1' }]) // other fields intact
    await clearPartial('user-content-F', opts)
  })

  it('returns null after clearPartial removes the file', async () => {
    const opts = uniqueCacheOpts()
    await setPartial('user-content-C', [{ request: {}, response: {} }], opts)
    await clearPartial('user-content-C', opts)
    assert.equal(await getPartial('user-content-C', opts), null)
  })

  it('clearPartial is a no-op when the file is already absent', async () => {
    const opts = uniqueCacheOpts()
    await clearPartial('user-content-D', opts)  // should not throw
    assert.equal(await getPartial('user-content-D', opts), null)
  })

  it('a final cache hit (with .md) suppresses the partial — getCached path wins', async () => {
    const opts = uniqueCacheOpts()
    // Final cache: setCache writes both .md + .json. After this, the
    // partial reader must return null so analyzeBundle's normal
    // final-cache hit takes over instead of trying to resume.
    await setCache('user-content-E', 'final result text', [{ request: {}, response: {} }], opts)
    assert.equal(await getPartial('user-content-E', opts), null)
  })

  it('setCache slims the final .json the same way — only the first entry keeps its request', async () => {
    const opts = uniqueCacheOpts()
    const mk = (n) => ({ request: { messages: [{ role: 'user', content: `req ${n}` }] }, response: { content: [] }, messages: [{ role: 'user', content: `m${n}` }], toolCalls: [], results: [] })
    await setCache('user-content-G', 'final md', [mk(0), mk(1), mk(2)], opts)
    const hit = await getCached('user-content-G', opts)
    assert.equal(hit.text, 'final md')
    assert.deepEqual(hit.json[0].request, { messages: [{ role: 'user', content: 'req 0' }] }) // first kept (cache-key recovery)
    assert.equal(hit.json[1].request, null)
    assert.equal(hit.json[2].request, null)
    assert.deepEqual(hit.json[1].messages, [{ role: 'user', content: 'm1' }]) // other fields intact
  })
})


// The model name becomes a DIRECTORY under the cache root
// (modelSubdir). Its character check allows dots, because names contain
// them — but a segment that is only dots is a path move, not a directory.
// A caller that gives each of its own users a cache root of their own
// would have `..` put one user's entries where every user's are.
suite('model name as a cache directory', () => {
  const opts = (model) => ({ type: 'security', model, systemPrompt: 'p' })

  it('refuses a name that traverses out of the cache root', async () => {
    await assert.rejects(getCached('x', opts('..')), /Invalid model name: \.\./u)
    await assert.rejects(getCached('x', opts('.')), /Invalid model name: \./u)
  })

  it('still refuses names outside its character set, and still accepts real ones', async () => {
    await assert.rejects(getCached('x', opts('a b')), /Invalid model name/u)
    await assert.rejects(getCached('x', opts('a\nb')), /Invalid model name/u)
    // Dots inside a name are fine — that is why `.`/`..` need their own
    // check rather than a stricter character set.
    assert.equal(await getCached('no-such-entry', opts('anthropic/claude-opus-4.5')), null)
    assert.equal(await getCached('no-such-entry', opts('a..b')), null)
  })
})

suite('bundleId cache keying', () => {
  it('varies the key for identical userContent (so the model message can drop the hash)', async () => {
    const base = uniqueCacheOpts()
    const history = [{ request: {}, response: { content: [] }, toolCalls: [], results: [] }]
    await setPartial('same-content', history, { ...base, bundleId: 'bundle-A' })
    // Same userContent + opts, different bundleId → different key → miss.
    assert.equal(await getPartial('same-content', { ...base, bundleId: 'bundle-B' }), null)
    // No bundleId at all (non-bundle shape) → also a distinct key → miss.
    assert.equal(await getPartial('same-content', base), null)
    // Matching bundleId → hit.
    assert.deepEqual(await getPartial('same-content', { ...base, bundleId: 'bundle-A' }), history)
    await clearPartial('same-content', { ...base, bundleId: 'bundle-A' })
  })
})

// setPartial recovers an oversized history (one that overflows V8's max
// string length in JSON.stringify) by dropping thinking-block signatures
// from all but the last 10 top-level entries. These cover the two pieces of
// that recovery: the failure gate and the signature-stripping transform.
suite('isMaxStringLengthError', () => {
  it('is true only for the V8 max-string-length RangeError (a failed stringify)', () => {
    // The actual error JSON.stringify throws when a value overflows V8's
    // ~512MB string cap — the only failure the partial-cache recovery acts on.
    assert.equal(isMaxStringLengthError(new RangeError('Invalid string length')), true)
  })

  it('is false for other failures (a disk error is not recoverable by dropping data)', () => {
    const enospc = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
    assert.equal(isMaxStringLengthError(enospc), false)
    assert.equal(isMaxStringLengthError(new RangeError('Maximum call stack size exceeded')), false)
    assert.equal(isMaxStringLengthError(new TypeError('Converting circular structure to JSON')), false)
    assert.equal(isMaxStringLengthError(undefined), false)
  })
})

suite('stripThinkingSignatures', () => {
  // Thinking-block signatures live in BOTH the replayed request messages and
  // the raw response (and the stored pre-turn `messages` snapshot), so they
  // accumulate across turns. `n` tags each entry so they stay distinguishable.
  const entry = (n) => ({
    request: { messages: [
      { role: 'user', content: 'analyze' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: `req ${n}`, signature: `REQ_${n}` }, { type: 'text', text: `t${n}` }] },
    ] },
    response: { content: [{ type: 'thinking', thinking: `resp ${n}`, signature: `RESP_${n}` }, { type: 'text', text: `t${n}` }] },
    messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: `m ${n}`, signature: `MSG_${n}` }] }],
    toolCalls: [{ id: `t${n}`, name: 'terminal', args: { command: 'ls' } }],
    results: ['{}'],
  })

  // Every `signature` field value reachable from a value, recursively.
  const sigs = (value, out = []) => {
    if (Array.isArray(value)) value.forEach((v) => sigs(v, out))
    else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        if (k === 'signature') out.push(v)
        else sigs(v, out)
      }
    }
    return out
  }

  it('strips signatures from request AND response of every entry but the last 10', () => {
    const history = Array.from({ length: 13 }, (_, i) => entry(i))
    const out = stripThinkingSignatures(history, 10)
    // First 3 (13 - 10) entries: no signatures anywhere (request, response, messages)...
    for (let i = 0; i < 3; i++) {
      assert.deepEqual(sigs(out[i]), [], `entry ${i} should have no signatures`)
      // ...while the rest of the thinking block (and surrounding text) survives.
      assert.equal(out[i].response.content[0].thinking, `resp ${i}`)
      assert.equal(out[i].response.content[1].text, `t${i}`)
      assert.equal(out[i].request.messages[1].content[0].thinking, `req ${i}`)
    }
    // Last 10 entries: signatures intact in request, response, and messages.
    for (let i = 3; i < 13; i++) {
      assert.deepEqual(sigs(out[i]).toSorted(), [`MSG_${i}`, `REQ_${i}`, `RESP_${i}`])
    }
  })

  it('leaves the last 10 entries untouched — same object reference, not a clone', () => {
    const history = Array.from({ length: 12 }, (_, i) => entry(i))
    const out = stripThinkingSignatures(history, 10)
    for (let i = 0; i < 12; i++) {
      if (i < 2) assert.notEqual(out[i], history[i]) // stripped → fresh clone
      else assert.equal(out[i], history[i])          // kept → identical reference
    }
  })

  it('does not mutate the input history (live messages share these blocks by reference)', () => {
    const history = [entry(0), entry(1)]
    const snapshot = JSON.stringify(history)
    stripThinkingSignatures(history, 1) // strips entry 0
    assert.equal(JSON.stringify(history), snapshot)
    assert.deepEqual(sigs(history[0]).toSorted(), ['MSG_0', 'REQ_0', 'RESP_0'])
  })

  it('strips nothing when the history is no longer than keepLast', () => {
    const exactly10 = Array.from({ length: 10 }, (_, i) => entry(i))
    const out = stripThinkingSignatures(exactly10, 10)
    for (let i = 0; i < 10; i++) assert.equal(out[i], exactly10[i]) // all kept by reference
    const short = [entry(0), entry(1), entry(2)]
    assert.deepEqual(stripThinkingSignatures(short, 10), short)
  })

  it('defaults to keeping the last 10 entries', () => {
    const history = Array.from({ length: 11 }, (_, i) => entry(i))
    const out = stripThinkingSignatures(history) // no keepLast arg
    assert.deepEqual(sigs(out[0]), [])            // only entry 0 is stripped
    assert.notEqual(out[0], history[0])
    for (let i = 1; i < 11; i++) assert.equal(out[i], history[i])
  })

  it('only touches thinking-block signatures, not same-named fields elsewhere', () => {
    // A `signature` key on something that is not a `type: 'thinking'` block
    // (here a tool-call arg) must survive the strip.
    const e = entry(0)
    e.toolCalls[0].args = { command: 'grep', signature: 'fn(x: string): void' }
    const [out] = stripThinkingSignatures([e], 0) // keepLast 0 → strip the only entry
    assert.equal(out.toolCalls[0].args.signature, 'fn(x: string): void')
    assert.deepEqual(sigs(out.request), [])  // thinking-block signatures gone
    assert.deepEqual(sigs(out.response), [])
  })
})

suite('dropRequestsAfterFirst', () => {
  const mk = (n) => ({ request: { tag: `req ${n}` }, response: { content: [] }, messages: [{ role: 'user', content: `m${n}` }], toolCalls: [], results: [], provider: 'anthropic' })

  it('keeps only the first entry\'s request and nulls the rest', () => {
    const out = dropRequestsAfterFirst([mk(0), mk(1), mk(2)])
    assert.deepEqual(out[0].request, { tag: 'req 0' })
    assert.equal(out[1].request, null)
    assert.equal(out[2].request, null)
  })

  it('preserves every other field on the nulled entries', () => {
    const out = dropRequestsAfterFirst([mk(0), mk(1)])
    assert.deepEqual(out[1].response, { content: [] })
    assert.deepEqual(out[1].messages, [{ role: 'user', content: 'm1' }])
    assert.deepEqual(out[1].toolCalls, [])
    assert.equal(out[1].provider, 'anthropic')
  })

  it('does not mutate the input; first entry passes by reference, others are fresh copies', () => {
    const history = [mk(0), mk(1)]
    const snapshot = JSON.stringify(history)
    const out = dropRequestsAfterFirst(history)
    assert.equal(JSON.stringify(history), snapshot)       // input untouched
    assert.equal(out[0], history[0])                      // first entry passed through
    assert.notEqual(out[1], history[1])                   // others are shallow copies
    assert.deepEqual(history[1].request, { tag: 'req 1' }) // original request object intact
  })

  it('keeps the request on a single-entry history; empty stays empty', () => {
    const one = [mk(0)]
    assert.deepEqual(dropRequestsAfterFirst(one), one)
    assert.deepEqual(dropRequestsAfterFirst([]), [])
  })
})

// The cache loader used to swallow EVERY read error into the same `null`
// as a missing file — fabricating a miss out of any transient failure
// (fd pressure, a busy volume): invisible at --concurrency 1, and in a
// live run each phantom miss re-spends a model request and rewrites the
// entry, so warm runs loaded different cache files and hit/miss totals
// wobbled. ENOENT stays a quiet miss; everything else must surface.
suite('cache read failures', () => {
  const opts = { type: 'read-fail', model: 'm', systemPrompt: 'sys', think: false, effort: undefined }

  it('treats a non-ENOENT read failure as a loud miss, not a silent one', async (t) => {
    const warns = []
    t.mock.method(console, 'warn', (...args) => { warns.push(args.join(' ')) })
    // Write a real entry, then replace its .md with a DIRECTORY so the
    // read fails with EISDIR (a stand-in for any non-absence failure).
    const userContent = `dir-in-place ${randomBytes(8).toString('hex')}`
    const key = await setCache(userContent, 'cached text', [], opts)
    const { mkdir } = await import('node:fs/promises')
    const promptHash = (await import('node:crypto')).createHash('sha256').update('sys').digest('hex').slice(0, 8)
    const mdPath = join(CACHE_DIR, 'm', `read-fail-${promptHash}`, `${key}.md`)
    await rm(mdPath)
    await mkdir(mdPath)
    assert.equal(await getCached(userContent, opts), null)
    assert.ok(warns.some((w) => w.includes('[cache] read failed (EISDIR)') && w.includes(mdPath)), warns.join('\n'))
    await rm(mdPath, { recursive: true })
  })

  it('missing entries stay quiet misses', async (t) => {
    const warns = []
    t.mock.method(console, 'warn', (...args) => { warns.push(args.join(' ')) })
    assert.equal(await getCached(`never written ${randomBytes(8).toString('hex')}`, opts), null)
    assert.deepEqual(warns, [])
  })
})

suite('atomic entry writes', () => {
  const opts = { type: 'atomic', model: 'm', systemPrompt: 'sys', think: false, effort: undefined }

  it('leaves no temp files behind and round-trips the entry', async () => {
    const userContent = `atomic ${randomBytes(8).toString('hex')}`
    const key = await setCache(userContent, 'the result', [{ request: null, response: { ok: 1 } }], opts)
    const cached = await getCached(userContent, opts)
    assert.equal(cached.text, 'the result')
    assert.equal(cached.key, key)
    const { dirname } = await import('node:path')
    const { readdir } = await import('node:fs/promises')
    const dir = dirname(join(CACHE_DIR, 'm', 'placeholder'))
    const leftovers = (await readdir(join(dir), { recursive: true })).filter((f) => f.endsWith('.tmp'))
    assert.deepEqual(leftovers, [])
  })
})

// Rejected responses are kept for a person to read and never for the
// pipeline: nothing loads `.invalid.json`, the directory scanners skip it,
// and a valid entry at the same key clears it.
suite('setInvalid / .invalid.json', () => {
  const HISTORY = [{ request: { messages: [{ role: 'user', content: 'hi' }] }, response: { content: [{ type: 'text', text: 'half an ans' }] }, toolCalls: [], results: [] }]
  const invalidPath = (opts, userContent) => join(
    CACHE_DIR,
    opts.model.replaceAll('/', '-'),
    `${opts.type}-${createHash('sha256').update(opts.systemPrompt).digest('hex').slice(0, 8)}`,
    `${cacheKey(opts.systemPrompt, userContent, opts)}.invalid.json`,
  )

  it('writes the history under .invalid.json, with the reason that rejected it', async () => {
    const opts = uniqueCacheOpts()
    await setInvalid('inv-A', HISTORY, opts, { reason: 'Response truncated: hit max_tokens limit', text: null })
    const dump = JSON.parse(await readFile(invalidPath(opts, 'inv-A'), 'utf8'))
    assert.equal(dump.reason, 'Response truncated: hit max_tokens limit')
    // The raw provider response — the partial answer included — is what
    // makes the dump worth keeping.
    assert.deepEqual(dump.history[0].response, HISTORY[0].response)
  })

  it('is never served as a cache entry', async () => {
    const opts = uniqueCacheOpts()
    await setInvalid('inv-B', HISTORY, opts, { reason: 'malformed', text: 'not json' })
    assert.equal(await getCached('inv-B', opts), null)
    // Nor as a resumable partial: that reads `<key>.json`, not this.
    assert.equal(await getPartial('inv-B', opts), null)
  })

  it('overwrites the previous dump for the same key', async () => {
    const opts = uniqueCacheOpts()
    await setInvalid('inv-C', HISTORY, opts, { reason: 'first failure', text: 'a' })
    await setInvalid('inv-C', HISTORY, opts, { reason: 'second failure', text: 'b' })
    const dump = JSON.parse(await readFile(invalidPath(opts, 'inv-C'), 'utf8'))
    assert.equal(dump.reason, 'second failure')
  })

  it('skips an EMPTY response — nothing in it to read', async () => {
    // The run already records those as `censored`; a dump of nothing is
    // noise. A null `text` is the other case entirely: the REQUEST failed
    // (truncation, transport) and the history is exactly what we want.
    const opts = uniqueCacheOpts()
    await setInvalid('inv-D', HISTORY, opts, { reason: 'Empty response', text: '' })
    await assert.rejects(readFile(invalidPath(opts, 'inv-D'), 'utf8'), { code: 'ENOENT' })
    await setInvalid('inv-D', HISTORY, opts, { reason: 'Empty response', text: '   \n ' })
    await assert.rejects(readFile(invalidPath(opts, 'inv-D'), 'utf8'), { code: 'ENOENT' })
  })

  it('is deleted when a valid entry lands on the same key', async () => {
    const opts = uniqueCacheOpts()
    await setInvalid('inv-E', HISTORY, opts, { reason: 'malformed', text: 'not json' })
    await setCache('inv-E', 'a good response', HISTORY, opts)
    // The key's last word is a usable response, so the stale failure
    // record is gone rather than sitting beside it.
    await assert.rejects(readFile(invalidPath(opts, 'inv-E'), 'utf8'), { code: 'ENOENT' })
    assert.equal((await getCached('inv-E', opts)).text, 'a good response')
  })

  it('never breaks a run when the dump cannot be written', async (t) => {
    // The pass calling this was already giving up on the file; a full disk
    // must not turn that into a thrown error.
    const opts = uniqueCacheOpts()
    const warns = []
    t.mock.method(console, 'warn', (...args) => warns.push(args.join(' ')))
    const circular = [{ request: null, response: {}, toolCalls: [], results: [] }]
    circular[0].response.self = circular[0].response
    await setInvalid('inv-F', circular, opts, { reason: 'malformed', text: 'x' })
    assert.ok(warns.some((w) => w.includes('could not save the rejected response')), warns.join('\n'))
  })

  it('is never rehashed into a live entry', async () => {
    // The dangerous one: rehashCache renames `<key>.json` to a recomputed
    // key, so an unguarded dump would land as `<newKey>.json` and be
    // served as a real cached result by every later run.
    const opts = uniqueCacheOpts({ model: 'test/rehash-guard-1.0' })
    await setInvalid('inv-H', HISTORY, opts, { reason: 'malformed', text: 'x' })
    const snapshot = await readFile(invalidPath(opts, 'inv-H'), 'utf8')
    const result = await rehashCache(opts.model)
    assert.equal(result.scanned, 0, 'the dump must not even be scanned')
    assert.equal(result.renamed, 0)
    assert.equal(await readFile(invalidPath(opts, 'inv-H'), 'utf8'), snapshot)
  })

  it('is invisible to the cache-entry scanner', async () => {
    // listCacheEntries walks *.json; a dump must not read as an
    // entry there (rehashCache walks the same way and would RENAME it
    // into a live `<key>.json`).
    const opts = uniqueCacheOpts()
    await setInvalid('inv-G', HISTORY, opts, { reason: 'malformed', text: 'x' })
    const entries = await listCacheEntries(opts.type, opts.model, opts.systemPrompt, { think: false })
    assert.deepEqual(entries, [])
    assert.equal(isInvalidEntry('abc.invalid.json'), true)
    assert.equal(isInvalidEntry('abc.json'), false)
  })
})

suite('setCacheDir', () => {
  // There is no default, on purpose: a layer that guessed would put a run's
  // entries somewhere nobody chose, and every entry the last run wrote
  // would read as a miss — which no test seeding its own entries would
  // notice. So the guess is gone and the caller says.
  it('is what every path resolves against', () => {
    assert.equal(cacheDir(), CACHE_DIR)
  })

  it('refuses a directory that is not one', () => {
    assert.throws(() => setCacheDir(''), /expected a directory path/u)
    assert.throws(() => setCacheDir(undefined), /expected a directory path/u)
    assert.equal(cacheDir(), CACHE_DIR, 'a refused call leaves the old root standing')
  })
})

suite('getCached: validate', () => {
  const HISTORY = [{ request: { messages: [{ role: 'user', content: 'hi' }] }, response: { content: [] }, toolCalls: [], results: [] }]

  // `validate` answers two questions at once, and both are tested here: is
  // this entry usable, and — because a lookup that asks is a request of the
  // run — does it count as a hit or a miss.
  const hits = async (fn) => {
    const start = getCacheStats()
    await fn()
    const now = getCacheStats()
    return { hits: now.hits - start.hits, misses: now.misses - start.misses }
  }

  it('returns what `validate` made of the entry, and counts a hit', async () => {
    const opts = uniqueCacheOpts()
    await setCache('v-A', '[1,2,3]', HISTORY, opts)
    let cached
    const counts = await hits(async () => {
      cached = await getCached('v-A', opts, { validate: ({ text }) => JSON.parse(text) })
    })
    assert.deepEqual(cached.value, [1, 2, 3])
    assert.equal(cached.text, '[1,2,3]')
    assert.equal(cached.userContent, 'v-A')
    assert.deepEqual(counts, { hits: 1, misses: 0 })
  })

  it('counts an entry `validate` rejects as a miss, like no entry at all', async () => {
    // The run has to re-ask either way, which is the only thing the
    // counters are measuring.
    const opts = uniqueCacheOpts()
    await setCache('v-B', 'not json', HISTORY, opts)
    let cached
    const rejected = await hits(async () => {
      cached = await getCached('v-B', opts, { validate: () => null })
    })
    assert.equal(cached, null)
    assert.deepEqual(rejected, { hits: 0, misses: 1 })

    const absent = await hits(() => getCached('v-never-written', opts, { validate: () => true }))
    assert.deepEqual(absent, { hits: 0, misses: 1 })
  })

  it('counts nothing for a lookup that passes no `validate`', async () => {
    // getCached also serves searches of what the cache happens to hold,
    // which are nobody's request.
    const opts = uniqueCacheOpts()
    await setCache('v-C', 'text', HISTORY, opts)
    const counts = await hits(async () => {
      assert.equal((await getCached('v-C', opts)).text, 'text')
      assert.equal(await getCached('v-missing', opts), null)
    })
    assert.deepEqual(counts, { hits: 0, misses: 0 })
  })

  it('tries candidate keys in order and counts the set once', async () => {
    // A request that could be sitting under more than one key is still one
    // request: the first usable entry wins, and one miss is counted when
    // none of them is.
    const opts = uniqueCacheOpts()
    await setCache('v-second', 'from the second key', HISTORY, opts)
    let cached
    const found = await hits(async () => {
      cached = await getCached(['v-first', 'v-second', 'v-third'], opts, { validate: ({ text }) => text })
    })
    assert.equal(cached.userContent, 'v-second')
    assert.equal(cached.value, 'from the second key')
    assert.deepEqual(found, { hits: 1, misses: 0 })

    const none = await hits(() => getCached(['v-x', 'v-y'], opts, { validate: () => true }))
    assert.deepEqual(none, { hits: 0, misses: 1 })
  })

  it('moves past an entry `validate` rejects to a later candidate', async () => {
    const opts = uniqueCacheOpts()
    await setCache('v-bad', 'unusable', HISTORY, opts)
    await setCache('v-good', 'usable', HISTORY, opts)
    const cached = await getCached(['v-bad', 'v-good'], opts, {
      validate: ({ text }) => (text === 'usable' ? text : null),
    })
    assert.equal(cached.userContent, 'v-good')
  })
})

