/**
 * A compacted table over a large dataset for one fixed task, and the search that selects the entries
 * best matching a request
 *
 * ```js
 * import { buildTable, select } from '@preventive/grid'
 * import { evaluate } from '@preventive/grid'
 * ```
 *
 * `buildTable` once per task and dataset; `select` once per request; `evaluate` over requests whose
 * matches are known, for tuning. Every model call goes through `@preventive/ai`, whose disk cache
 * makes a run resumable and a re-run free; set its directory (`setCacheDir`) before calling anything.
 *
 * @module @preventive/grid
 */

import type { Usage } from '@preventive/ai';

/** What the dataset is searched for, known before the dataset or any request is */
export interface Task {
  /** Stable: part of every cache key */
  id: string;
  prompt: string;
  /** The question a match is judged on */
  question: string;
}

/** An entry of the dataset, or a request against it */
export interface Entry {
  id: string;
  text: string;
}

/** A column of the table */
export interface Question {
  /** `q1..` for the task's questions, `x1..` for a request's extra ones */
  id: string;
  text: string;
}

/** A row of the table */
export interface Row {
  id: string;
  taskId: string;
  /** The entry, read by the last stages alone */
  entry: string;
  summary: string;
  /** One per question, in question order */
  answers: string[];
  /** The earlier entry this one copies, whose summary and answers it carries; `select` skips it */
  dupOf?: string | undefined;
  /** The ids of this entry's copies */
  duplicates?: string[] | undefined;
}

/** What a run spent */
export interface Tally {
  /** Summed over every model call */
  usage: Usage;
  /** Calls that went to the model */
  calls: number;
  /** Disk cache lookups that hit */
  hits: number;
  /** Disk cache lookups that missed */
  misses: number;
}

/** The ask() the phases call, as `@preventive/ai` has it; a scripted one stands in for it in tests */
export type Ask = (request: {
  model: string;
  maxTokens: number;
  systemPrompt: string;
  userContent: string | string[];
  think: boolean;
  effort?: string | undefined;
  label: string;
  retries?: number | undefined;
}) => Promise<{ text: string | null; error?: string | undefined; usage: Usage; history: unknown[] }>;

/** What every phase takes */
interface PhaseOptions {
  model: string;
  /** Thinking settings, handed to the layer */
  think?: boolean | undefined;
  effort?: string | undefined;
  /** Spent into */
  tally: Tally;
  /** Default: `@preventive/ai`'s */
  ask?: Ask | undefined;
}

export declare function newTally(): Tally;

/**
 * Phase 0: the questions every row answers, and what its summary focuses on, proposed once per task
 *
 * @returns The focus, and at most `maxQuestions` (default: 8) questions
 */
export declare function proposeQuestions(options: PhaseOptions & {
  task: Task;
  maxQuestions?: number | undefined;
}): Promise<{ focus: string; questions: Question[] }>;

/**
 * Phase 1: every entry into a row, `concurrency` (default: 20) calls at a time
 *
 * `summarize: false` answers the questions alone, for extra columns over a compacted dataset.
 * `onRow` sees each row as it lands, in completion order.
 *
 * @returns The rows, in input order
 */
export declare function compact(options: PhaseOptions & {
  task: Task;
  focus?: string | undefined;
  questions: Question[];
  entries: Entry[];
  summarize?: boolean | undefined;
  concurrency?: number | undefined;
  onRow?: ((row: Row, done: number, total: number) => void) | undefined;
}): Promise<Row[]>;

/**
 * How copies are found, by text alone: Jaccard similarity over word shingles, with MinHash in bands
 * choosing which pairs are compared
 */
export interface DedupeOptions {
  /** The similarity at which two entries are copies (default: 0.8) */
  threshold?: number | undefined;
  /** Words per shingle (default: 5) */
  shingle?: number | undefined;
  /** MinHash functions (default: 64) */
  hashes?: number | undefined;
  /** Bands they are split into, dividing `hashes` (default: 16) */
  bands?: number | undefined;
}

/**
 * The copies among `entries`, with no model call; deterministic
 *
 * @returns A Map from each group's first id, in input order, to its copies' ids; an entry in no group is absent
 */
export declare function groupDuplicates(entries: Entry[], options?: DedupeOptions | undefined): Map<string, string[]>;

