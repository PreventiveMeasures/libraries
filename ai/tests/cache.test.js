/* eslint-disable max-lines-per-function */
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { after, before, describe, it } from 'node:test'

import { mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildCacheOpts, cacheDir, cacheKey, getCacheStats, getCached, getPartial, invalidateCacheEntry, isInvalidEntry, nullAfterFirst, setCache, setCacheDir, setInvalid, setPartial } from '../src/cache.js'
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

// One of an entry's files on disk. Built from the same parts resolveCachePaths uses, so a change
// to the layout fails here rather than quietly looking in the wrong place.
// createHash on purpose, against cacheKey's Web Crypto digest: if the two ever stop agreeing, every
// key in every cache that already exists is orphaned, and this is where that shows up.
const entryPath = async (opts, userContent, suffix) => join(
  CACHE_DIR,
  opts.model.replaceAll('/', '-'),
  `${opts.type}-${createHash('sha256').update(opts.systemPrompt).digest('hex').slice(0, 8)}`,
  `${await cacheKey(opts.systemPrompt, userContent, opts)}${suffix}`,
)
const invalidPath = async (opts, userContent) => await entryPath(opts, userContent, '.invalid.json')

suite('partial cache (getPartial / setPartial / invalidateCacheEntry)', () => {
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
    await invalidateCacheEntry('user-content-B', opts)
  })

  it('setPartial persists only the first entry\'s request and snapshot across a multi-turn history', async () => {
    // serializeHistory drops every request but the first and every snapshot but the first: nothing
    // reads the requests back, and a resume replays the turns onto entry 0's snapshot rather than
    // reading a recorded copy of the same thing. Verify it via the on-disk round-trip.
    const opts = uniqueCacheOpts()
    const mk = (n) => ({ request: { messages: [{ role: 'user', content: `req ${n}` }] }, response: { content: [] }, messages: [{ role: 'user', content: `m${n}` }], toolCalls: [], results: [] })
    const history = [mk(0), mk(1), mk(2)]
    await setPartial('user-content-F', history, opts)
    const got = await getPartial('user-content-F', opts)
    assert.deepEqual(got[0].request, { messages: [{ role: 'user', content: 'req 0' }] }) // first kept
    assert.deepEqual(got[0].messages, [{ role: 'user', content: 'm0' }])                 // and its seed
    assert.equal(got[1].request, null)
    assert.equal(got[2].request, null)
    assert.equal(got[1].messages, null)
    assert.equal(got[2].messages, null)
    assert.deepEqual(got[1].response, { content: [] }) // other fields intact
    await invalidateCacheEntry('user-content-F', opts)
  })

  it('returns null after invalidateCacheEntry moves the file aside', async () => {
    const opts = uniqueCacheOpts()
    await setPartial('user-content-C', [{ request: {}, response: {} }], opts)
    await invalidateCacheEntry('user-content-C', opts)
    assert.equal(await getPartial('user-content-C', opts), null)
  })

  it('invalidateCacheEntry is a no-op when nothing is stored at the key', async () => {
    const opts = uniqueCacheOpts()
    await invalidateCacheEntry('user-content-D', opts)  // should not throw
    assert.equal(await getPartial('user-content-D', opts), null)
  })

  it('takes the final answer out of service, and keeps the history it was built from', async () => {
    // Wider than the partial-clearing it replaces: a caller that will not stand behind an answer
    // needs it out of the final cache too, or the next run reads back the one it rejected. What
    // the run actually did is the evidence, so that moves aside instead of going with it.
    const opts = uniqueCacheOpts()
    await setCache('user-content-G', 'final result text', [{ request: {}, response: {} }], opts)
    await invalidateCacheEntry('user-content-G', opts)
    assert.equal(await getCached('user-content-G', opts), null)
    assert.equal(await getPartial('user-content-G', opts), null)
    const parked = JSON.parse(await readFile(await invalidPath(opts, 'user-content-G'), 'utf8'))
    assert.equal(parked.length, 1)
  })

  it('reports a failure that is not simply the file being absent', async () => {
    // Swallowing an EACCES would leave an answer the caller believes it retired still being served,
    // with nothing anywhere saying so. A directory in the answer's place is the same shape of
    // problem and the one a test can arrange.
    const opts = uniqueCacheOpts()
    await setCache('user-content-H', 'final result text', [{ request: {}, response: {} }], opts)
    const md = await entryPath(opts, 'user-content-H', '.md')
    await rm(md)
    await mkdir(md)
    await assert.rejects(() => invalidateCacheEntry('user-content-H', opts))
    await rm(md, { recursive: true })
  })

  it('a final cache hit (with .md) suppresses the partial — getCached path wins', async () => {
    const opts = uniqueCacheOpts()
    // Final cache: setCache writes both .md + .json. After this, the
    // partial reader must return null so analyzeBundle's normal
    // final-cache hit takes over instead of trying to resume.
    await setCache('user-content-E', 'final result text', [{ request: {}, response: {} }], opts)
    assert.equal(await getPartial('user-content-E', opts), null)
  })

  it('setCache slims the final .json the same way — only the first entry keeps its request and seed', async () => {
    const opts = uniqueCacheOpts()
    const mk = (n) => ({ request: { messages: [{ role: 'user', content: `req ${n}` }] }, response: { content: [] }, messages: [{ role: 'user', content: `m${n}` }], toolCalls: [], results: [] })
    await setCache('user-content-G', 'final md', [mk(0), mk(1), mk(2)], opts)
    const hit = await getCached('user-content-G', opts)
    assert.equal(hit.text, 'final md')
    assert.deepEqual(hit.json[0].request, { messages: [{ role: 'user', content: 'req 0' }] }) // first kept (cache-key recovery)
    assert.equal(hit.json[1].request, null)
    assert.equal(hit.json[2].request, null)
    assert.equal(hit.json[1].messages, null)
    assert.deepEqual(hit.json[1].response, { content: [] }) // other fields intact
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
    await invalidateCacheEntry('same-content', { ...base, bundleId: 'bundle-A' })
  })
})

