import { DEFAULT_MODEL } from '@preventive/ai'
import { newTally } from './call.js'
import { compact } from './compact.js'
import { groupDuplicates } from './dedupe.js'
import { proposeQuestions } from './schema.js'

// The table for one task over one dataset, all plain data: the questions proposed, the copies grouped,
// one entry of each group compacted. Every entry keeps a row in input order; a copy's carries its
// original's summary and answers and names it as `dupOf`, and the original lists its copies.
export async function buildTable({ task, entries, model = DEFAULT_MODEL, maxQuestions, dedupe = {}, concurrency, think, effort, tally = newTally(), ask, onRow }) {
  const { focus, questions } = await proposeQuestions({ task, model, maxQuestions, think, effort, tally, ask })
  const groups = dedupe === false ? new Map() : groupDuplicates(entries, dedupe)
  const dupOf = new Map(groups.entries().flatMap(([canonical, ids]) => ids.map((id) => [id, canonical])))
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
