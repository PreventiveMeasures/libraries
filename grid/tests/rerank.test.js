import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { setCacheDir } from '@preventive/ai'
import { newTally } from '../src/call.js'
import { rerank } from '../src/rerank.js'
import { TASK, fakeAsk, listRows } from './fake.js'

const CACHE_DIR = join(tmpdir(), `grid-rerank-test-${process.pid}`)
after(async () => { await rm(CACHE_DIR, { recursive: true, force: true }) })

// Eight finalists as score() hands them on: three carry the word three times, twice and once and
// were all scored 90, so the pointwise order among them says nothing; the rest were scored 10.
const STRENGTH = { e2: 3, e5: 2, e7: 1 }
const IDS = ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8']
const ROWS = IDS.map((id) => ({ id, taskId: TASK.id, entry: `${id}: ${'MATCH '.repeat(STRENGTH[id] ?? 0)}entry`, summary: `Summary of ${id}`, answers: [] }))
const result = (id) => ({ id, score: STRENGTH[id] ? 90 : 10, reason: 'r', evidence: 'e', grounded: true, votes: STRENGTH[id] ? 3 : 1, summary: `Summary of ${id}`, duplicates: [] })
const RESULTS = ['e2', 'e5', 'e7', 'e1', 'e3', 'e4', 'e6', 'e8'].map(result)
const REQUEST = { id: 'rr1', text: 'the thing' }
const USAGE = { input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cost: 0 }

const common = (log = []) => ({ task: TASK, request: REQUEST, results: RESULTS, rows: ROWS, model: 'test/strong', tally: newTally(), ask: fakeAsk({ log }) })
const idsListed = (request) => listRows(request.userContent[1]).map(([, text]) => text.trim().split(':')[0])

describe('rerank', () => {
  before(() => setCacheDir(CACHE_DIR))

  it('orders the window by mean position over shuffled rounds, and leaves the rest as they were', async () => {
    const log = []
    const { results, reranked } = await rerank({ ...common(log), window: 5, rounds: 3 })
    assert.equal(reranked, 5)
    assert.deepEqual(results.slice(0, 3).map((r) => [r.id, r.listRank]), [['e2', 1], ['e5', 2], ['e7', 3]])
    assert.deepEqual(results.slice(3, 5).map((r) => r.id).sort(), ['e1', 'e3'])
    assert.ok(results.slice(3, 5).every((r) => r.listRank >= 4 && r.listRank <= 5))
    assert.deepEqual(results.slice(5), RESULTS.slice(5), 'the tail is untouched')
    // Three calls, each the request first and then every row of the window, in a different order.
    assert.equal(log.length, 3)
    assert.ok(log.every((r) => r.systemPrompt.startsWith('You order') && r.userContent[0] === 'Request:\nthe thing\n\n' && r.userContent[1].startsWith('Candidates: 5\n[1]\n')))
    const lists = log.map(idsListed)
    assert.ok(lists.every((list) => [...list].sort().join() === 'e1,e2,e3,e5,e7'))
    assert.ok(new Set(lists.map((list) => list.join())).size > 1, 'the rounds shuffle the list')
  })

  it('is deterministic, and reads every round back from the cache on a second run', async () => {
    const first = await rerank({ ...common(), window: 5, rounds: 3 })
    const second = await rerank({ ...common(), window: 5, rounds: 3, ask: () => Promise.reject(new Error('not cached')) })
    assert.deepEqual(second.results, first.results)
  })

  it('places the rows an order left out after the ones it named, in their pointwise order', async () => {
    // The model names one row only, the one carrying the word once, with noise around it that is
    // dropped: a repeat, an ordinal off the list, and one that is not a number.
    const override = (request) => {
      if (!request.systemPrompt.startsWith('You order')) return undefined
      const n = listRows(request.userContent[1]).find(([, text]) => text.includes('e7'))[0]
      return JSON.stringify({ order: [n, n, 99, 'x'] })
    }
    const log = []
    const { results } = await rerank({ ...common(), request: { id: 'rr2', text: 'partial' }, window: 5, rounds: 2, ask: fakeAsk({ log, override }) })
    assert.deepEqual(results.slice(0, 5).map((r) => [r.id, r.listRank]), [['e7', 1], ['e2', 2], ['e5', 3], ['e1', 4], ['e3', 5]])
    assert.equal(log.length, 2)
  })

  it('leaves fewer than two finalists, or no rounds, as they were, with no call', async () => {
    const ask = () => Promise.reject(new Error('should not be asked'))
    const one = await rerank({ ...common(), results: RESULTS.slice(0, 1), ask })
    assert.deepEqual(one, { results: RESULTS.slice(0, 1), reranked: 0 })
    const none = await rerank({ ...common(), rounds: 0, ask })
    assert.deepEqual(none, { results: RESULTS, reranked: 0 })
  })

  it('refuses a finalist the table has no row for', async () => {
    await assert.rejects(() => rerank({ ...common(), rows: ROWS.filter((row) => row.id !== 'e5') }), /rerank: no row for finalist e5/u)
  })

  it('re-asks an order that is not a list, or one that names no candidate', async () => {
    const texts = ['{"order":"1,2"}', '{"order":[2,1,3]}', '{"order":[0,99,true]}', '{"order":[3,2,1]}']
    const seen = []
    const ask = (request) => {
      seen.push(request.userContent.at(-1))
      return Promise.resolve({ text: texts.shift(), usage: USAGE, history: [] })
    }
    const { results, reranked } = await rerank({ ...common(), request: { id: 'rr3', text: 'malformed' }, window: 3, rounds: 2, concurrency: 1, ask })
    assert.equal(reranked, 3)
    assert.equal(results.length, 8)
    assert.equal(seen.length, 4)
    assert.match(seen[1], /Return only the JSON asked for/u)
    assert.match(seen[3], /Return only the JSON asked for/u)
    assert.ok(!seen[0].includes('Return only the JSON asked for') && !seen[2].includes('Return only the JSON asked for'))
  })
})
