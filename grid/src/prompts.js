import { oneLine } from './json.js'

// Every prompt the phases send, and the renderings of the data they carry. In one file so the
// wording that decides what a run does is read in one sitting, and so a phase module holds the
// logic alone.
//
// Each system prompt carries the task, which is stable for a whole run, and nothing of any one
// entry or request: the layer marks the system prompt for a long-lived prompt-cache entry, and a
// request's per-call text goes in the user message where the cache is keyed per call.

const taskLines = (task) => `Task: ${task.prompt.trim()}\nMain question: ${task.question.trim()}`

// The blocks of one user message, in order. Every block but the last ends in a blank line, because
// on a route that reads no cache marker the layer joins the blocks with nothing between them, and
// a request glued to the last row of a page reads as part of that row. The separator sits at the
// end of the earlier block rather than the start of the later one so the shared prefix -- the page
// in the first stage, the request after -- stays byte-identical whatever follows it.
export const blocks = (...parts) => parts.map((part, i) => (i < parts.length - 1 ? `${part}\n\n` : part))

const questionLines = (questions) => questions.map((q) => `${q.id}. ${q.text}`).join('\n')

// Phase 0: the questions the compaction answers per entry, decided once per task before any entry
// or request is seen. Everything the search later reads is what this schema carries, so the prompt
// is explicit about what makes a question worth asking: answerable from the entry alone, with a
// short comparable answer, and discriminating under the main question.
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

export const proposeUser = (task) => taskLines(task)

// Phase 1: one entry into one row. `summarize` off is the supplement pass: extra questions a gate
// asked for one request, answered by a cheaper model over the whole dataset, with no summary.
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

// Phase 6, run first: whether this request's match turns on something the compaction never
// extracted. Two answers, because they cost different things: a few more short-answer columns are
// one cheap pass over the dataset, while reading the full entries is the expensive path the
// compaction exists to avoid, taken only when nothing short of it would do.
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

// Phases 2-4: one page of rows against the request. The limit is a ceiling, not a quota -- the one
// sentence that keeps a page of nothing from promoting its least bad row -- and every pick carries
// a score, which is what the rounds are aggregated on.
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

// The page as the model reads it. Rows are numbered from 1 on the page and never carry their real
// ids: an ordinal is three characters the model copies reliably, where a long id is something it
// reconstructs. The limit is stated on the page rather than in the system prompt because it is the
// page's own, and in the first stage the page is the block shared across requests.
export function pageBlock({ page, columns, mode, cap }) {
  const head = mode === 'full' ? 'Rows:' : `${columnHeader(columns)}\nRows:`
  const body = mode === 'full' ? page.map(fullRow).join('\n') : page.map((row, i) => summaryRow(row, i, columns)).join('\n')
  return `Page of ${page.length} rows; pick at most ${cap}.\n${head}\n${body}`
}

// Phase 5: one finalist, in full, against the request in full. An absolute scale this time, since
// the finalists are ranked on it alone and a caller may cut by it.
export function scoreSystem(task) {
  return `You judge one candidate entry of a dataset against a request, under a task.
${taskLines(task)}

Read both in full. Score from 0 to 100 how well the candidate matches the request under the main question: 100 is a certain and complete match, 50 a partial or uncertain one, 0 unrelated. Give one sentence naming the decisive evidence, from the candidate, for the score.
Return only JSON: {"score":<0-100>,"reason":"..."}`
}

export const candidateBlock = (row) => `Candidate:\n${row.entry}`
