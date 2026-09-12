import { canAdaptive, canTaskBudget, needsExplicitNoThink } from './models.js'
import { ANTHROPIC_SYSTEM_CACHE, anthropicInitialUserMessage, cachesConversation } from './prompt-cache.js'

// Wire formats the adapters are assembled from, kept out of providers.js so
// that file stays the provider registry and dispatch surface. The Anthropic
// Messages format lives here because two adapters build it — the direct one
// and a gateway routing an anthropic/* model — and the truncation contract
// lives here because every format reports it the same way.

// Truncation error shape shared by every adapter: same sentence, differing
// only in the output-cap field that adapter actually sent. task-budget.js
// gates its error-mode retry on the shape rather than one exact wording, so
// renaming an adapter's cap field can't silently disable that retry.
const TRUNCATION_PREFIX = 'Response truncated: hit '
export const truncationError = (maxTokensField) => `${TRUNCATION_PREFIX}${maxTokensField} limit`
export const isMaxTokensTruncation = (error) => typeof error === 'string' && error.startsWith(TRUNCATION_PREFIX)
// `anthropic-beta` value gating the `output_config.task_budget` body
// field. Centralised so the body builder and the extra-headers method
// can't drift.
const TASK_BUDGET_BETA = 'task-budgets-2026-03-13'
export function stripNamespace(model, prefix) {
  return model.startsWith(prefix) ? model.slice(prefix.length) : model
}

// Anthropic uses hyphens in version numbers: claude-opus-4.6 -> claude-opus-4-6
export function toAnthropicModel(model) {
  return stripNamespace(model, 'anthropic/').replaceAll(/(\d+)\.(\d+)/gu, '$1-$2')
}
// The Anthropic Messages wire format — body, headers and parsing — shared by
// the direct adapter and by a gateway routing an anthropic/* model. Only the
// endpoint differs between them, so nothing here may assume api.anthropic.com.
export const anthropicAuthHeader = (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' })

// `modelId` maps the registry id onto whatever the endpoint expects.
// api.anthropic.com takes the bare hyphenated name; a gateway matches on the
// namespaced id the operator configured, so it passes the id through.
export function anthropicShape(modelId) {
  return {
    buildRequestBody(model, maxTokens, systemPrompt, messages, { think = false, effort, tools, taskBudget = false, turn = 0 } = {}) {
      // System prompt: 1-hour TTL (stable across the run, worth the 2.0x write premium).
      const systemContent = [{ type: 'text', text: systemPrompt, cache_control: ANTHROPIC_SYSTEM_CACHE }]
      const body = { model: modelId(model), max_tokens: maxTokens, system: systemContent, messages: [...messages] }
      if (tools) body.tools = tools
      // The conversation tail, at the default 5-minute TTL. One rule for both
      // routes that reach this code — direct and gateway — so the same model
      // caches the same way whichever way it is reached.
      if (cachesConversation({ turn })) body.cache_control = { type: 'ephemeral' }
      if (think) {
        if (canAdaptive(model) && effort !== 'manual') {
          body.thinking = { type: 'adaptive' }
          if (effort) body.output_config = { effort }
        } else {
          body.thinking = { type: 'enabled', budget_tokens: Math.floor(maxTokens * 0.75) }
          if (effort && effort !== 'manual') throw new Error('Model does not support effort')
        }
      } else if (effort) {
        throw new Error('Thinking not enabled')
      } else if (needsExplicitNoThink(model)) {
        // Safe to send with no effort set: the disabled form 400s only at
        // xhigh / max, and this branch is reached only when `effort` is unset.
        body.thinking = { type: 'disabled' }
      }
      // task-budgets-2026-03-13 beta, gated by canTaskBudget. `output_config` may
      // already carry an `effort` from the adaptive-thinking branch above;
      // merge so both can coexist (the docs example sets them together).
      // The matching `anthropic-beta` header is added separately by
      // extraHeaders so callers that only build the body (tests) don't
      // need to touch headers.
      if (taskBudget) {
        if (!canTaskBudget(model)) throw new Error(`Model ${model} does not support task_budget`)
        body.output_config = { ...body.output_config, task_budget: { type: 'tokens', total: maxTokens } }
      }
      return body
    },

    extraHeaders({ taskBudget = false } = {}) {
      if (!taskBudget) return null
      return { 'anthropic-beta': TASK_BUDGET_BETA }
    },

    checkResponse(json) {
      if (json.type === 'error') return `API error: ${json.error?.message ?? 'unknown'}`
      if (json.stop_reason === 'max_tokens') return truncationError('max_tokens')
      return null
    },

    extractResponseText(json) {
      return (json.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('')
    },

    extractToolCalls(json) {
      return (json.content ?? [])
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({ id: b.id, name: b.name, args: b.input }))
    },

    appendToolResults(messages, json, toolCalls, results) {
      messages.push({ role: 'assistant', content: json.content }, {
        role: 'user',
        content: toolCalls.map((tc, i) => ({ type: 'tool_result', tool_use_id: tc.id, content: results[i] })),
      })
    },

    // When a suffix is present, send the prefix as a separately-cached
    // text block so multiple variants that share it read a single cache
    // entry for everything before the per-request tail. Same rule the
    // gateway route applies — see prompt-cache.js.
    buildInitialUserMessage(model, userContent, userContentSuffix) {
      return anthropicInitialUserMessage(model, userContent, userContentSuffix)
    },

  }
}

