// The typed contract for grid/index.js, hand-written as ai's is: index.js IS the surface, and the
// declarations below read against it name for name. Nothing checks them against the
// implementation, so a change to an exported signature belongs in the same commit as the change
// here.

import type { Usage } from '@preventive/ai'

// What the dataset is searched for: a stable id (part of every cache key through the prompts), the
// task's own prompt, and the main question a match is judged on. All three are known before the
// dataset or any request is.
export interface Task {
  id: string
  prompt: string
  question: string
}

// One entry of the dataset, and one request against it: an id the results name, and the text.
export interface Entry {
  id: string
  text: string
}

// A column of the table: `q1..` for the task's questions, `x1..` for a request's extra ones.
export interface Question {
  id: string
  text: string
}

// One row of the table: the entry's id, the task it was compacted for, the entry itself (read by
// the last stages alone), the summary, and one answer per question in question order. A row that
// buildTable found to be a copy of an earlier entry names that entry as `dupOf` and carries its
// summary and answers; the entry copied lists the copies' ids as `duplicates`. select() searches
// the rows that are not copies, and its results carry the ids each stands for.
export interface Row {
  id: string
  taskId: string
  entry: string
  summary: string
  answers: string[]
  dupOf?: string | undefined
  duplicates?: string[] | undefined
}

// What a run spent: the usage sum over every model call, how many calls went to the model, and
// how many lookups hit the disk cache against how many missed.
export interface Tally {
  usage: Usage
  calls: number
  hits: number
  misses: number
}

// The result of ask() as the phases read it; a scripted one stands in for the layer's in tests.
export type Ask = (request: {
  model: string
  maxTokens: number
  systemPrompt: string
  userContent: string | string[]
  think: boolean
  effort?: string | undefined
  label: string
  retries?: number | undefined
}) => Promise<{ text: string | null, error?: string | undefined, usage: Usage, history: unknown[] }>

// The options every phase takes: the model, the thinking settings handed to the layer, the tally
// spent into, and the ask() to issue through.
interface PhaseOptions {
  model: string
  think?: boolean | undefined
  effort?: string | undefined
  tally: Tally
  ask?: Ask | undefined
}

export declare function newTally(): Tally

// Phase 0: the questions every row answers, and what its summary focuses on, proposed once per
// task by a strong model. At most `maxQuestions` (8 when omitted).
export declare function proposeQuestions(options: PhaseOptions & {
  task: Task
  maxQuestions?: number | undefined
}): Promise<{ focus: string, questions: Question[] }>

// Phase 1: every entry into a row, `concurrency` (20) calls at a time. `summarize` off answers the
// questions alone, for extra columns over an already compacted dataset. `onRow` sees each row as
// it lands, in completion order, with the count done so far.
export declare function compact(options: PhaseOptions & {
  task: Task
  focus?: string | undefined
  questions: Question[]
  entries: Entry[]
  summarize?: boolean | undefined
  concurrency?: number | undefined
  onRow?: ((row: Row, done: number, total: number) => void) | undefined
}): Promise<Row[]>

// How copies are found among the entries, by text alone: two are copies at a Jaccard similarity of
// `threshold` (0.8) or more over their word `shingle`-grams (5); `hashes` (64) MinHash functions in
// `bands` (16) bands decide which pairs are compared, and the exact similarity decides the rest.
export interface DedupeOptions {
  threshold?: number | undefined
  shingle?: number | undefined
  hashes?: number | undefined
  bands?: number | undefined
}

// The groups of copies among `entries`, as a Map from the first id of each group in input order to
// the ids of its copies; an entry in no group is absent. No model call; deterministic.
export declare function groupDuplicates(entries: Entry[], options?: DedupeOptions | undefined): Map<string, string[]>

