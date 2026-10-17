import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { setCacheDir } from '@preventive/ai'
import { buildTable, evaluate } from '../index.js'
import { TASK, entriesOf, fakeAsk } from './fake.js'

const CACHE_DIR = join(tmpdir(), `grid-evaluate-test-${process.pid}`)
after(async () => { await rm(CACHE_DIR, { recursive: true, force: true }) })

const MATCHES = ['e4', 'e11', 'e19', 'e33', 'e48']
// Fifty entries with five matches, and a copy of one match under its own id.
const ENTRIES = [...entriesOf(50, MATCHES), { id: 'e51', text: 'e4: entry number 4 MATCH' }]
const MODELS = { strong: 'test/strong', search: 'test/search', cheap: 'test/cheap' }
const SEARCH = { pageSize: 10, pick: 0.5, rounds: 3, minVotes: 2 }

describe('evaluate', () => {
  before(() => setCacheDir(CACHE_DIR))

  const run = async (table, options) => await evaluate({ ...table, models: MODELS, final: 0.1, minFinal: 5, search: SEARCH, ask: fakeAsk(), ...options })

  it('measures recall, precision and reciprocal rank at the cut, and says where a miss was lost', async () => {
    const table = await buildTable({ task: TASK, entries: ENTRIES, model: MODELS.strong, ask: fakeAsk() })
    const seen = []
    const { runs, recall, precision, mrr, tally } = await run(table, {
      topK: 3,
      cases: [
        { request: { id: 'c1', text: 'all five' }, relevant: MATCHES },
        { request: { id: 'c2', text: 'two of them and a stranger' }, relevant: ['e4', 'e11', 'e7'] },
      ],
      onCase: (one) => seen.push(one.id),
    })
    assert.deepEqual(seen, ['c1', 'c2'])
    const [c1, c2] = runs
    // Five finalists, all of them matches, three returned at the cut: the other two are below it.
    assert.equal(c1.returned, 3)
    assert.equal(c1.hits.length, 3)
    assert.equal(c1.belowCut.length, 2)
    assert.deepEqual([...c1.hits, ...c1.belowCut].sort(), [...MATCHES].sort())
    assert.deepEqual(c1.dropped, [])
    assert.deepEqual([c1.recall, c1.precision, c1.reciprocalRank], [0.6, 1, 1])
    assert.deepEqual(c1.stages.map((s) => [s.rows, s.survivors]), [[50, 5]])
    assert.equal(c1.reranked, 5)
    // e7 never reached the finalists; e4 and e11 did, and are hits or below the cut by where the
    // listwise pass put them.
    assert.deepEqual(c2.dropped, ['e7'])
    assert.deepEqual([...c2.hits, ...c2.belowCut].sort(), ['e11', 'e4'])
    assert.equal(c2.recall, c2.hits.length / 3)
    assert.equal(c2.precision, c2.hits.length / 3)
    assert.ok(c2.reciprocalRank === 0 || (c2.reciprocalRank >= 1 / 3 && c2.reciprocalRank <= 1))
    assert.equal(recall, (c1.recall + c2.recall) / 2)
    assert.equal(precision, (c1.precision + c2.precision) / 2)
    assert.equal(mrr, (c1.reciprocalRank + c2.reciprocalRank) / 2)
    assert.ok(tally.calls > 0)
  })

  it('counts a relevant copy as found through the result that stands for it, and measures every finalist without a cut', async () => {
    const table = await buildTable({ task: TASK, entries: ENTRIES, model: MODELS.strong, ask: fakeAsk() })
    const { runs } = await run(table, { cases: [{ request: { id: 'c3', text: 'the copy' }, relevant: ['e51'] }] })
    const [c3] = runs
    assert.equal(c3.returned, 5)
    assert.deepEqual(c3.hits, ['e51'])
    assert.deepEqual([c3.recall, c3.precision], [1, 0.2])
    assert.ok(c3.reciprocalRank >= 0.2 && c3.reciprocalRank <= 1)
  })

  it('refuses no cases, a case with no request, and relevant ids that are not strings', async () => {
    const table = { task: TASK, focus: 'f', questions: [], rows: [] }
    await assert.rejects(() => run(table, { cases: [] }), /at least one case/u)
    await assert.rejects(() => run(table, { cases: [{ relevant: [] }] }), /case 0 has no request/u)
    await assert.rejects(() => run(table, { cases: [{ request: { id: 'x', text: 'x' }, relevant: [1] }] }), /case x has no relevant ids/u)
  })
})
