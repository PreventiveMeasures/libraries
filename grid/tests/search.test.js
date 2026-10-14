import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { setCacheDir } from '@preventive/ai'
import { newTally } from '../src/call.js'
import { hashSeed, random, shuffle } from '../src/random.js'
import { narrow, search } from '../src/search.js'
import { TASK, entriesOf, fakeAsk } from './fake.js'

const CACHE_DIR = join(tmpdir(), `grid-search-test-${process.pid}`)
after(async () => { await rm(CACHE_DIR, { recursive: true, force: true }) })

const MATCHES = ['e3', 'e8', 'e15', 'e21', 'e30', 'e37']
const rowsOf = (count, matches = MATCHES) => entriesOf(count, matches).map(({ id, text }) => ({
  id, taskId: TASK.id, entry: text, summary: `Summary of ${id}${matches.includes(id) ? ' MATCH' : ''}`, answers: ['red', 'big'],
}))
const COLUMNS = [{ id: 'q1', text: 'Colour?' }, { id: 'q2', text: 'Size?' }]
const REQUEST = { id: 'r1', text: 'red things' }

const common = (log) => ({ task: TASK, request: REQUEST, columns: COLUMNS, model: 'test/search', tally: newTally(), ask: fakeAsk({ log }) })

describe('search', () => {
  before(() => setCacheDir(CACHE_DIR))

  it('pages every round, and a row survives on votes across the rounds', async () => {
    const log = []
    const { survivors, pages } = await search({ ...common(log), rows: rowsOf(40), pageSize: 10, pick: 0.5, rounds: 3, minVotes: 2 })
    assert.equal(pages, 12)
    assert.equal(log.length, 12)
    assert.deepEqual(survivors.map((s) => s.row.id).sort(), [...MATCHES].sort())
    assert.ok(survivors.every((s) => s.votes === 3 && s.score === 9))
  })

  it('renders the page as the shared prefix by default, and the request first when asked', async () => {
    const log = []
    await search({ ...common(log), rows: rowsOf(5), rounds: 1 })
    assert.match(log[0].userContent[0], /^Page of 5 rows; pick at most 1\.\nColumns: q1 = Colour\?; q2 = Size\?\nRows:\n1\. Summary of e\d+/u)
    assert.match(log[0].userContent[1], /^Request:\nred things$/u)
    const again = []
    await search({ ...common(again), rows: rowsOf(5), rounds: 1, requestFirst: true })
    assert.match(again[0].userContent[0], /^Request:/u)
    assert.match(again[0].userContent[1], /^Page of/u)
  })

  it('shows ordinals and answers by column, never the row id', async () => {
    const log = []
    await search({ ...common(log), rows: rowsOf(3, []), rounds: 1 })
    const page = log[0].userContent[0]
    assert.match(page, /\n2\. Summary of e\d+ \|\| q1: red \| q2: big\n/u)
    assert.doesNotMatch(page, /e\d+:/u, 'entry text is not on a summary page')
  })

  it('drops unknown, repeated and out-of-range ordinals and keeps the best picks under the cap', async () => {
    const rows = rowsOf(5, [])
    const forced = JSON.stringify({ picks: [{ n: '2', score: 3 }, { n: 2, score: 9 }, { n: 0 }, { n: 99 }, { n: 4, score: 'x' }, { n: 1, score: 7 }, { n: 1.5 }] })
    const log = []
    const { survivors } = await search({ ...common(log), ask: fakeAsk({ log, override: () => forced }), rows, pick: 0.4, rounds: 1, minVotes: 1, seed: 7 })
    // The page is round 0 of seed 7, so the ordinals map back through the same shuffle.
    const page = shuffle(rows, random(hashSeed('7\u00000')))
    assert.deepEqual(survivors.map((s) => [s.row.id, s.score]), [[page[0].id, 7], [page[3].id, 5]])
  })

  it('pages a full-text pass by characters, with the entry itself on the page', async () => {
    const log = []
    const rows = rowsOf(40)
    const { survivors, pages } = await search({ ...common(log), rows, mode: 'full', pageChars: 40, pick: 1, rounds: 1, minVotes: 1 })
    assert.ok(pages >= 20 && pages < 40, `one or two entries fit a page of forty characters, got ${pages} pages for 40 rows`)
    assert.match(log[0].userContent[0], /Rows:\n\[1\]\ne\d+: entry number \d+/u)
    assert.match(log[0].systemPrompt, /Each row is one full entry/u)
    assert.deepEqual(survivors.map((s) => s.row.id).sort(), [...MATCHES].sort())
  })
})

describe('narrow', () => {
  before(() => setCacheDir(CACHE_DIR))

  it('stages until the target is met, stopping when a stage no longer shrinks the set', async () => {
    const log = []
    const { candidates, stages } = await narrow({ ...common(log), rows: rowsOf(40), target: 5, pageSize: 10, pick: 1, rounds: 2, minVotes: 2 })
    assert.deepEqual(stages.map((s) => [s.rows, s.survivors, s.pages]), [[40, 6, 8], [6, 6, 2]])
    assert.equal(candidates.length, 5)
    assert.ok(candidates.every((c) => MATCHES.includes(c.row.id) && c.votes === 2))
    // The first stage shares its pages across requests; the second is this request's own.
    assert.match(log[0].userContent[0], /^Page of/u)
    assert.match(log.at(-1).userContent[0], /^Request:/u)
  })

  it('returns nothing when the first stage picks nothing', async () => {
    const { candidates, stages } = await narrow({ ...common([]), rows: rowsOf(20, []), target: 5, pageSize: 10, rounds: 1, minVotes: 1 })
    assert.deepEqual(candidates, [])
    assert.equal(stages.length, 1)
  })

  it('skips the search when the rows already fit the target', async () => {
    const log = []
    const { candidates, stages } = await narrow({ ...common(log), rows: rowsOf(4), target: 5 })
    assert.deepEqual(stages, [])
    assert.equal(log.length, 0)
    assert.deepEqual(candidates.map((c) => c.votes), [0, 0, 0, 0])
  })

  it('renders the same first-stage pages for two requests, seeded from the rows alone', async () => {
    const pagesFor = async (request) => {
      const log = []
      await narrow({ ...common(log), request, rows: rowsOf(30), target: 5, pageSize: 10, rounds: 2, maxStages: 1 })
      return log.map((r) => r.userContent[0]).sort()
    }
    const a = await pagesFor({ id: 'ra', text: 'first request' })
    const b = await pagesFor({ id: 'rb', text: 'a quite different second request' })
    assert.deepEqual(a, b)
  })
})
