import { call } from './call.js'
import { expectObject, extractJSON, textOf } from './json.js'
import { mapLimit } from './pool.js'
import { compactSystem, compactUser } from './prompts.js'

// Phase 1: one call per entry, all sharing the system prompt that holds the task and the questions. An
// entry is never truncated: one a model cannot take fails, rather than a prefix compacted as the whole.

// The i-th answer is the i-th question's, a blank one "unknown"; a short list pads and a long one is cut,
// as nothing could say whose the extras are. No list at all is the wrong shape, and re-asked.
const answerAt = (value) => textOf(value) || 'unknown'

function readRow(count, summarize) {
  return (text) => {
    const json = expectObject(extractJSON(text), summarize ? 'summary and answers' : 'answers')
    if (!Array.isArray(json.answers)) throw new TypeError('expected an answers list')
    const answers = Array.from({ length: count }, (_, i) => answerAt(json.answers[i]))
    // A string or a re-ask: String() would make text of `true` or an object
    const summary = summarize ? textOf(json.summary) : ''
    if (summarize && !summary) throw new TypeError('expected a non-empty summary')
    return { summary, answers }
  }
}

// `summarize` off is a request's supplement pass, with answers alone; `onRow` sees each row as it lands
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