suite('nullAfterFirst', () => {
  const mk = (n) => ({ request: { tag: `req ${n}` }, response: { content: [] }, messages: [{ role: 'user', content: `m${n}` }], toolCalls: [], toolResults: [], provider: 'anthropic' })

  it('keeps the first entry\'s named fields and nulls them on the rest', () => {
    // Entry 0's request is the only one read back (cache-key recovery), and its snapshot is the
    // seed a resume replays onto. Every later copy of either is what the turns around it already
    // say, and storing one per turn is what grew the file with the square of the session's length.
    const out = nullAfterFirst([mk(0), mk(1), mk(2)], 'request', 'messages')
    assert.deepEqual(out[0].request, { tag: 'req 0' })
    assert.deepEqual(out[0].messages, [{ role: 'user', content: 'm0' }])
    assert.deepEqual(out.slice(1).map((e) => [e.request, e.messages]), [[null, null], [null, null]])
  })

  it('touches only the fields it is given', () => {
    const out = nullAfterFirst([mk(0), mk(1)], 'request')
    assert.equal(out[1].request, null)
    assert.deepEqual(out[1].messages, [{ role: 'user', content: 'm1' }])
    assert.deepEqual(out[1].response, { content: [] })
    assert.equal(out[1].provider, 'anthropic')
  })

  it('leaves a field the entry does not have absent, rather than adding a null', () => {
    // Nulling what is already nothing makes the entry bigger. Normalizing an old cache file runs
    // this over histories this layer did not write, and one that never carried snapshots would
    // come back a key per entry heavier than it went in.
    const noSnapshot = mk(1)
    delete noSnapshot.messages
    const out = nullAfterFirst([mk(0), noSnapshot], 'request', 'messages')
    assert.equal(out[1].request, null)
    assert.ok(!('messages' in out[1]), 'no key was invented')
  })

  it('does not mutate the input; first entry passes by reference, others are fresh copies', () => {
    const history = [mk(0), mk(1)]
    const snapshot = JSON.stringify(history)
    const out = nullAfterFirst(history, 'request', 'messages')
    assert.equal(JSON.stringify(history), snapshot)       // input untouched
    assert.equal(out[0], history[0])                      // first entry passed through
    assert.notEqual(out[1], history[1])                   // others are shallow copies
    assert.deepEqual(history[1].request, { tag: 'req 1' }) // original objects intact
  })

  it('keeps everything on a single-entry history; empty stays empty', () => {
    const one = [mk(0)]
    assert.deepEqual(nullAfterFirst(one, 'request', 'messages'), one)
    assert.deepEqual(nullAfterFirst([], 'request'), [])
  })
})