/**
 * Phases 0 and 1, with the copies grouped between them: the table for one task over one dataset
 *
 * One row per entry in input order, the distinct entries alone compacted; `onRow` counts those.
 * `model` defaults to `@preventive/ai`'s DEFAULT_MODEL, and `tally` is made when omitted.
 */
export declare function buildTable(options: Partial<PhaseOptions> & {
  task: Task;
  entries: Entry[];
  maxQuestions?: number | undefined;
  /** False keeps every entry distinct (default: `{}`) */
  dedupe?: DedupeOptions | false | undefined;
  concurrency?: number | undefined;
  onRow?: ((row: Row, done: number, total: number) => void) | undefined;
}): Promise<{ task: Task; focus: string; questions: Question[]; rows: Row[]; tally: Tally }>;

/** What the gate decided for a request */
export interface Routing {
  /** Short-answer columns worth a cheap pass over the dataset */
  extraQuestions: Question[];
  /** Whether the match needs the full entries read */
  fullScan: boolean;
  /** Why, in one sentence */
  reason: string;
}

/**
 * Whether a request needs what the table does not carry
 *
 * @returns The routing, with at most `maxExtra` (default: 4) extra questions
 */
export declare function gate(options: PhaseOptions & {
  task: Task;
  focus: string;
  questions: Question[];
  request: Entry;
  maxExtra?: number | undefined;
}): Promise<Routing>;

/** A row as a search stage ranks it */
export interface Candidate {
  row: Row;
  /** The stage's rounds that picked it */
  votes: number;
  /** The mean of the scores it was picked at */
  score: number;
}

/** How a search pages and votes */
export interface SearchOptions {
  /** Rows per page (default: 200) */
  pageSize?: number | undefined;
  /** Characters per page in full mode (default: 80000) */
  pageChars?: number | undefined;
  /** The most picks on a page, as a fraction of it (default: 0.2) */
  pick?: number | undefined;
  /** Shuffles per stage (default: 3) */
  rounds?: number | undefined;
  /** Picks a row needs to survive a stage, never more than `rounds` (default: a majority of them) */
  minVotes?: number | undefined;
  /** Put the request ahead of the page as the shared prompt-cache prefix (default: from the second stage) */
  requestFirst?: boolean | undefined;
  concurrency?: number | undefined;
}

/**
 * One stage: `rounds` shuffles of `rows` seeded by `seed` (default: 0), paged, every page asked once
 *
 * `mode: 'full'` pages the entries rather than the summaries. Where fewer rows reach the vote threshold
 * than `fill`, the best of the rest picked at all follow them, up to it.
 *
 * @returns The rows with enough votes, best first, and how many pages were asked
 */
export declare function search(options: PhaseOptions & SearchOptions & {
  task: Task;
  request: Entry;
  rows: Row[];
  /** The answers each row carries, in order */
  columns?: Question[] | undefined;
  mode?: 'summary' | 'full' | undefined;
  fill?: number | undefined;
  seed?: number | undefined;
  label?: string | undefined;
}): Promise<{ survivors: Candidate[]; pages: number }>;

/** One stage's numbers */
export interface Stage {
  stage: number;
  /** Rows it started from */
  rows: number;
  survivors: number;
  /** Pages it asked */
  pages: number;
}

/**
 * Stages of `search` until at most `target` rows are left, `maxStages` (default: 6) have run, or one
 * stopped shrinking the set
 *
 * Shuffles are seeded from the task and each stage's rows, never the request, so every request sees the
 * same first-stage pages. No stage cuts below `target` while rows that were picked at all remain.
 */
export declare function narrow(options: PhaseOptions & SearchOptions & {
  task: Task;
  request: Entry;
  rows: Row[];
  columns?: Question[] | undefined;
  mode?: 'summary' | 'full' | undefined;
  target: number;
  maxStages?: number | undefined;
  label?: string | undefined;
}): Promise<{ candidates: Candidate[]; stages: Stage[] }>;

