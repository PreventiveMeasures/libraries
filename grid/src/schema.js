import { call } from './call.js'
import { expectObject, extractJSON, sentenceList, textOf } from './json.js'
import { gateSystem, proposeSystem, proposeUser, requestBlock } from './prompts.js'

// The questions proposed once per task, and the per-request gate that says whether they were enough

// Column ids `q1..` for the task's questions and `x1..` for a request's, so the two never mix
const questionIds = (texts, prefix) => texts.map((text, i) => ({ id: `${prefix}${i + 1}`, text }))

// Both halves, or a re-ask: a stand-in focus would shape every compaction prompt, cached for the table
function readProposal(maxQuestions) {
  return (text) => {
    const json = expectObject(extractJSON(text), 'focus and questions')
    const questions = sentenceList(json.questions, 'questions').slice(0, maxQuestions)
    if (questions.length === 0) throw new TypeError('expected at least one question')
    const focus = textOf(json.focus)
    if (!focus) throw new TypeError('expected a focus for the summary')
    return { focus, questions }
  }
}

// Phase 0, a strong model's work: the schema every row is compacted into. Another set is another table,
// which the cache keys already say, as the system prompts carry the questions.
export async function proposeQuestions({ task, model, maxQuestions = 8, think, effort, tally, ask }) {
  const { focus, questions } = await call({
    type: 'grid.propose', model, systemPrompt: proposeSystem(maxQuestions), userContent: proposeUser(task),
    parse: readProposal(maxQuestions), think, effort, tally, ask, label: `propose ${task.id}`,
  })
  return { focus, questions: questionIds(questions, 'q') }
}

// Both routing fields as asked, or a re-ask: an empty object read as "the columns suffice" would cache,
// by default, the one decision the gate exists to make
function readGate(maxExtra) {
  return (text) => {
    const json = expectObject(extractJSON(text), 'extraQuestions, fullScan and reason')
    if (typeof json.fullScan !== 'boolean') throw new TypeError('expected a boolean fullScan')
    return {
      extraQuestions: questionIds(sentenceList(json.extraQuestions, 'extraQuestions').slice(0, maxExtra), 'x'),
      fullScan: json.fullScan,
      reason: textOf(json.reason),
    }
  }
}

// Phase 6, before the search: the request read against the schema, routed to extra columns, a full-text
// pass, or neither
export async function gate({ task, focus, questions, request, model, maxExtra = 4, think, effort, tally, ask }) {
  return await call({
    type: 'grid.gate', model, systemPrompt: gateSystem({ task, focus, questions, maxExtra }), userContent: requestBlock(request),
    parse: readGate(maxExtra), think, effort, tally, ask, label: `gate ${request.id}`,
  })
}
