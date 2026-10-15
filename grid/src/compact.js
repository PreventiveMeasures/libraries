import { call } from './call.js'
import { expectObject, extractJSON, stringList } from './json.js'
import { mapLimit } from './pool.js'
import { compactSystem, compactUser } from './prompts.js'

// Phase 1: the dataset into the table, one entry per call. The table row is the user's shape --
// the id, the task it was compacted for, the entry itself, the summary, the answers in question
// order -- and it keeps the entry because the last stage reads it and nothing else does.
//
// Every entry's call shares one system prompt, which holds the task and the questions, so the
// layer's prompt cache serves that part to all twenty thousand and the disk cache makes a second
// run of the same table free. Entries are not truncated here: an entry runs to a few pages, and a
// model that cannot take one fails on that call rather than compacting a prefix as if it were the
// whole.

// Exactly one answer per question, padded with "unknown" rather than refused when the model sent
// fewer: the row is still usable, and one short list in twenty thousand is not worth a re-ask.
// MORE answers than questions are cut, since nothing could say which question the extras belong to.
// No list at all is re-asked, though: that is not a short answer, it is the wrong shape.
function readRow(count, summarize) {
  return (text) => {
    const json = expectObject(extractJSON(text), summarize ? 'summary and answers' : 'answers')
    if (!Array.isArray(json.answers)) throw new TypeError('expected an answers list')
    const answers = stringList(json.answers).slice(0, count)
    while (answers.length < count) answers.push('unknown')
    const summary = summarize ? String(json.summary ?? '').trim() : ''
    if (summarize && !summary) throw new TypeError('expected a non-empty summary')
    return { summary, answers }
  }
}

// `entries` are `{ id, text }`; `questions` carry the ids the pages will name them by. `summarize`
// off is the supplement pass -- a request's extra questions over the whole dataset, by a cheaper
// model -- whose rows carry answers only. `onRow` (optional) is called as each row lands, in
// completion order, for a caller showing progress over a long run.
export async function compact({ task, focus, questions, entries, model, summarize = true, concurrency = 20, think, effort, tally, ask, onRow }) {
  const systemPrompt = compactSystem({ task, focus, questions, summarize })
  const parse = readRow(questions.length, summarize)
  let done = 0
  return await mapLimit(entries, concurrency, async (entry) => {
    const { summary, answers } = await call({
      type: 'grid.compact', model, systemPrompt, userContent: compactUser(entry), parse, think, effort, tally, ask,
      label: `compact ${entry.id}`,
    })
    const row = { id: entry.id, taskId: task.id, entry: entry.text, summary, answers }
    done += 1
    onRow?.(row, done, entries.length)
    return row
  })
}