/** A finalist as the full-text stage scores it */
export interface Result {
  id: string;
  /** 0 to 100, on an absolute scale */
  score: number;
  /** The evidence, in a sentence */
  reason: string;
  /** The span quoted for it */
  evidence: string;
  /** Whether `evidence` is in the entry word for word */
  grounded: boolean;
  /** Those it reached the stage with */
  votes: number;
  summary: string;
  /** The ids of the copies it stands for */
  duplicates: string[];
  /** Set by `rerank`: the mean position over its rounds, 1 for first in every one */
  listRank?: number | undefined;
}

/**
 * Phase 5: every candidate in full against the request in full
 *
 * @returns The results best first: by score, a grounded reading ahead of an ungrounded one, then votes
 */
export declare function score(options: PhaseOptions & {
  task: Task;
  request: Entry;
  candidates: Candidate[];
  concurrency?: number | undefined;
}): Promise<Result[]>;

/** The listwise pass over the top of the ranking */
export interface RerankOptions {
  /** How many of the top results are ordered (default: 20) */
  window?: number | undefined;
  /** Shuffles of them ordered, ranked by mean position (default: 3) */
  rounds?: number | undefined;
  concurrency?: number | undefined;
}

/**
 * Phase 5b: the window of `results` ordered listwise, with the entries read from `rows` by id
 *
 * Fewer than two in the window, or no rounds, leaves the order as it was.
 *
 * @returns The results, the window ordered and the rest unchanged after it, and how many were ordered
 */
export declare function rerank(options: PhaseOptions & RerankOptions & {
  task: Task;
  request: Entry;
  results: Result[];
  rows: Row[];
}): Promise<{ results: Result[]; reranked: number }>;

/** The models a run uses */
export interface Models {
  /** The schema, the gate and the finalists (default: `@preventive/ai`'s DEFAULT_MODEL) */
  strong?: string | undefined;
  /** The pages (default: `strong`) */
  search?: string | undefined;
  /** Whatever the gate sends over the whole dataset again (default: `search`) */
  cheap?: string | undefined;
}

/**
 * The pipeline for one request against one table
 *
 * Copies are skipped, and the row they copy carries their ids in its result.
 */
export declare function select(options: {
  task: Task;
  focus: string;
  questions: Question[];
  rows: Row[];
  request: Entry;
  models?: Models | undefined;
  /** Cut the results (default: all of them) */
  topK?: number | undefined;
  /** The fraction of rows that reach the full-text stage (default: 0.01) */
  final?: number | undefined;
  /** Never fewer than this reach it (default: 20) */
  minFinal?: number | undefined;
  /** False skips the gate and runs the summary search alone (default: true) */
  useGate?: boolean | undefined;
  search?: SearchOptions | undefined;
  /** False keeps the pointwise order */
  rerank?: RerankOptions | false | undefined;
  concurrency?: number | undefined;
  think?: boolean | undefined;
  effort?: string | undefined;
  tally?: Tally | undefined;
  ask?: Ask | undefined;
}): Promise<{ results: Result[]; reranked: number; gate: Routing; stages: Stage[]; fullStages: Stage[]; tally: Tally }>;

/** A request whose matches are known */
export interface Case {
  request: Entry;
  /** The ids of the entries that match it */
  relevant: string[];
}

/** One case measured, with the routing and stages its `select` took */
export interface Run {
  id: string;
  /** `hits` over the relevant */
  recall: number;
  /** Results at the cut that are relevant, or stand for a relevant copy, over the results returned */
  precision: number;
  /** One over the position of the first relevant result, or 0 */
  reciprocalRank: number;
  returned: number;
  /** Relevant ids among the results at the cut */
  hits: string[];
  /** Relevant ids that reached the finalists but were scored under the cut */
  belowCut: string[];
  /** Relevant ids no stage carried to the finalists */
  dropped: string[];
  gate: Routing;
  stages: Stage[];
  fullStages: Stage[];
  reranked: number;
}

/**
 * `select` over every case, one after another, measured at `topK` (default: every finalist)
 *
 * `onCase` sees each run as it lands.
 *
 * @returns The runs, the means over them (`mrr` the mean reciprocal rank), and the one tally
 */
export declare function evaluate(options: Omit<Parameters<typeof select>[0], 'request'> & {
  cases: Case[];
  onCase?: ((run: Run) => void) | undefined;
}): Promise<{ runs: Run[]; recall: number; precision: number; mrr: number; tally: Tally }>;
