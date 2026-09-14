import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ask, isResumableHistory } from '../src/chat.js'

describe('isResumableHistory', () => {
  // A completed tool round, which is what every entry but the last has to be.
  const round = { toolCalls: [{ id: 't1', name: 'probe', args: {} }], toolResults: ['probed'] }

  it('accepts a well-formed history: a seed on entry 0, a response on each, rounds in between', () => {
    // Entry 1 carries no snapshot, which is how serializeHistory stores it — the replay rebuilds
    // from entry 0's plus the rounds, so only that one has to be there.
    const ok = [
      { request: {}, response: { content: [] }, messages: [{ role: 'user', content: 'hi' }], ...round },
      { request: {}, response: { content: [] }, messages: null, toolCalls: [], toolResults: [] },
    ]
    assert.equal(isResumableHistory(ok), true)
  })

  it('rejects an entry before the last that called no tool', () => {
    // The loop returns at the first turn that calls nothing, so a history cannot really hold one
    // in the middle — and the replay would push an assistant turn answered by an empty result.
    const bad = [
      { request: {}, response: { content: [] }, messages: [{ role: 'user', content: 'hi' }], toolCalls: [], toolResults: [] },
      { request: {}, response: { content: [] }, messages: null, toolCalls: [], toolResults: [] },
    ]
    assert.equal(isResumableHistory(bad), false)
  })

  it('rejects an entry before the last whose calls were not all answered', () => {
    const bad = [
      { request: {}, response: { content: [] }, messages: [{ role: 'user', content: 'hi' }], toolCalls: round.toolCalls, toolResults: [] },
      { request: {}, response: { content: [] }, messages: null, toolCalls: [], toolResults: [] },
    ]
    assert.equal(isResumableHistory(bad), false)
  })

  it('rejects an empty history', () => {
    assert.equal(isResumableHistory([]), false)
  })

  it('rejects when the value is not an array', () => {
    assert.equal(isResumableHistory(null), false)
    assert.equal(isResumableHistory({}), false)
    assert.equal(isResumableHistory('history'), false)
  })

  it('rejects when any entry is missing `response`', () => {
    const bad = [
      { request: {}, response: { content: [] }, messages: [], ...round },
      { request: {}, messages: [], toolCalls: [], toolResults: [] }, // no response
    ]
    assert.equal(isResumableHistory(bad), false)
  })

  it('rejects when entry 0 carries no `messages` seed', () => {
    // Later entries have none by design; the first one is what the replay starts from.
    assert.equal(isResumableHistory([{ request: {}, response: {}, messages: 'not-an-array' }]), false)
    assert.equal(isResumableHistory([{ request: {}, response: {}, messages: null }]), false)
  })

  it('rejects an empty seed on entry 0', () => {
    // It is the only record of how the conversation opened now — the later snapshots that used to
    // carry a copy of it are gone — so an empty one replays a request with no question in it,
    // which Anthropic refuses and a chat-completions route bills for.
    assert.equal(isResumableHistory([{ request: {}, response: {}, messages: [], ...round }]), false)
  })

  it('accepts an entry that still calls its results `results`', () => {
    // Written before the rename, and still resumable.
    const legacy = [
      { request: {}, response: {}, messages: [{ role: 'user' }], toolCalls: round.toolCalls, results: ['probed'] },
      { request: {}, response: {}, messages: null, toolCalls: [], results: [] },
    ]
    assert.equal(isResumableHistory(legacy), true)
  })

  it('rejects null / non-object entries (legacy or corrupted partials)', () => {
    assert.equal(isResumableHistory([null]), false)
    assert.equal(isResumableHistory([{ request: {}, response: {}, messages: [] }, undefined]), false)
    assert.equal(isResumableHistory([42]), false)
  })

  it('accepts a tail entry with no tool calls (terminal turn)', () => {
    // A run that finished cleanly but lost the .md write would land
    // here — partial has the final turn cached, no tool calls. Resume
    // is supposed to short-circuit on this shape.
    const ok = [{ request: {}, response: { content: [{ type: 'text', text: 'done' }] }, messages: [{ role: 'user', content: 'hi' }], toolCalls: [], results: [] }]
    assert.equal(isResumableHistory(ok), true)
  })

  it('accepts a tail entry where results.length matches toolCalls.length', () => {
    const ok = [{
      request: {}, response: {}, messages: [{ role: 'user' }],
      toolCalls: [{ id: 't1', name: 'terminal', args: { command: 'ls' } }],
      results: [JSON.stringify({ stdout: '', stderr: '', exitCode: 0, cwd: '/' })],
    }]
    assert.equal(isResumableHistory(ok), true)
  })

  it('rejects a tail entry with toolCalls but no results (errored mid-run)', () => {
    // Original chat persisted this shape on a malformed-args
    // tool call before bailing. Replaying it would feed an
    // appendToolResults with results=[], producing tool_results with
    // undefined content — better to clear the partial and start over.
    const bad = [{
      request: {}, response: {}, messages: [{ role: 'user' }],
      toolCalls: [{ id: 't1', name: 'terminal', args: {} }],
      results: [],
    }]
    assert.equal(isResumableHistory(bad), false)
  })

  it('rejects a tail entry flagged with `error` (provider failure / truncation)', () => {
    // chat stamps `error` on entries persisted because of a
    // checkResponse failure or a malformed tool-args turn. Without
    // this guard, resume would either re-surface the same failure or
    // (for the toolCalls=[] short-circuit) silently return empty text
    // and mask the error.
    const errored = [{
      request: {}, response: {}, messages: [{ role: 'user' }],
      toolCalls: [], results: [], error: 'API error: rate limited',
    }]
    assert.equal(isResumableHistory(errored), false)
  })

  it('rejects when the provider option is set and entries are stamped with a different provider', () => {
    // Cross-provider replay would feed adapter-shaped `messages` to a
    // mismatched provider (e.g. Anthropic tool_use blocks fed to an
    // OpenAI request).
    const ok = [{ request: {}, response: {}, messages: [{ role: 'user' }], toolCalls: [], results: [], provider: 'anthropic' }]
    assert.equal(isResumableHistory(ok, { provider: 'anthropic' }), true)
    assert.equal(isResumableHistory(ok, { provider: 'openrouter' }), false)
  })

  it('rejects legacy partials with no provider stamp when provider is required', () => {
    // Pre-PR partials predate the stamp; safer to clear and re-run
    // than to risk shape mismatch.
    const legacy = [{ request: {}, response: {}, messages: [{ role: 'user' }], toolCalls: [], results: [] }]
    assert.equal(isResumableHistory(legacy, { provider: 'anthropic' }), false)
    // But with no expected provider supplied, shape alone is enough.
    assert.equal(isResumableHistory(legacy), true)
  })
})

describe('ask: options that no longer exist', () => {
  it('refuses userContentSuffix rather than silently dropping the tail', async () => {
    await assert.rejects(
      () => ask({ model: 'anthropic/claude-opus-4.5', maxTokens: 10, systemPrompt: 's', userContent: 'u', userContentSuffix: 'tail' }),
      /userContentSuffix is gone/u,
    )
  })
})
