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
      /gate g2: malformed response after a retry: expected a boolean fullScan/u,
    )
  })

  it('re-asks a non-empty extraQuestions list with a member that is not a question', async () => {
    const ask = scripted(['{"extraQuestions":[true],"fullScan":false,"reason":"needs another field"}', '{"extraQuestions":["Which field?"],"fullScan":false}'])
    const routing = await gate({ ...common(), focus: FOCUS, questions: QUESTIONS, request: { id: 'g4', text: 'a member that is not a question' }, ask })
    assert.deepEqual(routing.extraQuestions, [{ id: 'x1', text: 'Which field?' }])
    assert.equal(ask.seen.length, 2)
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

  it('re-asks a questions list with a member that is not a question, rather than keeping the rest', async () => {
    const ask = scripted(['{"focus":"f","questions":["One?",""]}', '{"focus":"f","questions":["One?","Two?"]}'])
    const { questions } = await proposeQuestions({ ...common(), task: { ...TASK, id: 'p6', prompt: `${TASK.prompt} (p6)` }, ask })
    assert.deepEqual(questions.map((q) => q.text), ['One?', 'Two?'])
    assert.equal(ask.seen.length, 2)
  })

  it('re-asks when the focus is missing, blank or not a string, rather than standing one in', async () => {
    // A proposal is keyed on the task's text, so each case asks about a task of its own.
    for (const [id, bad] of [['p3', '{"questions":["One?"]}'], ['p4', '{"focus":"  ","questions":["One?"]}'], ['p5', '{"focus":true,"questions":["One?"]}']]) {
      const ask = scripted([bad, '{"focus":"the size","questions":["One?"]}'])
      const { focus } = await proposeQuestions({ ...common(), task: { ...TASK, id, prompt: `${TASK.prompt} (${id})` }, ask })
      assert.equal(focus, 'the size')
      assert.equal(ask.seen.length, 2, id)
    }
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

  it('re-asks a score that is not a number, a reason that is not a sentence or evidence that is not text, and reads a quoted score', async () => {
    const ask = scripted([
      '{"score":null,"reason":"none","evidence":"s1"}', '{"score":"85","reason":"quoted","evidence":"s1"}',
      '{"score":true,"reason":"bool","evidence":"s2"}', '{"score":12.5,"reason":"second","evidence":"s2"}',
      '{"score":90,"reason":true,"evidence":"s3"}', '{"score":90,"reason":"evidence","evidence":"s3"}',
      '{"score":40,"reason":"no quote"}', '{"score":40,"reason":"late","evidence":"s4"}',
      '{"score":70,"reason":"quote not text","evidence":["s5"]}', '{"score":70,"reason":"listed","evidence":"s5"}',
    ])
    const candidate = (id, votes) => ({ row: { id, entry: id, summary: '' }, votes, score: 5 })
    const candidates = [candidate('s1', 2), candidate('s2', 1), candidate('s3', 1), candidate('s4', 1), candidate('s5', 1)]
    const ranked = await score({ ...common(), request: { id: 'sr', text: 'r' }, candidates, concurrency: 1, ask })
    assert.deepEqual(
      ranked.map((r) => [r.id, r.score, r.reason, r.evidence, r.grounded]),
      [['s3', 90, 'evidence', 's3', true], ['s1', 85, 'quoted', 's1', true], ['s5', 70, 'listed', 's5', true], ['s4', 40, 'late', 's4', true], ['s2', 12.5, 'second', 's2', true]],
    )
    assert.ok(ranked.every((r) => r.duplicates.length === 0))
    assert.equal(ask.seen.length, 10)
  })

  it('marks a result grounded when its evidence is in the entry word for word, and ranks it ahead at the same score', async () => {
    // Curly quotes, a line break and a run of spaces in the entry; straight quotes, one line, a
    // trailing stop and an ellipsis in what the model copied.
    // Each candidate's entry ends in its own id: three identical entries would be one cache key.
    const entry = (id) => `The red barn stands by the “river”,\n   under old oaks. (${id})`
    const ask = scripted([
      '{"score":80,"reason":"paraphrased","evidence":"a crimson barn near the water"}',
      '{"score":80,"reason":"quoted","evidence":"\\"red barn stands by the \\"river\\", under old oaks.\\""}',
      '{"score":80,"reason":"elided","evidence":"The red barn ... under old oaks"}',
    ])
    const candidates = ['g1', 'g2', 'g3'].map((id) => ({ row: { id, entry: entry(id), summary: '' }, votes: 1, score: 5 }))
    const ranked = await score({ ...common(), request: { id: 'gr', text: 'g' }, candidates, concurrency: 1, ask })
    assert.deepEqual(ranked.map((r) => [r.id, r.grounded]), [['g2', true], ['g3', true], ['g1', false]])
    assert.equal(ask.seen.length, 3)
  })
})
