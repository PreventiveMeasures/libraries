import { DEFAULT_MODEL } from '@preventive/ai'
import { newTally } from './call.js'
import { compact } from './compact.js'
import { groupDuplicates } from './dedupe.js'
import { proposeQuestions } from './schema.js'

// The table for one task over one dataset, built once and read by every request after: the
// questions proposed for the task, the copies among the entries grouped, then one entry of each
// group compacted under the questions. What comes back is exactly what select() takes, and all of
// it is plain data a caller can write to disk and read back, though with the response cache in
// place a second build of the same table costs nothing.
//
// Every entry keeps a row, in input order. A copy's row carries the summary and answers of the
// entry it copies and names it as `dupOf`; the entry copied carries the copies' ids as
// `duplicates`. select() searches the rows that are not copies and returns a result per row, with
// the ids it stands for; a caller reading the table by id finds every entry. `dedupe` false skips
// the grouping, and an object sets its thresholds (see groupDuplicates).
export async function buildTable({ task, entries, model = DEFAULT_MODEL, maxQuestions, dedupe = {}, concurrency, think, effort, tally = newTally(), ask, onRow }) {
  const { focus, questions } = await proposeQuestions({ task, model, maxQuestions, think, effort, tally, ask })
  const groups = dedupe === false ? new Map() : groupDuplicates(entries, dedupe)
  const dupOf = new Map()
  for (const [canonical, ids] of groups) {
    for (const id of ids) dupOf.set(id, canonical)
  }
  const distinct = entries.filter((entry) => !dupOf.has(entry.id))
  const compacted = await compact({ task, focus, questions, entries: distinct, model, concurrency, think, effort, tally, ask, onRow })
  const byId = new Map(compacted.map((row) => [row.id, row]))
  const rows = entries.map((entry) => {
    const canonical = dupOf.get(entry.id)
    if (canonical === undefined) {
      const row = byId.get(entry.id)
      const ids = groups.get(entry.id)
      return ids ? { ...row, duplicates: ids } : row
    }
    const { summary, answers } = byId.get(canonical)
    return { id: entry.id, taskId: task.id, entry: entry.text, summary, answers, dupOf: canonical }
  })
  return { task, focus, questions, rows, tally }
}