// Phases 0 and 1 together, with the copies grouped between them: the table for one task over one
// dataset, one row per entry in input order, only the distinct entries compacted. `model` is the
// strong one (ai's DEFAULT_MODEL when omitted); `dedupe` false keeps every entry distinct; `tally`
// is created when omitted and returned either way. `onRow` counts the distinct entries.
export declare function buildTable(options: Partial<PhaseOptions> & {
  task: Task
  entries: Entry[]
  maxQuestions?: number | undefined
  dedupe?: DedupeOptions | false | undefined
  concurrency?: number | undefined
  onRow?: ((row: Row, done: number, total: number) => void) | undefined
}): Promise<{ task: Task, focus: string, questions: Question[], rows: Row[], tally: Tally }>

// What the gate decided for a request: extra short-answer questions worth a cheap pass over the
// dataset (at most `maxExtra`, 4 when omitted), whether the match needs the full entries read, and
// why in one sentence.
export interface Routing {
  extraQuestions: Question[]
  fullScan: boolean
  reason: string
}

export declare function gate(options: PhaseOptions & {
  task: Task
  focus: string
  questions: Question[]
  request: Entry
  maxExtra?: number | undefined
}): Promise<Routing>

// One row as a search stage ranks it: picked in `votes` of the stage's rounds, with the mean of
// the scores it was picked at.
export interface Candidate {
  row: Row
  votes: number
  score: number
}

// How a search pages and votes. `pageSize` rows per page (200) in summary mode, `pageChars`
// characters per page (80000) in full mode; `pick` the ceiling on picks per page as a fraction of
// it (0.2); `rounds` shuffles per stage (3) and `minVotes` the picks a row needs to survive one: a
// majority of the rounds when omitted, and never more than the rounds. `requestFirst` puts the
// request ahead of the page as the shared prompt-cache prefix; the first stage defaults to the
// page first, every later stage to the request first.
export interface SearchOptions {
  pageSize?: number | undefined
  pageChars?: number | undefined
  pick?: number | undefined
  rounds?: number | undefined
  minVotes?: number | undefined
  requestFirst?: boolean | undefined
  concurrency?: number | undefined
}

// One stage: `rounds` shuffles of `rows` (seeded by `seed`, 0 when omitted), paged, every page
// asked once; the rows with enough votes come back best first, with how many pages were asked.
// `columns` names the answers each row carries, in order; `mode` 'full' pages the entries
// themselves instead of the summaries. `fill` is the fewest survivors to hand on when the rows
// allow: when fewer reach the vote threshold, the best of the rest that were picked at all follow
// them, up to it; a row nobody picked is never added.
export declare function search(options: PhaseOptions & SearchOptions & {
  task: Task
  request: Entry
  rows: Row[]
  columns?: Question[] | undefined
  mode?: 'summary' | 'full' | undefined
  fill?: number | undefined
  seed?: number | undefined
  label?: string | undefined
}): Promise<{ survivors: Candidate[], pages: number }>

// One stage's numbers: how many rows it started from, how many survived, how many pages it asked.
export interface Stage {
  stage: number
  rows: number
  survivors: number
  pages: number
}

// Stages of search() until at most `target` rows are left, or `maxStages` (6) have run, or a stage
// stopped shrinking the set. Shuffles are seeded from the task and the rows of each stage, never
// from the request, so every request sees the same first-stage pages. A stage's pick ceiling is
// raised above `pick` when retaining `target` rows needs more, and a stage fills to `target` from
// the rows picked below the vote threshold when too few reached it, so no stage cuts below the
// target while rows that were picked at all remain.
export declare function narrow(options: PhaseOptions & SearchOptions & {
  task: Task
  request: Entry
  rows: Row[]
  columns?: Question[] | undefined
  mode?: 'summary' | 'full' | undefined
  target: number
  maxStages?: number | undefined
  label?: string | undefined
}): Promise<{ candidates: Candidate[], stages: Stage[] }>

// One finalist as the full-text stage scores it: 0 to 100 on an absolute scale, the sentence of
// evidence the model gave and the span it quoted for it, whether that span is in the entry word
// for word (`grounded`), the votes it reached the stage with, and the ids of the copies of this
// entry it stands for. `listRank` is set by rerank(): the finalist's mean position over the
// listwise rounds, 1 when it came first in every one.
export interface Result {
  id: string
  score: number
  reason: string
  evidence: string
  grounded: boolean
  votes: number
  summary: string
  duplicates: string[]
  listRank?: number | undefined
}

