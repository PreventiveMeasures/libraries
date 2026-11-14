import { oneLine } from './json.js'

// Every prompt the phases send, worded in one file. A system prompt carries the task and nothing of one
// entry or request, as the layer marks it for a long-lived prompt-cache entry.

const taskLines = (task) => `Task: ${task.prompt.trim()}\nMain question: ${task.question.trim()}`

// Every block but the last ends in a blank line, as a route reading no cache marker joins them with
// nothing between; at the end of the earlier one, so the shared prefix is the same whatever follows
export const blocks = (...parts) => parts.map((part, i) => (i < parts.length - 1 ? `${part}\n\n` : part))

const questionLines = (questions) => questions.map((q) => `${q.id}. ${q.text}`).join('\n')

// Phase 0: everything the search later reads is what this schema carries
export function proposeSystem(maxQuestions) {
  return `You design a compact index of a large dataset for one fixed task. Each entry of the dataset will be reduced, before any request is seen, to a summary of one or two sentences and short answers to a fixed list of questions. Later, a reader holding only those summaries and answers, never the full entries, must pick the entries that best match a request under the task's main question.

Propose the questions. A good question:
- is answerable from a single entry alone, without knowing the request;
- has a short, comparable answer: a category, a number, a name, a short phrase, or "unknown" when the entry does not say;
- separates entries that would match a typical request from entries that would not;
- covers one aspect the main question turns on, each aspect once.
Also say in one sentence what the summary should focus on, so that it carries what the questions cannot.

Return only JSON: {"focus":"...","questions":["...","..."]} with at most ${maxQuestions} questions.`
}

export const proposeUser = taskLines

// Phase 1; `summarize` off is the supplement pass, answers alone
export function compactSystem({ task, focus, questions, summarize }) {
  const count = questions.length
  const summaryAsk = summarize ? `Write a summary of the entry in one or two sentences, focused on: ${oneLine(focus)}\nThen answer` : 'Answer'
  const shape = summarize ? `{"summary":"...","answers":["...","..."]}` : `{"answers":["...","..."]}`
  return `You compact entries of a dataset for one fixed task, so that a reader holding only your output, never the entry, can judge the entry against requests under the task's main question.
${taskLines(task)}

Questions:
${questionLines(questions)}

${summaryAsk} each question in at most ten words, from the entry alone; write "unknown" where the entry does not say. Never invent what the entry does not state.
Return only JSON: ${shape} with exactly ${count} answers, in the order of the questions.`
}

export const compactUser = (entry) => `Entry:\n${entry.text}`

// Phase 6, run first: extra columns cost one cheap pass, reading the full entries the path the compaction
// exists to avoid, so they are asked apart
export function gateSystem({ task, focus, questions, maxExtra }) {
  return `A dataset was compacted for a task before any request was seen: every entry became a summary and short answers to fixed questions. A request has now arrived, and the search over the dataset will read those summaries and answers, not the entries.
${taskLines(task)}
Summary focus: ${oneLine(focus)}
Questions:
${questionLines(questions)}

Decide whether judging this request's match turns on something those columns do not carry.
- If a few more short-answer questions, each answerable per entry from the entry alone, would carry it, list them: at most ${maxExtra}, none that the existing questions already cover.
- If the match cannot be judged without reading the full entries at all, even with more questions, say so with fullScan true.
- If the columns suffice, return no extra questions and fullScan false.
Return only JSON: {"extraQuestions":["..."],"fullScan":false,"reason":"one sentence"}`
}

export const requestBlock = (request) => `Request:\n${request.text}`

// Phases 2-4: the limit is a ceiling, not a quota, so a page of nothing promotes nothing
export function searchSystem({ task, mode }) {
  const rows = mode === 'full'
    ? 'Each row is one full entry of the dataset.'
    : 'Each row is one entry of the dataset, compacted: a short summary, then short answers to fixed questions by column id. The columns are named at the top of the page.'
  return `You select, from one page of a dataset, the entries that best match a request.
${taskLines(task)}

${rows} Judge every row against the request under the main question. Pick only the rows that plausibly match, and leave the rest out: picking nothing is a correct answer for a page with no match. Never pick more rows than the page's limit. Score each pick from 1 to 10 for how well it matches, 10 being a certain match.
Return only JSON: {"picks":[{"n":<row number>,"score":<1-10>}]}`
}

const columnHeader = (columns) => `Columns: ${columns.map((q) => `${q.id} = ${oneLine(q.text)}`).join('; ')}`

const summaryRow = (row, index, columns) => {
  const answers = columns.map((q, i) => `${q.id}: ${oneLine(row.answers[i] ?? 'unknown')}`).join(' | ')
  return `${index + 1}. ${oneLine(row.summary)} || ${answers}`
}

const fullRow = (row, index) => `[${index + 1}]\n${row.entry.trim()}\n`

// Rows are numbered on the page rather than carry their ids, which a model reconstructs where it copies
// an ordinal; the limit is the page's own, so it is stated there
export function pageBlock({ page, columns, mode, cap }) {
  const head = mode === 'full' ? 'Rows:' : `${columnHeader(columns)}\nRows:`
  const body = mode === 'full' ? page.map(fullRow).join('\n') : page.map((row, i) => summaryRow(row, i, columns)).join('\n')
  return `Page of ${page.length} rows; pick at most ${cap}.\n${head}\n${body}`
}

// Phase 5: the evidence is asked for as a sentence and as a span copied word for word, which can be
// checked against the entry without another call
export function scoreSystem(task) {
  return `You judge one candidate entry of a dataset against a request, under a task.
${taskLines(task)}

Read both in full. Score from 0 to 100 how well the candidate matches the request under the main question: 100 is a certain and complete match, 50 a partial or uncertain one, 0 unrelated. Give one sentence naming the decisive evidence, from the candidate, for the score, and quote that evidence: a short span copied from the candidate word for word, not paraphrased.
Return only JSON: {"score":<0-100>,"reason":"...","evidence":"..."}`
}

export const candidateBlock = (row) => `Candidate:\n${row.entry}`

// Phase 5b: the prompt says the order carries nothing, as the list is shuffled between rounds
export function rerankSystem(task) {
  return `You order a short list of candidate entries of a dataset by how well each matches a request, under a task.
${taskLines(task)}

Read the request and every candidate in full. Order all the candidates from the best match to the worst under the main question, judging each on its own content: the order they are listed in carries no information.
Return only JSON: {"order":[<candidate numbers, best first>]} naming every candidate once.`
}

export const listBlock = (rows) => `Candidates: ${rows.length}\n${rows.map(fullRow).join('\n')}`
