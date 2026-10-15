// The public surface of grid: a compacted table over a large dataset for one fixed task, and the
// search that selects, for one request, the entries of that dataset which best match it. Built on
// @preventive/ai, whose ask() issues every model call and whose disk cache makes a run resumable
// and a re-run free; the cache directory is set through that package (setCacheDir) before anything
// here is called.
//
// The shape of a run:
//   buildTable  once per task and dataset -- the questions proposed for the task, then every
//               entry compacted to a summary and short answers (proposeQuestions and compact
//               are its two halves, for a caller that persists between them);
//   select      once per request -- the gate (does this request need what the table does not
//               carry?), the paged and interlaced search narrowing the table in stages, and the
//               full-text scoring of the finalists. gate, search, narrow and score are its
//               stages, for a caller composing its own.
//
// Everything in src/ beyond these names is internal and free to move.

export { buildTable } from './src/table.js'
export { proposeQuestions, gate } from './src/schema.js'
export { compact } from './src/compact.js'
export { search, narrow } from './src/search.js'
export { score } from './src/score.js'
export { select } from './src/select.js'
export { newTally } from './src/call.js'
