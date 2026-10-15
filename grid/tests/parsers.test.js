import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { setCacheDir } from '@preventive/ai'
import { newTally } from '../src/call.js'
import { compact } from '../src/compact.js'
import { gate, proposeQuestions } from '../src/schema.js'
import { score } from '../src/score.js'
import { TASK } from './fake.js'

// What each phase accepts as an answer, and what it sends back for another try. Driven through the
// phases themselves, so the retry that a refused shape earns is the real one.
const CACHE_DIR = join(tmpdir(), `grid-parsers-test-${process.pid}`)
after(async () => { await rm(CACHE_DIR, { recursive: true, force: true }) })

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cost: 0 }
// Answers in order; records what each request carried, so a test can see the nudge.
const scripted = (texts, seen = []) => Object.assign((request) => {
  seen.push(request.userContent)
  return Promise.resolve({ text: texts.shift(), usage, history: [] })
}, { seen })

const QUESTIONS = [{ id: 'q1', text: 'Colour?' }]
const FOCUS = 'the colour'
const common = () => ({ task: TASK, model: 'test/parsers', tally: newTally() })

describe('gate', () => {
  before(() => setCacheDir(CACHE_DIR))

  it('re-asks an empty object rather than reading it as "the columns suffice"', async () => {
    const ask = scripted(['{}', '{"extraQuestions":["Weight?"],"fullScan":false,"reason":"needs weight"}'])
    const routing = await gate({ ...common(), focus: FOCUS, questions: QUESTIONS, request: { id: 'g1', text: 'heavy' }, ask })
    assert.deepEqual(routing, { extraQuestions: [{ id: 'x1', text: 'Weight?' }], fullScan: false, reason: 'needs weight' })
    assert.equal(ask.seen.length, 2)
    assert.match(ask.seen[1], /Return only the JSON asked for/u)
  })

  it('refuses a fullScan that is not a boolean, twice', async () => {
    const ask = scripted(['{"extraQuestions":[],"fullScan":"true"}', '{"extraQuestions":[],"fullScan":"yes"}'])
    await assert.rejects(
      () => gate({ ...common(), focus: FOCUS, questions: QUESTIONS, request: { id: 'g2', text: 'odd' }, ask }),
      /gate g2: malformed response after a retry: expected an extraQuestions list and a boolean fullScan/u,
    )
  })

  it('caps the extra questions and tolerates a missing reason', async () => {
    const ask = scripted(['{"extraQuestions":["a","b","c"],"fullScan":true}'])
    const routing = await gate({ ...common(), focus: FOCUS, questions: QUESTIONS, request: { id: 'g3', text: 'many' }, maxExtra: 2, ask })
    assert.deepEqual(routing, { extraQuestions: [{ id: 'x1', text: 'a' }, { id: 'x2', text: 'b' }], fullScan: true, reason: '' })
  })
})

describe('proposeQuestions', () => {
  before(() => setCacheDir(CACHE_DIR))

  it('reads a fenced answer, numbers the questions and caps them', async () => {
    const ask = scripted(['Sure:\n```json\n{"focus":"size","questions":["How big?","How old?","Where?"]}\n```'])
    const { focus, questions } = await proposeQuestions({ ...common(), task: { ...TASK, id: 'p1' }, maxQuestions: 2, ask })
    assert.equal(focus, 'size')
    assert.deepEqual(questions, [{ id: 'q1', text: 'How big?' }, { id: 'q2', text: 'How old?' }])
  })

  it('re-asks when no question came back', async () => {
    const ask = scripted(['{"focus":"x","questions":[]}', '{"focus":"x","questions":["One?"]}'])
    const { questions } = await proposeQuestions({ ...common(), task: { ...TASK, id: 'p2' }, ask })
    assert.deepEqual(questions, [{ id: 'q1', text: 'One?' }])
    assert.equal(ask.seen.length, 2)
  })
})

describe('compact', () => {
  before(() => setCacheDir(CACHE_DIR))

  it('pads a short answer list, cuts a long one, and re-asks when there is no list', async () => {
    const questions = [{ id: 'q1', text: 'a' }, { id: 'q2', text: 'b' }]
    const ask = scripted([
      '{"summary":"short","answers":["one"]}',
      '{"summary":"long","answers":["one","two","three"]}',
      '{"summary":"none"}',
      '{"summary":"none again","answers":["x","y"]}',
    ])
    const entries = [{ id: 'c1', text: 'c1: short' }, { id: 'c2', text: 'c2: long' }, { id: 'c3', text: 'c3: none' }]
    const rows = await compact({ ...common(), focus: FOCUS, questions, entries, concurrency: 1, ask })
    assert.deepEqual(rows.map((row) => [row.summary, row.answers]), [['short', ['one', 'unknown']], ['long', ['one', 'two']], ['none again', ['x', 'y']]])
    assert.equal(ask.seen.length, 4)
  })

  it('re-asks a summary that is not a string rather than stringifying it', async () => {
    const questions = [{ id: 'q1', text: 'a' }]
    const ask = scripted(['{"summary":true,"answers":["x"]}', '{"summary":"real","answers":["x"]}', '{"summary":{"text":"obj"},"answers":["y"]}', '{"summary":"also real","answers":["y"]}'])
    const entries = [{ id: 't1', text: 't1: bool' }, { id: 't2', text: 't2: object' }]
    const rows = await compact({ ...common(), focus: FOCUS, questions, entries, concurrency: 1, ask })
    assert.deepEqual(rows.map((row) => row.summary), ['real', 'also real'])
    assert.equal(ask.seen.length, 4)
  })

  it('keeps every answer at its own question, reading a blank or a null in the middle as unknown', async () => {
    const questions = [{ id: 'q1', text: 'a' }, { id: 'q2', text: 'b' }, { id: 'q3', text: 'c' }]
    const ask = scripted(['{"summary":"gaps","answers":["red",null,"large"]}', '{"summary":"blank","answers":[" a ","",7]}'])
    const entries = [{ id: 'p1', text: 'p1: gaps' }, { id: 'p2', text: 'p2: blank' }]
    const rows = await compact({ ...common(), focus: FOCUS, questions, entries, concurrency: 1, ask })
    assert.deepEqual(rows.map((row) => row.answers), [['red', 'unknown', 'large'], ['a', 'unknown', 'unknown']])
  })
})

describe('score', () => {
  before(() => setCacheDir(CACHE_DIR))

  it('re-asks a score that is not a number, and reads a quoted one', async () => {
    const ask = scripted(['{"score":null,"reason":"none"}', '{"score":"85","reason":"quoted"}', '{"score":true,"reason":"bool"}', '{"score":12.5,"reason":"second"}'])
    const candidates = [{ row: { id: 's1', entry: 's1', summary: '' }, votes: 2, score: 8 }, { row: { id: 's2', entry: 's2', summary: '' }, votes: 1, score: 5 }]
    const ranked = await score({ ...common(), request: { id: 'sr', text: 'r' }, candidates, concurrency: 1, ask })
    assert.deepEqual(ranked.map((r) => [r.id, r.score, r.reason]), [['s1', 85, 'quoted'], ['s2', 12.5, 'second']])
    assert.equal(ask.seen.length, 4)
  })
})
