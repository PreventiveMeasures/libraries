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
// the last stage alone), the summary, and one answer per question in question order.
export interface Row {
  id: string
  taskId: string
  entry: string
  summary: string
  answers: string[]
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

// Phases 0 and 1 together: the table for one task over one dataset. `model` is the strong one
// (ai's DEFAULT_MODEL when omitted); `tally` is created when omitted and returned either way.
export declare function buildTable(options: Partial<PhaseOptions> & {
  task: Task
  entries: Entry[]
  maxQuestions?: number | undefined
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
// it (0.2); `rounds` shuffles per stage (3) and `minVotes` the picks a row needs to survive one
// (2). `requestFirst` puts the request ahead of the page as the shared prompt-cache prefix; the
// first stage defaults to the page first, every later stage to the request first.
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
// themselves instead of the summaries.
export declare function search(options: PhaseOptions & SearchOptions & {
  task: Task
  request: Entry
  rows: Row[]
  columns?: Question[] | undefined
  mode?: 'summary' | 'full' | undefined
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
// from the request, so every request sees the same first-stage pages.
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
// evidence the model gave, and the votes it reached the stage with.
export interface Result {
  id: string
  score: number
  reason: string
  votes: number
  summary: string
}

// Phase 5: every candidate in full against the request in full, best first.
export declare function score(options: PhaseOptions & {
  task: Task
  request: Entry
  candidates: Candidate[]
  concurrency?: number | undefined
}): Promise<Result[]>

// The models a run uses: `strong` for the schema, the gate and the finalists (ai's DEFAULT_MODEL
// when omitted), `search` for the pages (strong when omitted), `cheap` for whatever the gate sends
// over the whole dataset again (search when omitted).
export interface Models {
  strong?: string | undefined
  search?: string | undefined
  cheap?: string | undefined
}

// The pipeline for one request against one table. `final` (0.01) of the rows, and never fewer
// than `minFinal` (20), reach the full-text stage; `topK` cuts the ranked results, all of them when
// omitted; `useGate` off skips the gate and runs the summary search alone.
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
  concurrency?: number | undefined
  think?: boolean | undefined
  effort?: string | undefined
  tally?: Tally | undefined
  ask?: Ask | undefined
}): Promise<{ results: Result[], gate: Routing, stages: Stage[], fullStages: Stage[], tally: Tally }>
