import assert from 'node:assert/strict'
import { readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { setCacheDir } from '@preventive/ai'
import { call, newTally } from '../src/call.js'

const CACHE_DIR = join(tmpdir(), `grid-call-test-${process.pid}`)
after(async () => { await rm(CACHE_DIR, { recursive: true, force: true }) })

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cost: 0.5 }
const scripted = (...texts) => () => Promise.resolve({ text: texts.shift(), usage, history: [{ request: {}, response: {} }] })
const never = () => Promise.reject(new Error('should have been served from the cache'))

const MODEL = 'test/model'
const base = (label) => ({ type: 'grid.test', model: MODEL, systemPrompt: `system ${label}`, userContent: `user ${label}` })

async function invalidEntries() {
  const dirs = await readdir(CACHE_DIR, { recursive: true })
  return dirs.filter((name) => name.endsWith('.invalid.json'))
}

describe('call', () => {
  before(() => setCacheDir(CACHE_DIR))

  it('asks on a miss, then reads the entry back on the next call', async () => {
    const tally = newTally()
    const first = await call({ ...base('miss'), ask: scripted('{"a":1}'), tally })
    assert.deepEqual(first, { a: 1 })
    assert.deepEqual({ ...tally, usage: undefined }, { calls: 1, hits: 0, misses: 1, usage: undefined })
    assert.equal(tally.usage.cost, 0.5)
    const second = await call({ ...base('miss'), ask: never, tally })
    assert.deepEqual(second, { a: 1 })
    assert.deepEqual({ ...tally, usage: undefined }, { calls: 1, hits: 1, misses: 1, usage: undefined })
  })

  it('keys on the blocks joined, so a split message reads the entry a whole one wrote', async () => {
    const tally = newTally()
    await call({ ...base('blocks'), userContent: 'ab', ask: scripted('[1]'), tally })
    assert.deepEqual(await call({ ...base('blocks'), userContent: ['a', 'b'], ask: never, tally }), [1])
  })

  it('re-asks a malformed response once, with the nudge, and stores the answer under the original key', async () => {
    const tally = newTally()
    const seen = []
    const ask = async (request) => {
      seen.push(request.userContent)
      return (await scripted(seen.length === 1 ? 'not json at all' : '{"ok":true}')(request))
    }
    assert.deepEqual(await call({ ...base('nudge'), ask, tally }), { ok: true })
    assert.equal(seen.length, 2)
    assert.equal(seen[0], 'user nudge')
    assert.match(seen[1], /^user nudge\n\nReturn only the JSON/u)
    assert.equal(tally.calls, 2)
    // The good answer landing under the original key retires the failure record kept beside it, as
    // ai's setCache does for any key: the key's last word is now a usable response.
    assert.equal((await invalidEntries()).length, 0)
    assert.deepEqual(await call({ ...base('nudge'), ask: never, tally }), { ok: true })
    assert.equal(tally.hits, 1)
  })

  it('nudges the last block of a split message', async () => {
    const seen = []
    const next = scripted('nope', '{}')
    const ask = (request) => { seen.push(request.userContent); return next(request) }
    await call({ ...base('split'), userContent: ['shared', 'tail'], ask, tally: newTally() })
    assert.deepEqual(seen[1], ['shared', 'tail\n\nReturn only the JSON asked for, with no other text before or after it.'])
  })

  it('gives up after the second malformed response, keeping the first for inspection', async () => {
    await assert.rejects(
      () => call({ ...base('twice'), label: 'twice', ask: scripted('nope', 'still nope'), tally: newTally() }),
      /twice: malformed response after a retry: no JSON/u,
    )
    assert.equal((await invalidEntries()).length, 1)
  })

  it('judges a cached entry with the parse it was given, so a stricter reader misses', async () => {
    const tally = newTally()
    await call({ ...base('strict'), ask: scripted('{"n":"x"}'), tally })
    const strict = (text) => { const json = JSON.parse(text); if (typeof json.n !== 'number') throw new TypeError('n'); return json }
    assert.deepEqual(await call({ ...base('strict'), parse: strict, ask: scripted('{"n":2}'), tally }), { n: 2 })
    assert.equal(tally.misses, 2)
  })

  it('counts a falsy parsed value as a hit', async () => {
    const tally = newTally()
    assert.equal(await call({ ...base('falsy'), parse: () => 0, ask: scripted('0'), tally }), 0)
    assert.equal(await call({ ...base('falsy'), parse: () => 0, ask: never, tally }), 0)
    assert.equal(tally.hits, 1)
  })

  it('throws the layer error under the label, and spends nothing on the cache', async () => {
    const ask = () => Promise.resolve({ text: null, error: 'API error: 500', usage, history: [] })
    await assert.rejects(() => call({ ...base('err'), label: 'compact e1', ask, tally: newTally() }), /compact e1: API error: 500/u)
  })
})
