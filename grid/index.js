// The public surface of grid: a compacted table over a large dataset for one fixed task, and the
// search that selects, for one request, the entries of that dataset which best match it. Built on
// @preventive/ai, whose ask() issues every model call and whose disk cache makes a run resumable
// and a re-run free; the cache directory is set through that package (setCacheDir) before anything
// here is called.
//
// The shape of a run:
//   buildTable  once per task and dataset -- the questions proposed for the task, the copies
//               among the entries grouped, then every distinct entry compacted to a summary and
//               short answers (proposeQuestions, groupDuplicates and compact are its parts, for a
//               caller that persists between them);
//   select      once per request -- the gate (does this request need what the table does not
//               carry?), the paged and interlaced search narrowing the table in stages, the
//               full-text scoring of the finalists, and the listwise ordering of the top of them.
//               gate, search, narrow, score and rerank are its stages, for a caller composing its
//               own;
//   evaluate    select over requests whose matches are known, measured, for tuning the rest.
//
// Everything in src/ beyond these names is internal and free to move.

export { buildTable } from './src/table.js'
export { proposeQuestions, gate } from './src/schema.js'
export { groupDuplicates } from './src/dedupe.js'
export { compact } from './src/compact.js'
export { search, narrow } from './src/search.js'
export { score } from './src/score.js'
export { rerank } from './src/rerank.js'
export { select } from './src/select.js'
export { evaluate } from './src/evaluate.js'
export { newTally } from './src/call.js'