suite('cache read failures', () => {
  const opts = { type: 'read-fail', model: 'm', systemPrompt: 'sys', think: false, effort: undefined }

  it('treats a non-ENOENT read failure as a loud miss, not a silent one', async (t) => {
    const warns = []
    t.mock.method(console, 'warn', (...args) => { warns.push(args.join(' ')) })
    // Write a real entry, then replace its .md with a DIRECTORY so the
    // read fails with EISDIR (a stand-in for any non-absence failure).
    const userContent = `dir-in-place ${randomBytes(8).toString('hex')}`
    const key = await setCache(userContent, 'cached text', [], opts)
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

  it('writes the history under .invalid.json, with the reason that rejected it', async () => {
    const opts = uniqueCacheOpts()
    await setInvalid('inv-A', HISTORY, opts, { reason: 'Response truncated: hit max_tokens limit', text: null })
    const dump = JSON.parse(await readFile(await invalidPath(opts, 'inv-A'), 'utf8'))
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

  it('gives way to a later invalidation at the same key', async () => {
    // A rename cannot merge, and the newer artefact is the more useful one. What lands is the
    // bare history, not this suite's { reason, history }: the two shapes share the suffix, and
    // nothing but a person ever reads either.
    const opts = uniqueCacheOpts()
    await setInvalid('inv-D', HISTORY, opts, { reason: 'malformed', text: 'not json' })
    await setPartial('inv-D', HISTORY, opts)
    await invalidateCacheEntry('inv-D', opts)
    const parked = JSON.parse(await readFile(await invalidPath(opts, 'inv-D'), 'utf8'))
    const shape = JSON.stringify(parked).slice(0, 40)
    assert.ok(Array.isArray(parked), `expected a history, got ${shape}`)
    assert.equal(await getPartial('inv-D', opts), null)
  })

  it('overwrites the previous dump for the same key', async () => {
    const opts = uniqueCacheOpts()
    await setInvalid('inv-C', HISTORY, opts, { reason: 'first failure', text: 'a' })
    await setInvalid('inv-C', HISTORY, opts, { reason: 'second failure', text: 'b' })
    const dump = JSON.parse(await readFile(await invalidPath(opts, 'inv-C'), 'utf8'))
    assert.equal(dump.reason, 'second failure')
  })

  it('skips an EMPTY response — nothing in it to read', async () => {
    // The run already records those as `censored`; a dump of nothing is
    // noise. A null `text` is the other case entirely: the REQUEST failed
    // (truncation, transport) and the history is exactly what we want.
    const opts = uniqueCacheOpts()
    await setInvalid('inv-D', HISTORY, opts, { reason: 'Empty response', text: '' })
    await assert.rejects(readFile(await invalidPath(opts, 'inv-D'), 'utf8'), { code: 'ENOENT' })
    await setInvalid('inv-D', HISTORY, opts, { reason: 'Empty response', text: '   \n ' })
    await assert.rejects(readFile(await invalidPath(opts, 'inv-D'), 'utf8'), { code: 'ENOENT' })
  })

  it('is deleted when a valid entry lands on the same key', async () => {
    const opts = uniqueCacheOpts()
    await setInvalid('inv-E', HISTORY, opts, { reason: 'malformed', text: 'not json' })
    await setCache('inv-E', 'a good response', HISTORY, opts)
    // The key's last word is a usable response, so the stale failure
    // record is gone rather than sitting beside it.
    await assert.rejects(readFile(await invalidPath(opts, 'inv-E'), 'utf8'), { code: 'ENOENT' })
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
    const snapshot = await readFile(await invalidPath(opts, 'inv-H'), 'utf8')
    const result = await rehashCache(opts.model)
    assert.equal(result.scanned, 0, 'the dump must not even be scanned')
    assert.equal(result.renamed, 0)
    assert.equal(await readFile(await invalidPath(opts, 'inv-H'), 'utf8'), snapshot)
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

