/* eslint-disable max-lines-per-function */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { setCache, setCacheDir } from '../src/cache.js'
import { listCacheEntries, rehashCache } from '../src/cache-scan.js'

// Somewhere of this run's own: the layer has no default, and a scan that
// walked a real cache would count whatever it found there.
const CACHE_DIR = join(tmpdir(), `ai-cache-scan-test-${process.pid}`)
setCacheDir(CACHE_DIR)
after(() => rmSync(CACHE_DIR, { recursive: true, force: true }))

// Per-test isolation: every test computes a unique `userContent` so its
// hashed cache key doesn't collide with a neighbouring test's.
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

describe('listCacheEntries', () => {
  const model = 'test/model-1.0'
  const systemPrompt = 'list test prompt'
  const req = (userContent) => [{ request: { messages: [{ role: 'user', content: userContent }] }, response: {} }]

  it('returns [] when the analyzer config has no cache directory', async () => {
    const type = `_test-empty-${randomBytes(8).toString('hex')}`
    assert.deepEqual(await listCacheEntries(type, model, systemPrompt, { think: false }), [])
  })

  it('returns config-matching entries with their recovered userContent', async () => {
    const type = `_test-list-${randomBytes(8).toString('hex')}`
    const opts = { type, model, systemPrompt, think: false, effort: undefined }
    const uc = 'the analyzer user content body'
    await setCache(uc, 'result md', req(uc), opts)
    const entries = await listCacheEntries(type, model, systemPrompt, { think: false, effort: undefined })
    assert.equal(entries.length, 1)
    assert.equal(entries[0].userContent, uc)
  })

  it('recovers userContent from json[0] of a multi-turn entry, even though request[1..] are nulled', async () => {
    // serializeHistory keeps only the first turn's request; the key-recovery
    // reader must still recover userContent from json[0] across a real
    // multi-turn history (where slimming actually nulls the later requests).
    const type = `_test-multi-${randomBytes(8).toString('hex')}`
    const opts = { type, model, systemPrompt, think: false, effort: undefined }
    const uc = 'multi-turn analyzer content'
    const turn = (extra) => ({ request: { messages: [{ role: 'user', content: uc }, ...extra] }, response: {} })
    await setCache(uc, 'r', [turn([]), turn([{ role: 'assistant', content: 'a' }]), turn([])], opts)
    const entries = await listCacheEntries(type, model, systemPrompt, { think: false, effort: undefined })
    assert.equal(entries.length, 1)
    assert.equal(entries[0].userContent, uc) // from json[0].request, despite [1..] nulled
  })

  it('returns every config-matching entry under the parallel scan (order-independent)', async () => {
    const type = `_test-many-${randomBytes(8).toString('hex')}`
    const opts = { type, model, systemPrompt, think: false, effort: undefined }
    const ucs = Array.from({ length: 12 }, (_, i) => `entry number ${i} content`)
    for (const uc of ucs) await setCache(uc, 'r', req(uc), opts)
    const entries = await listCacheEntries(type, model, systemPrompt, { think: false, effort: undefined, concurrency: 4 })
    assert.deepEqual(entries.map((e) => e.userContent).toSorted(), ucs.toSorted())
  })

  it('filters out entries whose stored key folds in a bundleId or a different think/effort', async () => {
    const type = `_test-gate-${randomBytes(8).toString('hex')}`
    const base = { type, model, systemPrompt }
    const ucBundle = 'bundle-shaped content'
    const ucThink = 'thinking content'
    // A terminal-style entry keys its filename with a bundleId the
    // recompute below omits → excluded.
    await setCache(ucBundle, 'r', req(ucBundle), { ...base, think: false, effort: undefined, bundleId: 'abc' })
    // A think:true entry recomputes to a different key under think:false → excluded.
    await setCache(ucThink, 'r', req(ucThink), { ...base, think: true, effort: undefined })
    const entries = await listCacheEntries(type, model, systemPrompt, { think: false, effort: undefined })
    assert.equal(entries.length, 0)
  })
})

describe('rehashCache: skipType', () => {
  // Entries whose key folds in a bundleId can't be recomputed from the
  // stored request alone, so the caller names the types that do it and the
  // scan leaves them alone. What it is handed is the TYPE, not the
  // `<type>-<promptHash>` directory the entry sits in: a caller matching on
  // its own type names would otherwise never match one at all.
  const TURN = [{ request: { messages: [{ role: 'user', content: 'hi' }] }, response: { content: [] }, toolCalls: [], results: [] }]
  // A model of its own per test, not just a unique type: rehashCache counts
  // every entry under the MODEL, and entries left in the repo's real cache
  // by earlier runs would otherwise be counted alongside this one's.
  const uniqueModel = () => `test/rehash-skip-${randomBytes(8).toString('hex')}`

  it('hands the caller the bare type, and skips the types it names', async () => {
    const opts = uniqueCacheOpts({ model: uniqueModel() })
    await setCache('skip-me', 'result', TURN, opts)

    const seen = []
    const skipped = await rehashCache(opts.model, { skipType: (type) => { seen.push(type); return true } })
    assert.deepEqual(seen, [opts.type], 'the type, without the prompt-hash suffix')
    assert.equal(skipped.scanned, 0, 'a skipped type is not even opened')

    // Same cache, no skip rule: the entry is there and gets scanned.
    const scanned = await rehashCache(opts.model)
    assert.equal(scanned.scanned, 1)
  })

  it('scans everything when the caller names nothing', async () => {
    const opts = uniqueCacheOpts({ model: uniqueModel() })
    await setCache('keep-me', 'result', TURN, opts)
    assert.equal((await rehashCache(opts.model)).scanned, 1)
    assert.equal((await rehashCache(opts.model, {})).scanned, 1)
  })
})
