import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { setCacheDir } from '@preventive/ai'
import { buildTable, groupDuplicates, select } from '../index.js'
import { jaccard, shingles, words } from '../src/dedupe.js'
import { hashSeed, random } from '../src/random.js'
import { TASK, entriesOf, fakeAsk } from './fake.js'

const CACHE_DIR = join(tmpdir(), `grid-dedupe-test-${process.pid}`)
after(async () => { await rm(CACHE_DIR, { recursive: true, force: true }) })

// A text of `n` distinct words, so that one word changed moves five shingles of the ninety-six.
const prose = (n = 100, stem = 'w') => Array.from({ length: n }, (_, i) => `${stem}${i}`).join(' ')
const changed = (text, ...at) => {
  const list = text.split(' ')
  for (const i of at) list[i] = `CHANGED${i}`
  return list.join(' ')
}

describe('shingles and jaccard', () => {
  it('folds case and punctuation into words, and a short or empty text into one shingle or none', () => {
    assert.deepEqual(words('Hello, World! 42'), ['hello', 'world', '42'])
    assert.equal(shingles(words('one two'), 5).length, 1)
    assert.equal(shingles([], 5).length, 0)
    assert.equal(shingles(words(prose()), 5).length, 96)
    assert.equal(shingles(words('a b a b a b'), 2).length, 2, 'distinct')
  })

  it('measures one word changed in a hundred at 0.90, and three changed apart at 0.73', () => {
    const base = shingles(words(prose()), 5)
    assert.ok(Math.abs(jaccard(base, shingles(words(changed(prose(), 50)), 5)) - 91 / 101) < 1e-9)
    assert.ok(Math.abs(jaccard(base, shingles(words(changed(prose(), 20, 50, 80)), 5)) - 81 / 111) < 1e-9)
    assert.equal(jaccard(base, base), 1)
    assert.equal(jaccard(new Uint32Array(0), new Uint32Array(0)), 1)
    assert.equal(jaccard(base, shingles(words(prose(100, 'v')), 5)), 0)
  })
})

describe('groupDuplicates', () => {
  it('groups exact copies whatever their case and punctuation, under the first id in input order', () => {
    const groups = groupDuplicates([
      { id: 'a', text: 'The red barn, by the river.' },
      { id: 'b', text: 'an unrelated note' },
      { id: 'c', text: 'the RED barn by the river' },
      { id: 'd', text: 'The red barn, by the river.' },
      { id: 'e', text: '' },
      { id: 'f', text: '  \n ' },
    ])
    assert.deepEqual([...groups], [['a', ['c', 'd']], ['e', ['f']]])
  })

  it('groups near copies at the threshold and keeps distinct texts apart', () => {
    // At 0.90, 0.81 and 0.73 from the base; the third changes words the second keeps, so it is far
    // from every other text too and joins only when the threshold lets it in directly.
    const base = prose()
    const entries = [
      { id: 'base', text: base },
      { id: 'one', text: changed(base, 50) },
      { id: 'two', text: changed(base, 20, 80) },
      { id: 'three', text: changed(base, 10, 40, 70) },
      { id: 'other', text: prose(100, 'v') },
    ]
    assert.deepEqual([...groupDuplicates(entries)], [['base', ['one', 'two']]])
    assert.deepEqual([...groupDuplicates(entries, { threshold: 0.7 })], [['base', ['one', 'two', 'three']]])
    assert.deepEqual([...groupDuplicates(entries, { threshold: 0.95 })], [])
  })

  it('groups through a chain: a copy of a copy joins the first, even when it is far from it', () => {
    const base = prose()
    const entries = [
      { id: 'first', text: base },
      { id: 'second', text: changed(base, 30) },
      { id: 'third', text: changed(base, 30, 60, 90) },
    ]
    assert.ok(jaccard(shingles(words(base), 5), shingles(words(entries[2].text), 5)) < 0.8, 'third is under the threshold from first')
    assert.deepEqual([...groupDuplicates(entries)], [['first', ['second', 'third']]])
  })

  it('finds every planted copy among hundreds of distinct texts, and nothing else', () => {
    const rng = random(hashSeed('dedupe test'))
    const word = () => `t${Math.floor(rng() * 5000)}`
    const texts = Array.from({ length: 300 }, () => Array.from({ length: 120 }, word).join(' '))
    const entries = texts.map((text, i) => ({ id: `d${i}`, text }))
    const planted = []
    for (let i = 0; i < texts.length; i += 10) {
      entries.push({ id: `copy${i}`, text: changed(texts[i], 60) })
      planted.push([`d${i}`, [`copy${i}`]])
    }
    assert.deepEqual([...groupDuplicates(entries)], planted)
  })

  it('refuses ids that repeat and options that make no sense', () => {
    assert.throws(() => groupDuplicates([{ id: 'x', text: 'a' }, { id: 'x', text: 'b' }]), /ids must be distinct/u)
    assert.throws(() => groupDuplicates([], { threshold: 0 }), /threshold/u)
    assert.throws(() => groupDuplicates([], { threshold: 1.5 }), /threshold/u)
    assert.throws(() => groupDuplicates([], { shingle: 0 }), /shingle/u)
    assert.throws(() => groupDuplicates([], { hashes: 10, bands: 4 }), /multiple of bands/u)
    // Zero and a negative multiple divide evenly, and would make every signature empty.
    assert.throws(() => groupDuplicates([], { hashes: 0, bands: 16 }), /positive whole multiple/u)
    assert.throws(() => groupDuplicates([], { hashes: -32, bands: 16 }), /positive whole multiple/u)
    assert.deepEqual([...groupDuplicates([])], [])
  })
})

