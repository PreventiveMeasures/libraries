import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { resolveTaskBudget } from '../src/task-budget.js'
import { isMaxTokensTruncation } from '../src/providers.js'

describe('isMaxTokensTruncation — what gates the error-mode retry', () => {
  it('matches every adapter\'s truncation error, whatever cap field it names', () => {
    // The retry fires on the shape, not one wording, so an adapter can
    // rename its cap field without silently disabling the fallback.
    assert.ok(isMaxTokensTruncation('Response truncated: hit max_tokens limit'))
    assert.ok(isMaxTokensTruncation('Response truncated: hit max_completion_tokens limit'))
    assert.ok(isMaxTokensTruncation('Response truncated: hit max_output_tokens limit'))
  })

  it('does not match other errors, or a missing one', () => {
    assert.equal(isMaxTokensTruncation('API error: overloaded'), false)
    assert.equal(isMaxTokensTruncation(null), false)
    assert.equal(isMaxTokensTruncation(undefined), false)
  })
})

describe('resolveTaskBudget', () => {
  it('mode=never: both flags off for every model', () => {
    assert.deepEqual(resolveTaskBudget('anthropic/claude-opus-4.7', 'never'), { always: false, onError: false })
    assert.deepEqual(resolveTaskBudget('anthropic/claude-sonnet-4.6', 'never'), { always: false, onError: false })
    assert.deepEqual(resolveTaskBudget('openai/gpt-5.5', 'never'), { always: false, onError: false })
  })

  it('mode=always with opus 4.7: always=true, onError=false', () => {
    assert.deepEqual(resolveTaskBudget('anthropic/claude-opus-4.7', 'always'), { always: true, onError: false })
  })

  it('mode=error with opus 4.7: always=false, onError=true', () => {
    assert.deepEqual(resolveTaskBudget('anthropic/claude-opus-4.7', 'error'), { always: false, onError: true })
  })

  it('mode=always / error against an unsupported model: both flags drop to false (no 400 on mixed-model runs)', () => {
    // The CLI gate already blocks the main model from accepting `always`
    // / `error` on an unsupported model, but secondary passes (validate,
    // dedupe, …) can use a different model. Drop the flags so those
    // passes silently no-op instead of failing.
    assert.deepEqual(resolveTaskBudget('anthropic/claude-sonnet-4.6', 'always'), { always: false, onError: false })
    assert.deepEqual(resolveTaskBudget('anthropic/claude-opus-4.6', 'error'), { always: false, onError: false })
    assert.deepEqual(resolveTaskBudget('openai/gpt-5.5', 'always'), { always: false, onError: false })
  })

  it('unknown mode strings collapse to both flags false', () => {
    // Defensive — index.js already validates the CLI mode against
    // TASK_BUDGET_MODES, but resolveTaskBudget shouldn't silently treat
    // a typo as "always".
    assert.deepEqual(resolveTaskBudget('anthropic/claude-opus-4.7', 'sometimes'), { always: false, onError: false })
    assert.deepEqual(resolveTaskBudget('anthropic/claude-opus-4.7', undefined), { always: false, onError: false })
  })
})
