import { DEFAULT_MODEL } from '@preventive/ai'
import { newTally } from './call.js'
import { compact } from './compact.js'
import { proposeQuestions } from './schema.js'

// The table for one task over one dataset, built once and read by every request after: the
// questions proposed for the task, then every entry compacted under them. What comes back is
// exactly what select() takes, and all of it is plain data a caller can write to disk and read
// back, though with the response cache in place a second build of the same table costs nothing.
export async function buildTable({ task, entries, model = DEFAULT_MODEL, maxQuestions, concurrency, think, effort, tally = newTally(), ask, onRow }) {
  const { focus, questions } = await proposeQuestions({ task, model, maxQuestions, think, effort, tally, ask })
  const rows = await compact({ task, focus, questions, entries, model, concurrency, think, effort, tally, ask, onRow })
  return { task, focus, questions, rows, tally }
}