describe('buildTable and select over copies', () => {
  before(() => setCacheDir(CACHE_DIR))

  const MODELS = { strong: 'test/strong', search: 'test/search', cheap: 'test/cheap' }
  // Twelve entries, one a match; then an exact copy of the match and a copy of another entry that
  // differs in case and punctuation.
  const ENTRIES = [...entriesOf(12, ['e4']), { id: 'e13', text: 'e4: entry number 4 MATCH' }, { id: 'e14', text: 'E7 -- entry number 7!' }]

  it('compacts one entry of each group, and gives every copy a row that names it', async () => {
    const log = []
    const { rows, tally } = await buildTable({ task: TASK, entries: ENTRIES, model: MODELS.strong, ask: fakeAsk({ log }) })
    assert.equal(log.filter((r) => r.systemPrompt.startsWith('You compact')).length, 12)
    assert.equal(tally.calls, 13)
    assert.equal(rows.length, 14)
    assert.deepEqual(rows.map((row) => row.id), ENTRIES.map((entry) => entry.id), 'input order')
    assert.deepEqual(rows[3], { id: 'e4', taskId: 'colours', entry: 'e4: entry number 4 MATCH', summary: 'Summary of e4 MATCH', answers: ['a1 of e4', 'a2 of e4'], duplicates: ['e13'] })
    assert.deepEqual(rows[12], { id: 'e13', taskId: 'colours', entry: 'e4: entry number 4 MATCH', summary: 'Summary of e4 MATCH', answers: ['a1 of e4', 'a2 of e4'], dupOf: 'e4' })
    assert.deepEqual(rows[6].duplicates, ['e14'])
    assert.equal(rows[13].dupOf, 'e7')
    assert.ok(rows.filter((row) => !row.dupOf && !row.duplicates).every((row) => !('dupOf' in row) && !('duplicates' in row)))
  })

  it('searches and scores the distinct rows only, and a result carries the ids it stands for', async () => {
    const log = []
    const table = await buildTable({ task: TASK, entries: ENTRIES, model: MODELS.strong, ask: fakeAsk() })
    const { results } = await select({
      ...table, request: { id: 'dup-r1', text: 'the match' }, models: MODELS, final: 0.1, minFinal: 3,
      search: { pageSize: 6, pick: 0.5, rounds: 3 }, ask: fakeAsk({ log }),
    })
    assert.ok(results.length >= 1 && results.length <= 3)
    assert.deepEqual(results[0], { ...results[0], id: 'e4', score: 90, duplicates: ['e13'] })
    assert.ok(!results.some((r) => r.id === 'e13' || r.id === 'e14'))
    const paged = log.filter((r) => r.systemPrompt.startsWith('You select')).map((r) => r.userContent.find((block) => block.startsWith('Page of')))
    assert.ok(paged.length > 0 && paged.every((page) => !page.includes('Summary of e13') && !page.includes('Summary of e14')))
    assert.ok(paged.every((page) => page.startsWith('Page of 6 rows')), 'twelve distinct rows make two pages of six')
  })

  it('tells a copy by the property being set, not by its value: a canonical id can be the empty string', async () => {
    const log = []
    const entries = [{ id: '', text: 'blank: entry with no id MATCH' }, { id: 'c', text: 'blank: entry with no id MATCH' }, ...entriesOf(4, [])]
    const table = await buildTable({ task: TASK, entries, model: MODELS.strong, ask: fakeAsk() })
    assert.equal(table.rows[1].dupOf, '')
    assert.deepEqual(table.rows[0].duplicates, ['c'])
    const { results } = await select({
      ...table, request: { id: 'dup-r2', text: 'the entry with no id' }, models: MODELS, final: 0.5, minFinal: 2,
      search: { pageSize: 10, pick: 0.5, rounds: 3 }, ask: fakeAsk({ log }),
    })
    assert.deepEqual(results.map((r) => [r.id, r.duplicates]), [['', ['c']]])
    const paged = log.filter((r) => r.systemPrompt.startsWith('You select')).map((r) => r.userContent.find((block) => block.startsWith('Page of')))
    assert.ok(paged.length > 0 && paged.every((page) => page.startsWith('Page of 5 rows')), 'five distinct rows of six')
  })

  it('compacts every entry when told not to group', async () => {
    // Counted as cache lookups rather than model calls: the tests before this one compacted most of
    // these entries under the same prompts, and a copy's text is its original's cache key.
    const { rows, tally } = await buildTable({ task: TASK, entries: ENTRIES, model: MODELS.strong, dedupe: false, ask: fakeAsk() })
    assert.equal(tally.hits + tally.misses, 15)
    assert.ok(rows.every((row) => !('dupOf' in row) && !('duplicates' in row)))
  })
})
