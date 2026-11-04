import { call } from './call.js'
import { expectObject, extractJSON, sentenceList } from './json.js'
import { gateSystem, proposeSystem, proposeUser, requestBlock } from './prompts.js'

// The two calls that decide what the table carries: the questions proposed once per task, and the
// per-request gate that says whether they were enough. Both are one call to the strong model, and
// both are the whole reason the compaction can be done blind.

// Column ids as the pages name them: the task's questions `q1..`, a request's extra ones `x1..`,
// so a row's answers and a page header line up by position and a model copying an id cannot
// confuse the two kinds.
const questionIds = (texts, prefix) => texts.map((text, i) => ({ id: `${prefix}${i + 1}`, text }))

// Both halves of the schema, or a re-ask: the focus shapes every compaction prompt after it, and a
// stand-in would be cached in its place for the whole table.
function readProposal(maxQuestions) {
  return (text) => {
    const json = expectObject(extractJSON(text), 'focus and questions')
    const questions = sentenceList(json.questions, 'questions').slice(0, maxQuestions)
    if (questions.length === 0) throw new TypeError('expected at least one question')
    const focus = typeof json.focus === 'string' ? json.focus.trim() : ''
    if (!focus) throw new TypeError('expected a focus for the summary')
    return { focus, questions }
  }
}

// Phase 0. The questions are the schema every row is compacted into and every page is read by, so
// they are a strong model's work and the table they produce is tied to them: a different set is a
// different table, which the cache keys (the system prompt carries the questions) already enforce.
export async function proposeQuestions({ task, model, maxQuestions = 8, think, effort, tally, ask }) {
  const { focus, questions } = await call({
    type: 'grid.propose', model, systemPrompt: proposeSystem(maxQuestions), userContent: proposeUser(task),
    parse: readProposal(maxQuestions), think, effort, tally, ask, label: `propose ${task.id}`,
  })
  return { focus, questions: questionIds(questions, 'q') }
}

// Both routing fields in the shape asked for, or the answer is re-asked: an empty object read as
// "the columns suffice" would cache, by default, the one decision the gate exists to make -- and
// so would a list whose one member is not a question, read as an empty list.
function readGate(maxExtra) {
  return (text) => {
    const json = expectObject(extractJSON(text), 'extraQuestions, fullScan and reason')
    if (typeof json.fullScan !== 'boolean') throw new TypeError('expected a boolean fullScan')
    return {
      extraQuestions: questionIds(sentenceList(json.extraQuestions, 'extraQuestions').slice(0, maxExtra), 'x'),
      fullScan: json.fullScan,
      reason: typeof json.reason === 'string' ? json.reason.trim() : '',
    }
  }
}

// Phase 6, run before the search. What the compaction could not anticipate is per request, so this
// is the one place a request is read against the schema rather than against rows. Its answer
// routes the request: extra columns, a full-text pass, or neither.
export async function gate({ task, focus, questions, request, model, maxExtra = 4, think, effort, tally, ask }) {
  return await call({
    type: 'grid.gate', model, systemPrompt: gateSystem({ task, focus, questions, maxExtra }), userContent: requestBlock(request),
    parse: readGate(maxExtra), think, effort, tally, ask, label: `gate ${request.id}`,
  })
}