// Phase 5: every candidate in full against the request in full, best first: by score, a grounded
// reading ahead of an ungrounded one at the same score, then votes.
export declare function score(options: PhaseOptions & {
  task: Task
  request: Entry
  candidates: Candidate[]
  concurrency?: number | undefined
}): Promise<Result[]>

// The listwise pass over the top of the pointwise ranking: the first `window` (20) results, as one
// list of full entries, ordered `rounds` (3) times under a different shuffle each, and ranked by
// mean position. Fewer than two in the window, or no rounds, leaves the order as it was.
export interface RerankOptions {
  window?: number | undefined
  rounds?: number | undefined
  concurrency?: number | undefined
}

// Phase 5b: `results` as score() ranks them, with the entries read back from `rows` by id. Returns
// the results with the window ordered and the rest after it unchanged, and how many were ordered.
export declare function rerank(options: PhaseOptions & RerankOptions & {
  task: Task
  request: Entry
  results: Result[]
  rows: Row[]
}): Promise<{ results: Result[], reranked: number }>

// The models a run uses: `strong` for the schema, the gate and the finalists (ai's DEFAULT_MODEL
// when omitted), `search` for the pages (strong when omitted), `cheap` for whatever the gate sends
// over the whole dataset again (search when omitted).
export interface Models {
  strong?: string | undefined
  search?: string | undefined
  cheap?: string | undefined
}

// The pipeline for one request against one table. `final` (0.01) of the rows, and never fewer
// than `minFinal` (20), reach the full-text stage; the top of its ranking is then ordered listwise
// under `rerank` (false keeps the pointwise order); `topK` cuts the results, all of them when
// omitted; `useGate` off skips the gate and runs the summary search alone. Rows marked `dupOf` are
// skipped, and the row they copy carries their ids in its result. `reranked` is how many results
// the listwise pass ordered.
export declare function select(options: {
  task: Task
  focus: string
  questions: Question[]
  rows: Row[]
  request: Entry
  models?: Models | undefined
  topK?: number | undefined
  final?: number | undefined
  minFinal?: number | undefined
  useGate?: boolean | undefined
  search?: SearchOptions | undefined
  rerank?: RerankOptions | false | undefined
  concurrency?: number | undefined
  think?: boolean | undefined
  effort?: string | undefined
  tally?: Tally | undefined
  ask?: Ask | undefined
}): Promise<{ results: Result[], reranked: number, gate: Routing, stages: Stage[], fullStages: Stage[], tally: Tally }>

// A request whose matches are known: the ids of the entries that match it.
export interface Case {
  request: Entry
  relevant: string[]
}

// One case measured: of its `relevant` ids, the `hits` among the results returned at the cut, the
// ones `belowCut` that reached the finalists but were scored under it, and the ones `dropped` that
// no stage carried to the finalists; `recall` is the hits over the relevant, `precision` the
// results at the cut that are relevant (or stand for a relevant copy) over the results returned,
// `reciprocalRank` one over the position of the first relevant result, 0 when none. With the
// routing and stages the request's select() took.
export interface Run {
  id: string
  recall: number
  precision: number
  reciprocalRank: number
  returned: number
  hits: string[]
  belowCut: string[]
  dropped: string[]
  gate: Routing
  stages: Stage[]
  fullStages: Stage[]
  reranked: number
}

// select() over every case, one after another, with no topK cut inside so that a miss can be
// placed; the measures are taken at `topK` (every finalist when omitted). Everything else is
// select()'s. `onCase` sees each run as it lands. Returns the runs, the means over them (`mrr` the
// mean reciprocal rank), and the one tally.
export declare function evaluate(options: Omit<Parameters<typeof select>[0], 'request'> & {
  cases: Case[]
  onCase?: ((run: Run) => void) | undefined
}): Promise<{ runs: Run[], recall: number, precision: number, mrr: number, tally: Tally }>
