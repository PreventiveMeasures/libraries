import { canTaskBudget } from './models.js'
import { buildRequestBody, checkResponse, isMaxTokensTruncation, sendRequest } from './providers.js'

// Resolve the user-facing --task-budget mode into the two flags
// issueTurn consumes: `always` is what every request goes out with;
// `onError` gates the per-turn fallback retry when an attempt comes
// back truncated. Both drop to false for models that can't accept the
// beta — letting a global --task-budget=... cover a mixed-model run
// without 400ing unsupported passes (validate / dedupe / etc. no-op).
export function resolveTaskBudget(model, mode) {
  const supported = canTaskBudget(model)
  return {
    always: mode === 'always' && supported,
    onError: mode === 'error' && supported,
  }
}

// Issue one turn's API request, applying the task-budget=error
// fallback when relevant. Returns `{ request, response, error,
// failedAttemptResponse }` — `failedAttemptResponse` is non-null when
// the retry path fired, so the caller can still account for the
// failed attempt's usage in its running totals.
export async function issueTurn({ model, maxTokens, systemPrompt, messages, think, effort, tools, label, turn, taskBudgetAlways, taskBudgetOnError, debug }) {
  const send = async (useTaskBudget, suffix) => {
    const req = buildRequestBody(model, maxTokens, systemPrompt, messages, { think, effort, tools, taskBudget: useTaskBudget, turn })
    // Not fetchJSON directly: one provider serves its turns out of a browser
    // rather than over HTTP, and which it is belongs to the adapter.
    const res = await sendRequest(model, req, { taskBudget: useTaskBudget, debug, label: `${label} (turn ${turn}${suffix})` })
    return { request: req, response: res }
  }

  let { request, response } = await send(taskBudgetAlways, taskBudgetAlways ? ', task_budget' : '')
  let error = checkResponse(response)
  let failedAttemptResponse = null
  if (isMaxTokensTruncation(error) && taskBudgetOnError && !taskBudgetAlways) {
    if (debug) console.warn(`[debug] ${label} (turn ${turn}): truncated, retrying with task_budget`)
    failedAttemptResponse = response
    ;({ request, response } = await send(true, ', task_budget'))
    error = checkResponse(response)
  }
  return { request, response, error, failedAttemptResponse }
}
