import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { setCacheDir } from '@preventive/ai'
import { buildTable, newTally, select } from '../index.js'
import { union } from '../src/select.js'
import { TASK, entriesOf, fakeAsk } from './fake.js'

const CACHE_DIR = join(tmpdir(), `grid-select-test-${process.pid}`)
after(async () => { await rm(CACHE_DIR, { recursive: true, force: true }) })

const MATCHES = ['e4', 'e11', 'e19', 'e33', 'e48']
const ENTRIES = entriesOf(50, MATCHES)
const MODELS = { strong: 'test/strong', search: 'test/search', cheap: 'test/cheap' }
const REQUEST = { id: 'r1', text: 'a red thing' }
const SEARCH = { pageSize: 10, pick: 0.5, rounds: 3, minVotes: 2 }

const run = async (table, { log = [], gate, ...rest } = {}) => await select({
  ...table, request: REQUEST, models: MODELS, final: 0.1, minFinal: 5, search: SEARCH, tally: newTally(), ask: fakeAsk({ log, gate }), ...rest,
})

describe('buildTable and select', () => {
  before(() => setCacheDir(CACHE_DIR))

  it('builds the table: the questions proposed, then every entry compacted on the strong model', async () => {
    const log = []
    const table = await buildTable({ task: TASK, entries: ENTRIES, model: MODELS.strong, ask: fakeAsk({ log }) })
    assert.equal(table.focus, 'the colour')
    assert.deepEqual(table.questions, [{ id: 'q1', text: 'Colour?' }, { id: 'q2', text: 'Size?' }])
    assert.equal(table.rows.length, 50)
    assert.deepEqual(table.rows[3], { id: 'e4', taskId: 'colours', entry: 'e4: entry number 4 MATCH', summary: 'Summary of e4 MATCH', answers: ['a1 of e4', 'a2 of e4'] })
    assert.equal(log.length, 51)
    assert.ok(log.every((r) => r.model === MODELS.strong))
    assert.equal(table.tally.calls, 51)
  })

  it('selects the matching entries, ranked on the full-text score, with the stages it took', async () => {
    const log = []
    const table = await buildTable({ task: TASK, entries: ENTRIES, model: MODELS.strong, ask: fakeAsk() })
    const { results, gate, stages, fullStages, tally } = await run(table, { log })
    assert.deepEqual(results.map((r) => r.id).sort(), [...MATCHES].sort())
    assert.ok(results.every((r) => r.score === 90 && r.votes === 3 && r.reason === 'carries MATCH' && r.summary.endsWith('MATCH')))
    assert.deepEqual(gate, { extraQuestions: [], fullScan: false, reason: 'enough' })
    assert.deepEqual(stages.map((s) => [s.rows, s.survivors]), [[50, 5]])
    assert.deepEqual(fullStages, [])
    // The finalist's call: the request as the shared prefix, the candidate after a blank line.
    const scoring = log.find((r) => r.systemPrompt.startsWith('You judge'))
    assert.match(scoring.userContent.join(''), /^Request:\na red thing\n\nCandidate:\ne\d+: entry number \d+ MATCH$/u)
    // One gate, three rounds of five pages, five finalists: and each on the model for its work.
    const models = log.map((r) => r.model)
    assert.equal(models.filter((m) => m === MODELS.strong).length, 6)
    assert.equal(models.filter((m) => m === MODELS.search).length, 15)
    assert.equal(tally.calls, 21)
  })

  it('reads every call back from the cache on a second run', async () => {
    const table = await buildTable({ task: TASK, entries: ENTRIES, model: MODELS.strong, ask: fakeAsk() })
    const request = { id: 'r-cold', text: 'a request no test has asked before' }
    const first = await run(table, { request })
    assert.ok(first.tally.calls > 0)
    const second = await run(table, { request, ask: () => Promise.reject(new Error('not cached')) })
    assert.deepEqual(second.results, first.results)
    assert.equal(second.tally.calls, 0)
    assert.equal(second.tally.hits, first.tally.calls)
  })

  it('answers the extra questions a gate asks on the cheap model, as columns the pages then carry', async () => {
    const log = []
    const table = await buildTable({ task: TASK, entries: ENTRIES, model: MODELS.strong, ask: fakeAsk() })
    const request = { id: 'r-extra', text: 'a heavy old thing' }
    const { results, gate } = await run(table, { log, request, gate: { extraQuestions: ['Weight?', 'Age?'] } })
    assert.deepEqual(gate.extraQuestions, [{ id: 'x1', text: 'Weight?' }, { id: 'x2', text: 'Age?' }])
    const extra = log.filter((r) => r.systemPrompt.startsWith('You compact'))
    assert.equal(extra.length, 50)
    assert.ok(extra.every((r) => r.model === MODELS.cheap && r.systemPrompt.includes('x1. Weight?\nx2. Age?') && !r.systemPrompt.includes('"summary"')))
    // The pages now carry this request's own columns, so the request is the shared prefix from the
    // first stage on, and the page follows it.
    const [prefix, page] = log.find((r) => r.systemPrompt.startsWith('You select')).userContent
    assert.match(prefix, /^Request:\na heavy old thing\n\n$/u)
    assert.match(page, /^Page of 10 rows; pick at most 5\.\nColumns: q1 = Colour\?; q2 = Size\?; x1 = Weight\?; x2 = Age\?\n/u)
    assert.match(page, /\| x1: a1 of e\d+ \| x2: a2 of e\d+\n/u)
    assert.deepEqual(results.map((r) => r.id).sort(), [...MATCHES].sort())
    assert.ok(table.rows.every((row) => row.answers.length === 2), 'the shared table is untouched')
  })

  it('keeps the page first on a supplemented table when the caller says so', async () => {
    const log = []
    const table = await buildTable({ task: TASK, entries: ENTRIES, model: MODELS.strong, ask: fakeAsk() })
    const request = { id: 'r-extra-page-first', text: 'a heavy thing, page first' }
    await run(table, { log, request, gate: { extraQuestions: ['Weight?'] }, search: { ...SEARCH, requestFirst: false } })
    assert.match(log.find((r) => r.systemPrompt.startsWith('You select')).userContent[0], /^Page of 10 rows/u)
  })

  it('runs a full-text pass on the cheap model when the gate asks, and scores the union', async () => {
    const log = []
    const table = await buildTable({ task: TASK, entries: ENTRIES, model: MODELS.strong, ask: fakeAsk() })
    const request = { id: 'r-full', text: 'something only the entries say' }
    const { results, fullStages } = await run(table, { log, request, gate: { fullScan: true }, search: { ...SEARCH, pageChars: 200 } })
    const full = log.filter((r) => r.systemPrompt.includes('Each row is one full entry'))
    assert.ok(full.length > 0)
    assert.ok(full.every((r) => r.model === MODELS.cheap && r.userContent[0].startsWith('Request:')))
    assert.deepEqual(fullStages.map((s) => s.rows), [50])
    assert.deepEqual(results.map((r) => r.id).sort(), [...MATCHES].sort())
  })

  it('skips the gate when told to, and cuts the ranking at topK', async () => {
    const log = []
    const table = await buildTable({ task: TASK, entries: ENTRIES, model: MODELS.strong, ask: fakeAsk() })
    const { results, gate } = await run(table, { log, useGate: false, topK: 2 })
    assert.equal(results.length, 2)
    assert.equal(gate.reason, 'gate skipped')
    assert.equal(log.filter((r) => r.systemPrompt.startsWith('A dataset')).length, 0)
  })

  it('scores a small table outright, with no search stage', async () => {
    const log = []
    const table = await buildTable({ task: TASK, entries: entriesOf(4, ['e2']), model: MODELS.strong, ask: fakeAsk() })
    const { results, stages } = await run(table, { log })
    assert.deepEqual(stages, [])
    assert.deepEqual(results.map((r) => [r.id, r.score]), [['e2', 90], ['e1', 10], ['e3', 10], ['e4', 10]])
  })
})

describe('union', () => {
  const candidate = (id, votes, score) => ({ row: { id }, votes, score })

  it('keeps every row of either list once, and for a row in both the reading with more votes, then the higher score', () => {
    const first = [candidate('a', 3, 9), candidate('b', 2, 8), candidate('c', 2, 6), candidate('d', 1, 9)]
    const second = [candidate('b', 3, 5), candidate('c', 2, 7), candidate('d', 1, 4), candidate('e', 1, 8)]
    const merged = union(first, second)
    assert.deepEqual(merged.map(({ row, votes, score }) => [row.id, votes, score]), [['a', 3, 9], ['b', 3, 5], ['c', 2, 7], ['d', 1, 9], ['e', 1, 8]])
  })
})
