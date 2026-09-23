import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import * as ai from '../index.js'

import { DEFAULT_MODEL, EFFORT_LEVELS, KNOWN_MODELS, TASK_BUDGET_MODELS, TASK_BUDGET_MODES, calculateCost, canAdaptive, canDisableThink, canEffort, canTaskBudget, canThink, effortsFor, emptyUsage, getMaxTokens, isRecognizedModel, needsExplicitNoThink, normalizeThinkEffort, ollamaModels, ollamaTagFor, readsCacheBreakpoint, reasoningModeFor, resolveModel, resolveThinkEffort, unknownModelMessage, validateModel, wireModelFor } from '../src/models.js'

// What the named usage legs cost per Mtok at a model's BASE rate. A
// million-token prompt is past the 272K long-context line on every OpenAI
// row that has one, so the rate is read off a quarter-million tokens a leg
// and scaled up — by a power of two, which keeps it bit-exact against the
// published figure. Keep the prompt legs named together under the line.
function baseRate(model, ...legs) {
  const usage = emptyUsage()
  for (const leg of legs) usage[leg] = 250_000
  return calculateCost(model, usage) * 4
}

describe('canThink / canEffort', () => {
  it('canThink: false on a model without a thinking capability', () => {
    assert.equal(canThink('anthropic/claude-3-haiku'), false)
  })

  it('canThink: true on a model marked canThink: true', () => {
    assert.equal(canThink('anthropic/claude-sonnet-4.5'), true)
  })

  it('canThink: true on an adaptive-thinking model', () => {
    assert.equal(canThink('anthropic/claude-opus-4.7'), true)
    assert.equal(canThink('anthropic/claude-fable-5'), true)
  })

  it('canEffort: false for non-adaptive Anthropic — that branch takes a fixed budget_tokens', () => {
    assert.equal(canEffort('anthropic/claude-sonnet-4.5'), false)
  })

  it('canEffort: true for adaptive Anthropic', () => {
    assert.equal(canEffort('anthropic/claude-opus-4.7'), true)
    assert.equal(canEffort('anthropic/claude-fable-5'), true)
  })

  it('canEffort: true for non-Anthropic thinking models (OpenAI, Google, …)', () => {
    assert.equal(canEffort('openai/gpt-5.5'), true)
  })

  it('canEffort: false on any model without a thinking capability', () => {
    assert.equal(canEffort('anthropic/claude-3-haiku'), false)
    assert.equal(canEffort('openai/gpt-4o-mini'), false)
  })
})

describe('canEffort on the package entry', () => {
  it('is re-exported from index.js, the one door into the layer', () => {
    assert.equal(ai.canEffort, canEffort)
  })

  it('answers for an id of any type, as the `unknown` in its declared type says', () => {
    assert.equal(ai.canEffort(undefined), false)
    assert.equal(ai.canEffort(123), false)
  })
})

describe('normalizeThinkEffort', () => {
  it('think=false on any model: no think, no effort', () => {
    assert.deepEqual(normalizeThinkEffort('anthropic/claude-opus-4.7', false), { useThink: false, useEffort: undefined })
    assert.deepEqual(normalizeThinkEffort('openai/gpt-5.5', false, 'high'), { useThink: false, useEffort: undefined })
  })

  it('think=true on a non-thinking model: silently downgrades to think=false', () => {
    // Callers like ai.js layer their own assertion on top
    // (`useThink !== Boolean(think) ? throw`); this helper just resolves
    // the values that will actually hit the wire.
    assert.deepEqual(normalizeThinkEffort('anthropic/claude-3-haiku', true), { useThink: false, useEffort: undefined })
  })

  it('think=true on non-adaptive Anthropic: think=true, effort=undefined (no effort knob)', () => {
    assert.deepEqual(normalizeThinkEffort('anthropic/claude-sonnet-4.5', true, 'high'), { useThink: true, useEffort: undefined })
  })

  it('think=true on adaptive Anthropic: think=true, effort defaults to "high"', () => {
    assert.deepEqual(normalizeThinkEffort('anthropic/claude-opus-4.7', true), { useThink: true, useEffort: 'high' })
  })

  it('think=true on adaptive Anthropic with explicit effort: passthrough', () => {
    assert.deepEqual(normalizeThinkEffort('anthropic/claude-opus-4.7', true, 'low'), { useThink: true, useEffort: 'low' })
  })

  it('think=true on a non-Anthropic thinking model: think=true, effort defaults to "high"', () => {
    assert.deepEqual(normalizeThinkEffort('openai/gpt-5.5', true), { useThink: true, useEffort: 'high' })
  })

  it('truthy non-boolean `think` is coerced to true', () => {
    // CLI flags arrive as booleans, but be defensive.
    assert.deepEqual(normalizeThinkEffort('openai/gpt-5.5', 1), { useThink: true, useEffort: 'high' })
    assert.deepEqual(normalizeThinkEffort('openai/gpt-5.5', 'yes'), { useThink: true, useEffort: 'high' })
  })

  it('falsy `think` (undefined / null / 0) is treated as false', () => {
    assert.deepEqual(normalizeThinkEffort('openai/gpt-5.5'), { useThink: false, useEffort: undefined })
    assert.deepEqual(normalizeThinkEffort('openai/gpt-5.5', null), { useThink: false, useEffort: undefined })
    assert.deepEqual(normalizeThinkEffort('openai/gpt-5.5', 0), { useThink: false, useEffort: undefined })
  })
})

describe('isRecognizedModel', () => {
  it('true for every row the price table carries', () => {
    for (const model of KNOWN_MODELS) assert.equal(isRecognizedModel(model), true, model)
  })

  it('resolves aliases first, so a bare alias is recognized too', () => {
    // Neither alias is a row of its own, so an unresolved lookup would miss.
    assert.equal(KNOWN_MODELS.includes('kimi-k3'), false)
    assert.equal(isRecognizedModel('kimi-k3'), true)
    assert.equal(isRecognizedModel('openai/gpt-5.6'), true)
  })

  it('false for an id the registry does not carry, junk included', () => {
    assert.equal(isRecognizedModel('foo/bar'), false)
    // A near-miss on a real id — the case the explicit message exists for.
    assert.equal(isRecognizedModel('anthropic/claude-opus5'), false)
    assert.equal(isRecognizedModel(undefined), false)
    assert.equal(isRecognizedModel(123), false)
  })

  it('recognizes a blocked id, leaving validateModel to turn it away by name', () => {
    // Wider than KNOWN_MODELS here: a blocked id has no row, but it is not a
    // typo, and reporting it as unrecognized would bury the message that
    // actually helps.
    assert.equal(KNOWN_MODELS.includes('anthropic/claude-opus-4'), false)
    assert.equal(isRecognizedModel('anthropic/claude-opus-4'), true)
    assert.throws(() => validateModel('anthropic/claude-opus-4'), /is not supported\. Use claude-opus-4\.5 or newer/u)
  })
})

describe('resolveThinkEffort', () => {
  it('returns what normalizeThinkEffort resolved when the model can honour it', () => {
    for (const args of [['anthropic/claude-opus-4.7', true, 'low'], ['openai/gpt-5.5', true, undefined], ['openai/gpt-4o-mini', false, undefined]]) {
      assert.deepEqual(resolveThinkEffort(...args), normalizeThinkEffort(...args), args.join(' '))
    }
  })

  it('names the model as unknown when there is no row for it', () => {
    // An id with no row drops think and effort exactly as a registered
    // non-reasoning model does, so without this branch a typo comes back
    // as a sentence about the model's capabilities.
    assert.throws(() => resolveThinkEffort('foo/bar', false, 'high'), /^Error: Unknown model foo\/bar — .* --effort cannot be applied/u)
    assert.throws(() => resolveThinkEffort('foo/bar', true), /^Error: Unknown model foo\/bar — .* --think cannot be applied/u)
  })

  it('keeps the capability wording for a model that is known but cannot do it', () => {
    // gpt-4o-mini has a row and no thinking; sonnet-4.5 thinks on a fixed
    // budget and has no effort knob. Neither is an unknown-model case.
    assert.throws(() => resolveThinkEffort('openai/gpt-4o-mini', true), /^Error: --think is not supported by model$/u)
    assert.throws(() => resolveThinkEffort('openai/gpt-4o-mini', false, 'high'), /^Error: --effort is not supported by model or --think is not enabled$/u)
    assert.throws(() => resolveThinkEffort('anthropic/claude-sonnet-4.5', true, 'high'), /^Error: --effort is not supported by model or --think is not enabled$/u)
  })

  it('lets an unknown model through when nothing was asked of it', () => {
    // Unregistered ids still route through OpenRouter / a gateway; only a
    // think or effort request they cannot carry is an error.
    assert.deepEqual(resolveThinkEffort('foo/bar', false), { useThink: false, useEffort: undefined })
    assert.deepEqual(resolveThinkEffort('foo/bar'), { useThink: false, useEffort: undefined })
  })

  it('names the flag that was refused, and where the id would be added', () => {
    assert.match(unknownModelMessage('foo/bar', '--effort high'), /Unknown model foo\/bar/u)
    assert.match(unknownModelMessage('foo/bar', '--effort high'), /--effort high cannot be applied/u)
    assert.match(unknownModelMessage('foo/bar', '--effort high'), /MODELS in `ai\/`/u)
  })
})

describe('canTaskBudget', () => {
  it('true for the models on the task-budgets-2026-03-13 beta', () => {
    assert.equal(canTaskBudget('anthropic/claude-fable-5.1'), true)
    assert.equal(canTaskBudget('anthropic/claude-fable-5'), true)
    assert.equal(canTaskBudget('anthropic/claude-opus-5'), true)
    assert.equal(canTaskBudget('anthropic/claude-sonnet-5'), true)
    assert.equal(canTaskBudget('anthropic/claude-opus-4.7'), true)
    assert.equal(canTaskBudget('anthropic/claude-opus-4.8'), true)
  })

  it('false for every other Anthropic model', () => {
    assert.equal(canTaskBudget('anthropic/claude-opus-4.6'), false)
    assert.equal(canTaskBudget('anthropic/claude-opus-4.5'), false)
    assert.equal(canTaskBudget('anthropic/claude-sonnet-4.6'), false)
    assert.equal(canTaskBudget('anthropic/claude-haiku-4.5'), false)
  })

  it('false for non-Anthropic models', () => {
    assert.equal(canTaskBudget('openai/gpt-5.5'), false)
    assert.equal(canTaskBudget('google/gemini-3.1-pro-preview'), false)
  })

  it('false for an unknown model id', () => {
    assert.equal(canTaskBudget('made/up-model'), false)
  })
})

describe('TASK_BUDGET_MODES', () => {
  it('exposes the three CLI-accepted values', () => {
    assert.deepEqual(TASK_BUDGET_MODES, ['never', 'always', 'error'])
  })
})

describe('claude opus 5', () => {
  const OPUS5 = 'anthropic/claude-opus-5'

  it('registers a 128,000 max_tokens', () => {
    assert.equal(getMaxTokens(OPUS5), 128_000)
  })

  it('prices at the published $5 / $25 per Mtok', () => {
    const usage = { ...emptyUsage(), input: 1_000_000, output: 1_000_000 }
    assert.equal(calculateCost(OPUS5, usage), 5 + 25)
  })

  it('is adaptive-thinking capable and reads an effort knob', () => {
    assert.equal(canThink(OPUS5), true)
    assert.equal(canAdaptive(OPUS5), true)
    assert.equal(canEffort(OPUS5), true)
    assert.deepEqual(normalizeThinkEffort(OPUS5, true), { useThink: true, useEffort: 'high' })
    assert.deepEqual(normalizeThinkEffort(OPUS5, true, 'max'), { useThink: true, useEffort: 'max' })
  })

  it('think=false still resolves to no thinking (the wire-level opt-out lives in the adapter)', () => {
    assert.deepEqual(normalizeThinkEffort(OPUS5, false), { useThink: false, useEffort: undefined })
  })
})

describe('DEFAULT_MODEL', () => {
  it('is opus 5.5 — what Anthropic points new work at, and the cheaper of the two', () => {
    assert.equal(DEFAULT_MODEL, 'anthropic/claude-opus-5.5')
  })

  it('is a row of the table, so a caller that names no model is priced and capped', () => {
    // The whole point of defaulting to a registered id: an unlisted one
    // costs nothing the table can price and takes the fallback output cap.
    assert.ok(KNOWN_MODELS.includes(DEFAULT_MODEL))
    assert.equal(isRecognizedModel(DEFAULT_MODEL), true)
    assert.ok(calculateCost(DEFAULT_MODEL, { ...emptyUsage(), input: 1_000_000 }) > 0)
    assert.equal(getMaxTokens(DEFAULT_MODEL), 128_000)
  })
})

describe('claude opus 5.5', () => {
  const OPUS55 = 'anthropic/claude-opus-5.5'
  const bill = (field) => calculateCost(OPUS55, { ...emptyUsage(), [field]: 1_000_000 })

  it('prices at the published $4 / $20 per Mtok, under opus 5', () => {
    assert.equal(bill('input'), 4)
    assert.equal(bill('output'), 20)
    assert.equal(calculateCost('anthropic/claude-opus-5', { ...emptyUsage(), input: 1_000_000 }), 5)
  })

  it('bills cache reads at the row\'s flat $0.20 per Mtok — 0.05x input, not the usual 0.10x', () => {
    assert.equal(bill('cacheRead'), 0.2)
    // The default multiplier would have charged twice that.
    assert.equal(calculateCost(OPUS55, { ...emptyUsage(), cacheRead: 1_000_000 }) * 2, 0.4)
  })

  it('still takes both cache-WRITE legs as multiples of base input', () => {
    assert.equal(bill('cacheWrite5m'), 4 * 1.25)
    assert.equal(bill('cacheWrite1h'), 4 * 2)
  })

  it('registers a 128,000 max_tokens', () => {
    assert.equal(getMaxTokens(OPUS55), 128_000)
  })

  it('is adaptive-thinking capable and reads an effort knob', () => {
    assert.equal(canThink(OPUS55), true)
    assert.equal(canAdaptive(OPUS55), true)
    assert.equal(canEffort(OPUS55), true)
    assert.deepEqual(normalizeThinkEffort(OPUS55, true), { useThink: true, useEffort: 'high' })
    assert.deepEqual(normalizeThinkEffort(OPUS55, true, 'max'), { useThink: true, useEffort: 'max' })
  })

  it('offers every effort level except manual, which it has no wire form for', () => {
    // `manual` means a fixed budget_tokens, and that request 400s here as
    // surely as `thinking: disabled` does.
    assert.deepEqual(effortsFor(OPUS55), ['low', 'medium', 'high', 'xhigh', 'max'])
    assert.equal(effortsFor(OPUS55).includes('manual'), false)
  })

  it('accepts the Anthropic task-budgets beta', () => {
    assert.equal(canTaskBudget(OPUS55), true)
  })
})

describe('no-think wire form', () => {
  // Fable 5 is the row worth reading twice: it thinks by default like opus
  // 5, yet needs no explicit opt-out because it accepts none — the disabled
  // form 400s at any effort, so omitting is its only legal request.
  for (const [model, needsExplicit, canDisable] of [
    ['anthropic/claude-opus-5', true, true],
    // Opus 5.5 is opus 5 with the opt-out gone: `disabled` and a manual
    // budget both 400, so omitting is the only legal request.
    ['anthropic/claude-opus-5.5', false, false],
    ['anthropic/claude-fable-5', false, false],
    ['anthropic/claude-fable-5.1', false, false],
    ['anthropic/claude-opus-4.8', false, true],
    ['anthropic/claude-sonnet-4.6', false, true],
    ['openai/gpt-5.6-sol', false, true],
    // Same shape as fable 5, arrived at from the other direction: K3 has no
    // opt-out on either route, so omitting the effort field is all we can do.
    ['moonshotai/kimi-k3', false, false],
    // Astra rejects `reasoning_effort: 'none'` and floors at `low`, so
    // thinking cannot be turned off on either row — pro least of all, since
    // pro IS a reasoning mode.
    ['openai/gpt-6-astra', false, false],
    ['openai/gpt-6-astra-pro', false, false],
    ['made/up-model', false, true],
  ]) {
    it(model, () => {
      assert.equal(needsExplicitNoThink(model), needsExplicit)
      assert.equal(canDisableThink(model), canDisable)
    })
  }

  it('fable 5 is adaptive-capable — only the opt-out sets it apart from opus 5', () => {
    assert.equal(canAdaptive('anthropic/claude-fable-5'), true)
    assert.equal(canAdaptive('anthropic/claude-fable-5.1'), true)
  })
})

describe('claude fable 5.1', () => {
  const FABLE51 = 'anthropic/claude-fable-5.1'

  it('registers 5.1\'s published $10 / $50 per Mtok and a 128,000 max_tokens', () => {
    const usage = { ...emptyUsage(), input: 1_000_000, output: 1_000_000 }
    assert.equal(calculateCost(FABLE51, usage), 10 + 50)
    assert.equal(getMaxTokens(FABLE51), 128_000)
  })

  it('bills cache reads at the row\'s flat $0.25 per Mtok, not 0.10x of input', () => {
    const usage = { ...emptyUsage(), cacheRead: 1_000_000 }
    assert.equal(calculateCost(FABLE51, usage), 0.25)
    // The multiplier the rest of the table uses would have charged 4x this.
    assert.equal(calculateCost('anthropic/claude-fable-5', usage), 1)
  })

  it('still takes both cache-WRITE legs as multiples of base input', () => {
    const write5m = { ...emptyUsage(), cacheWrite5m: 1_000_000 }
    const write1h = { ...emptyUsage(), cacheWrite1h: 1_000_000 }
    assert.equal(calculateCost(FABLE51, write5m), 10 * 1.25)
    assert.equal(calculateCost(FABLE51, write1h), 10 * 2)
  })

  it('leaves a row without an override on the 0.10x multiplier', () => {
    const usage = { ...emptyUsage(), cacheRead: 1_000_000 }
    assert.equal(calculateCost('anthropic/claude-opus-5', usage), 0.5)
  })
})

// Both nemotron pairs are the same shape: a paid route and a free one that
// may log what it is sent, thinking on both, and no effort ladder claimed for
// either — OpenRouter reports reasoning_effort on neither, and an unnarrowed
// row passes whatever the caller asks rather than rejecting a level the model
// may well take.
describe('nemotron paid/free pairs', () => {
  const PAIRS = [
    ['nvidia/nemotron-3-ultra-550b-a55b', 0.625, 3.125],
    ['nvidia/nemotron-3.5-lightning', 0.08, 0.2],
    ['nvidia/nemotron-3-super-120b-a12b', 0.085, 0.4],
  ]

  for (const [paid, input, output] of PAIRS) {
    const free = `${paid}:free`

    it(`${paid}: registers the paid rate, and the free route at nothing`, () => {
      const million = { ...emptyUsage(), input: 1_000_000, output: 1_000_000 }
      assert.equal(calculateCost(paid, million), input + output)
      assert.equal(calculateCost(free, million), 0)
      assert.equal(getMaxTokens(paid), 128 * 1024)
      for (const model of [paid, free]) assert.ok(KNOWN_MODELS.includes(model), model)
    })

    it(`${paid}: thinks on both routes, with no effort ladder claimed`, () => {
      for (const model of [paid, free]) {
        assert.equal(canThink(model), true, model)
        assert.equal(effortsFor(model), undefined, model)
        assert.deepEqual(normalizeThinkEffort(model, true), { useThink: true, useEffort: 'high' }, model)
      }
    })

    it(`${paid}: gates the free route behind --free, and the paid one against it`, () => {
      assert.doesNotThrow(() => validateModel(paid))
      assert.throws(() => validateModel(paid, { free: true }), /is not free/u)
      assert.doesNotThrow(() => validateModel(free, { free: true }))
      assert.throws(() => validateModel(free), /requires --free/u)
    })
  }
})

describe('gemini flash', () => {
  it('registers 3.8 flash, and lets all three gemini rows think', () => {
    const million = { ...emptyUsage(), input: 1_000_000, output: 1_000_000 }
    assert.equal(calculateCost('google/gemini-3.8-flash', million), 0.75 + 3.75)
    for (const m of ['google/gemini-3.8-flash', 'google/gemini-3.1-flash-lite-preview', 'google/gemini-3.1-pro-preview']) {
      assert.equal(canThink(m), true, m)
    }
  })
})

describe('cache-read overrides (rows that are not 0.10x of input)', () => {
  const read = (model) => baseRate(model, 'cacheRead')

  it('bills gpt-4.1-mini and gpt-4o-mini at their published cached-input rates', () => {
    // OpenAI prices cached input per model, not as one multiple of input:
    // 0.25x on gpt-4.1-mini, 0.5x on gpt-4o-mini. The 0.10x default would
    // bill a cache-heavy run at a fraction of what OpenAI charges.
    assert.equal(read('openai/gpt-4.1-mini'), 0.1)
    assert.equal(read('openai/gpt-4o-mini'), 0.075)
  })

  it('leaves the families that really are 0.10x on the multiplier', () => {
    assert.equal(read('openai/gpt-5.6-luna'), 0.02)
    assert.equal(read('openai/gpt-5.5'), 0.5)
    assert.equal(read('anthropic/claude-sonnet-5'), 0.2)
  })
})

describe('cache-write rates', () => {
  // OpenAI's pricing page lists a cache-write column only from GPT-5.6 on,
  // at 1.25x input; before that, a write is billed as the input it is.
  for (const [model, write] of [
    ['openai/gpt-6-astra', 12.5],
    ['openai/gpt-5.6-sol', 5],
    ['openai/gpt-5.6-terra', 2.5],
    ['openai/gpt-5.6-luna', 0.25],
  ]) {
    it(`${model}: bills a write at the published 1.25x of input`, () => {
      assert.equal(baseRate(model, 'cacheWrite5m'), write)
    })
  }

  for (const model of ['openai/gpt-5.5', 'openai/gpt-5.5-pro', 'openai/gpt-5.4', 'openai/gpt-5.4-nano', 'openai/gpt-5.4-mini', 'openai/gpt-5.4-pro', 'openai/gpt-5.3-codex', 'openai/gpt-4.1-mini', 'openai/gpt-4o-mini']) {
    it(`${model}: bills a write as ordinary input, with nothing on top`, () => {
      assert.equal(baseRate(model, 'cacheWrite5m'), baseRate(model, 'input'))
    })
  }

  it('leaves Anthropic on its own 1.25x and 2x legs', () => {
    assert.equal(baseRate('anthropic/claude-opus-5', 'cacheWrite5m'), 5 * 1.25)
    assert.equal(baseRate('anthropic/claude-opus-5', 'cacheWrite1h'), 5 * 2)
  })
})

describe('long-context tier', () => {
  const MTOK = 1_000_000
  const bill = (model, fields) => calculateCost(model, { ...emptyUsage(), ...fields })

  // The long-context columns of OpenAI's pricing page, per Mtok: input,
  // cached input, cache writes (null where the page lists none), output. A
  // million tokens on any prompt leg is already past the 272K line.
  for (const [model, input, cached, write, output] of [
    ['openai/gpt-6-astra', 20, 2, 25, 75],
    ['openai/gpt-6-sol', 4, 0.4, 5, 15],
    ['openai/gpt-6-luna', 0.2, 0.02, 0.25, 0.75],
    ['openai/gpt-5.6-sol', 8, 0.8, 10, 30],
    ['openai/gpt-5.6-terra', 4, 0.4, 5, 18],
    ['openai/gpt-5.6-luna', 0.4, 0.04, 0.5, 1.8],
    ['openai/gpt-5.5', 10, 1, null, 45],
    ['openai/gpt-5.5-pro', 60, null, null, 270],
    ['openai/gpt-5.4', 5, 0.5, null, 22.5],
    ['openai/gpt-5.4-pro', 60, null, null, 270],
  ]) {
    it(`${model}: bills the published long-context rates past 272K`, () => {
      assert.equal(bill(model, { input: MTOK, output: MTOK }), input + output)
      if (cached !== null) assert.equal(bill(model, { cacheRead: MTOK }), cached)
      if (write !== null) assert.equal(bill(model, { cacheWrite5m: MTOK }), write)
    })
  }

  it('draws the line after 272,000 prompt tokens, and then prices the whole request at the tier', () => {
    const base = (tokens) => (tokens * 5) / MTOK
    assert.equal(bill('openai/gpt-5.5', { input: 272_000 }), base(272_000))
    // One token over doubles every input token, not just the one past the line.
    assert.equal(bill('openai/gpt-5.5', { input: 272_001 }), 2 * base(272_001))
  })

  it('counts cached tokens toward the line, as OpenAI does', () => {
    // 100k fresh at $10 and 200k cached at $1: 300k of prompt is past the
    // line though neither leg is on its own.
    assert.equal(bill('openai/gpt-5.5', { input: 100_000, cacheRead: 200_000 }), 1 + 0.2)
  })

  it('draws it on the prompt alone — a long answer to a short prompt stays at the base rate', () => {
    assert.equal(bill('openai/gpt-5.5', { input: 1000, output: MTOK }), (1000 * 5) / MTOK + 30)
  })

  it('gives each openrouter pro alias its base model\'s tier, the way it shares its base rate', () => {
    const long = { input: MTOK, output: MTOK, cacheRead: MTOK }
    for (const base of ['openai/gpt-6-astra', 'openai/gpt-5.6-sol', 'openai/gpt-5.6-terra', 'openai/gpt-5.6-luna']) {
      assert.equal(bill(`${base}-pro`, long), bill(base, long), base)
    }
  })

  it('leaves the OpenAI rows without a long-context column on their base rate', () => {
    assert.equal(bill('openai/gpt-5.4-mini', { input: MTOK, output: MTOK }), 0.75 + 4.5)
    assert.equal(bill('openai/gpt-5.3-codex', { input: MTOK, output: MTOK }), 1.75 + 14)
  })

  // Anthropic publishes no tier: 4.6 and later bill the whole 1M window at
  // the standard rate, which a million-token prompt pins for every one of
  // them — the same request that bills an OpenAI row at twice its input rate.
  for (const [model, input, output] of [
    ['anthropic/claude-fable-5.1', 10, 50],
    ['anthropic/claude-fable-5', 10, 50],
    // The row a review asked to price higher past 200k: Anthropic bills
    // it at $4 / $20 across the whole window like the rest.
    ['anthropic/claude-opus-5.5', 4, 20],
    ['anthropic/claude-opus-5', 5, 25],
    ['anthropic/claude-opus-4.8', 5, 25],
    ['anthropic/claude-opus-4.7', 5, 25],
    ['anthropic/claude-opus-4.6', 5, 25],
    ['anthropic/claude-sonnet-5', 2, 10],
    ['anthropic/claude-sonnet-4.6', 3, 15],
  ]) {
    it(`${model}: bills a 1M-token prompt at the standard rate`, () => {
      assert.equal(bill(model, { input: MTOK, output: MTOK }), input + output)
      assert.equal(bill(model, { cacheWrite1h: MTOK }), input * 2)
    })
  }
})

describe('satellite tables name real registry rows', () => {
  // TASK_BUDGET_MODELS is keyed by model id and maintained by hand beside
  // the registry, so a typo — the hyphenated wire form, say — is silent:
  // the beta just stops applying, with every other test still green.
  // (EMPTY_RESPONSE_FALLBACKS gets the same check against KNOWN_MODELS in
  // tests/fallback.test.js, where that table lives.)
  for (const id of TASK_BUDGET_MODELS) {
    it(`TASK_BUDGET_MODELS: ${id}`, () => assert.ok(KNOWN_MODELS.includes(id), id))
  }

  // Same hazard, and worse: an id here that no row answers to would send the
  // adapter looking up a tag it can never find, so the provider refuses a
  // model the table says it serves.
  for (const id of ollamaModels()) {
    it(`OLLAMA_TAGS: ${id}`, () => assert.ok(KNOWN_MODELS.includes(id), id))
  }
})

describe('ollama tags — one local build per row', () => {
  const entries = ollamaModels().map((id) => [id, ollamaTagFor(id)])

  it('has entries to check', () => {
    assert.ok(entries.length > 5, `expected a mapping, found ${entries.length}`)
  })

  it('names a distinct tag per row', () => {
    // Two rows on one tag would be two ids for one set of weights, which is
    // the confusion the per-precision ids exist to end.
    const tags = entries.map(([, tag]) => tag)
    assert.equal(new Set(tags).size, tags.length, tags.join(', '))
  })

  // Ascending, so `.indexOf` ranks them, and an `mtp-` build sits just under
  // the plain one it shadows. Each pair is listed longest first, so the
  // `.find` below never reads `-mtp-q8_0` as `-q8_0`.
  const PRECISION = ['qat', 'mtp-q4_K_M', 'q4_K_M', 'mtp-q8_0', 'q8_0', 'mtp-bf16', 'bf16']

  // A tag is a family and one build of it — `qwen3.6:35b-a3b` and `mtp-q8_0`.
  function partsOf(tag) {
    const quant = PRECISION.find((build) => tag.endsWith(`-${build}`))
    return { family: quant ? tag.slice(0, -(quant.length + 1)) : tag, quant }
  }

  // Which build an id claims, if it claims one. Nothing here is keyed to a
  // family's own spelling: gemma names its sizes `12b-it` and qwen `35b-a3b`,
  // and the rule is the same for both.
  const buildIn = (id) => PRECISION.find((build) => id.endsWith(`-${build.toLowerCase()}`))

  for (const [id, tag] of entries) {
    it(`${id} -> ${tag}`, () => {
      const { quant } = partsOf(tag)
      assert.ok(quant, `unranked build in ${tag} — add it to PRECISION`)
      // An id that names a build must name the one the tag actually serves.
      // One that names none is its family's bare id, pinned just below.
      const named = buildIn(id)
      if (named) assert.equal(named, quant, `${id} vs ${tag}`)
    })
  }

  // A bare id stands in for a hosted route, and none of the routes mapped
  // here runs below 8 bits — so whichever build a family's bare id takes, it
  // is never a 4-bit one, and never the `-mtp-` repackaging of anything.
  // Which of the top builds it takes is what the family is served at: bf16
  // for gemma-4, q8_0 for qwen, whose endpoints are fp8.
  const FLOOR = 'q8_0'
  for (const family of new Set(entries.map(([, tag]) => partsOf(tag).family))) {
    it(`${family}: exactly one bare id, and never a 4-bit build`, () => {
      const mine = entries.filter(([, tag]) => partsOf(tag).family === family)
      const bare = mine.filter(([id]) => !buildIn(id))
      assert.equal(bare.length, 1, `expected one bare id for ${family}, found ${bare.map(([id]) => id).join(', ') || 'none'}`)
      const { quant } = partsOf(bare[0][1])
      assert.ok(PRECISION.indexOf(quant) >= PRECISION.indexOf(FLOOR), `${bare[0][0]} takes ${quant}, below ${FLOOR}`)
    })
  }

  it('leaves the local-only builds unpriced, rather than calling them free', () => {
    // Nobody sells these, so the table has no rate to give — and a zero would
    // be a claim that goes wrong the day one is listed. What a local run
    // costs is the provider's answer, not the table's.
    const million = { ...emptyUsage(), input: 1_000_000, output: 1_000_000 }
    for (const [local] of entries.filter(([id]) => buildIn(id))) {
      assert.equal(calculateCost(local, million), null, local)
    }
    // And the bare ids keep the hosted rate they are sold at.
    assert.ok(calculateCost('google/gemma-4-26b-a4b-it', million) > 0)
  })
})

describe('gpt-6 astra', () => {
  const ASTRA = 'openai/gpt-6-astra'

  it('registers the published $10 / $50 per Mtok and a 128,000 max_tokens', () => {
    assert.equal(baseRate(ASTRA, 'input', 'output'), 10 + 50)
    assert.equal(getMaxTokens(ASTRA), 128_000)
  })

  it('needs no cache-read override — $1.00 per Mtok is already 0.10x of input', () => {
    assert.equal(baseRate(ASTRA, 'cacheRead'), 1)
  })

  it('is thinking-capable and reads an effort knob', () => {
    assert.equal(canThink(ASTRA), true)
    assert.equal(canEffort(ASTRA), true)
    assert.deepEqual(normalizeThinkEffort(ASTRA, true), { useThink: true, useEffort: 'high' })
  })

  it('does not accept the Anthropic task-budgets beta', () => {
    assert.equal(canTaskBudget(ASTRA), false)
  })
})

describe('gpt-6 sol and luna', () => {
  const SOL = 'openai/gpt-6-sol'
  const LUNA = 'openai/gpt-6-luna'

  it('registers the published rates and a 128,000 max_tokens', () => {
    assert.equal(baseRate(SOL, 'input', 'output'), 2 + 10)
    assert.equal(baseRate(LUNA, 'input', 'output'), 0.1 + 0.5)
    for (const model of [SOL, LUNA]) assert.equal(getMaxTokens(model), 128_000)
  })

  it('needs no cache override — reads are 0.10x of input and writes 1.25x', () => {
    assert.equal(baseRate(SOL, 'cacheRead'), 0.2)
    assert.equal(baseRate(LUNA, 'cacheRead'), 0.01)
    assert.equal(baseRate(SOL, 'cacheWrite5m'), 2.5)
    assert.equal(baseRate(LUNA, 'cacheWrite5m'), 0.125)
  })

  it('can turn thinking off, where astra above them cannot', () => {
    // Both take `reasoning_effort: 'none'`; astra floors at `low`.
    for (const model of [SOL, LUNA]) {
      assert.equal(canDisableThink(model), true, model)
      assert.equal(needsExplicitNoThink(model), false, model)
    }
    assert.equal(canDisableThink('openai/gpt-6-astra'), false)
    // Nor on their own -pro rows: pro IS a reasoning mode, so a request
    // that asks for pro and no thinking asks for two opposite things.
    for (const pro of [`${SOL}-pro`, `${LUNA}-pro`]) assert.equal(canDisableThink(pro), false, pro)
  })

  it('is thinking-capable, reads an effort knob, and takes the ladder through max', () => {
    for (const model of [SOL, LUNA]) {
      assert.equal(canThink(model), true, model)
      assert.equal(canEffort(model), true, model)
      assert.deepEqual(effortsFor(model), ['low', 'medium', 'high', 'xhigh', 'max'], model)
      assert.deepEqual(normalizeThinkEffort(model, true), { useThink: true, useEffort: 'high' })
    }
  })

  it('reads the explicit cache breakpoint, as every gpt-5.6-and-later row does', () => {
    for (const model of [SOL, LUNA]) assert.equal(readsCacheBreakpoint(model), true, model)
  })

  it('does not accept the Anthropic task-budgets beta', () => {
    for (const model of [SOL, LUNA]) assert.equal(canTaskBudget(model), false, model)
  })
})

// Two different things are called "pro" here. One is a MODE on another
// model — same weights and same rate, just more tokens spent thinking — so
// the row names its base as the wire model and 'pro' as the mode. The other
// is a model of its own at its own rate, and is simply a row.
describe('openai pro rows', () => {
  const MODES = [
    ['openai/gpt-6-astra-pro', 'openai/gpt-6-astra'],
    ['openai/gpt-6-sol-pro', 'openai/gpt-6-sol'],
    ['openai/gpt-6-luna-pro', 'openai/gpt-6-luna'],
    ['openai/gpt-5.6-sol-pro', 'openai/gpt-5.6-sol'],
    ['openai/gpt-5.6-terra-pro', 'openai/gpt-5.6-terra'],
    ['openai/gpt-5.6-luna-pro', 'openai/gpt-5.6-luna'],
  ]
  const OWN_MODEL = ['openai/gpt-5.5-pro', 'openai/gpt-5.4-pro']
  const million = () => ({ ...emptyUsage(), input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000 })

  for (const [pro, base] of MODES) {
    it(`${pro}: priced like ${base} — pro spends more tokens, not more per token`, () => {
      assert.equal(calculateCost(pro, million()), calculateCost(base, million()))
      assert.equal(getMaxTokens(pro), getMaxTokens(base))
      // A row of its own, not an alias: the two answer differently, so they
      // must not share a cache dir.
      assert.equal(resolveModel(pro), pro)
      assert.ok(KNOWN_MODELS.includes(pro))
    })

    it(`${pro}: refuses --no-think, since pro mode has no off switch`, () => {
      // providers.js emits reasoning.mode whenever the row names one, think
      // or not. Without this the flag is waved through and the caller is
      // billed pro-mode reasoning on a run they asked to be non-thinking.
      assert.equal(canDisableThink(pro), false)
    })

    it(`${pro}: names ${base} as its wire model and pro as its mode`, () => {
      assert.equal(wireModelFor(pro), base)
      assert.equal(reasoningModeFor(pro), 'pro')
      // And the base is not itself a mode of anything.
      assert.equal(wireModelFor(base), base)
      assert.equal(reasoningModeFor(base), undefined)
    })
  }

  for (const pro of OWN_MODEL) {
    it(`${pro}: a model of its own rather than a mode`, () => {
      assert.equal(wireModelFor(pro), pro)
      assert.equal(reasoningModeFor(pro), undefined)
      // Priced far above the row it is named after, which is the thing that
      // says it is a different model rather than the same one thinking harder.
      assert.ok(calculateCost(pro, million()) > calculateCost(pro.replace('-pro', ''), million()), pro)
    })
  }

  it('leaves every other row its own wire model, with no mode', () => {
    for (const model of ['anthropic/claude-opus-5', 'openai/gpt-4.1-mini', 'nobody/nothing']) {
      assert.equal(wireModelFor(model), model, model)
      assert.equal(reasoningModeFor(model), undefined, model)
    }
  })
})

describe('newer OpenAI models (gpt-5.6 Sol / Terra / Luna)', () => {
  const FAMILY = ['openai/gpt-5.6-sol', 'openai/gpt-5.6-terra', 'openai/gpt-5.6-luna']

  it('registers each with a 128,000 max_tokens', () => {
    for (const model of FAMILY) assert.equal(getMaxTokens(model), 128_000)
  })

  it('is thinking-capable and reads an effort knob (non-Anthropic thinking model)', () => {
    for (const model of FAMILY) {
      assert.equal(canThink(model), true, model)
      assert.equal(canEffort(model), true, model)
      // think=true defaults effort to "high", same as gpt-5.5.
      assert.deepEqual(normalizeThinkEffort(model, true), { useThink: true, useEffort: 'high' })
    }
  })

  it('does not accept the Anthropic task-budgets beta', () => {
    for (const model of FAMILY) assert.equal(canTaskBudget(model), false, model)
  })

  it('prices each tier per the published rates (per Mtok in + out)', () => {
    assert.equal(baseRate('openai/gpt-5.6-sol', 'input', 'output'), 4 + 20)
    assert.equal(baseRate('openai/gpt-5.6-terra', 'input', 'output'), 2 + 12)
    assert.equal(baseRate('openai/gpt-5.6-luna', 'input', 'output'), 0.2 + 1.2)
  })
})

describe('resolveModel (alias canonicalization)', () => {
  it('maps the gpt-5.6 alias to the concrete Sol tier', () => {
    assert.equal(resolveModel('openai/gpt-5.6'), 'openai/gpt-5.6-sol')
  })

  it('maps bare kimi-k3 — the id Moonshot\'s own docs use — to the registry row', () => {
    assert.equal(resolveModel('kimi-k3'), 'moonshotai/kimi-k3')
    // Why the alias earns its place: unresolved, every lookup takes a wrong
    // default, and the worst is canThink — thinking would switch OFF on a
    // model that always reasons and bills for it.
    assert.equal(canThink('kimi-k3'), false)
    assert.equal(getMaxTokens('kimi-k3'), 64 * 1024) // DEFAULT_MAX_TOKENS
    assert.equal(calculateCost('kimi-k3', { ...emptyUsage(), input: 1_000_000 }), null)
    assert.equal(canThink(resolveModel('kimi-k3')), true)
    assert.equal(getMaxTokens(resolveModel('kimi-k3')), 131_072)
    assert.equal(calculateCost(resolveModel('kimi-k3'), { ...emptyUsage(), input: 1_000_000 }), 3)
  })

  it('passes a non-alias model through unchanged', () => {
    assert.equal(resolveModel('openai/gpt-5.6-terra'), 'openai/gpt-5.6-terra')
    assert.equal(resolveModel('anthropic/claude-opus-4.8'), 'anthropic/claude-opus-4.8')
    assert.equal(resolveModel('made/up-model'), 'made/up-model')
  })

  it('the alias is not itself a registry row — resolving is what makes it usable', () => {
    // Unresolved, the alias falls back to defaults (no price, default max
    // tokens); the resolved id is the registered, priced tier.
    assert.equal(getMaxTokens('openai/gpt-5.6'), 64 * 1024) // DEFAULT_MAX_TOKENS
    const usage = { ...emptyUsage(), input: 1_000_000, output: 1_000_000 }
    assert.equal(calculateCost('openai/gpt-5.6', usage), null)
    assert.equal(getMaxTokens(resolveModel('openai/gpt-5.6')), 128_000)
    assert.equal(baseRate(resolveModel('openai/gpt-5.6'), 'input', 'output'), 4 + 20)
  })
})

describe('Kimi K3 (moonshotai/kimi-k3)', () => {
  const MODEL = 'moonshotai/kimi-k3'

  it("caps output at Moonshot's max_completion_tokens default, not the 1M context", () => {
    // The registry value is an OUTPUT budget. K3's context window is
    // 1,048,576 and max_completion_tokens may be raised that far, but its
    // documented default — and a sane per-request cap — is 131,072.
    assert.equal(getMaxTokens(MODEL), 131_072)
  })

  it('is thinking-capable and reads an effort knob (non-Anthropic thinking model)', () => {
    assert.equal(canThink(MODEL), true)
    assert.equal(canEffort(MODEL), true)
    assert.equal(canAdaptive(MODEL), false) // 'adaptive' is the Anthropic wire form
    assert.deepEqual(normalizeThinkEffort(MODEL, true), { useThink: true, useEffort: 'high' })
  })

  it('does not accept the Anthropic task-budgets beta', () => {
    assert.equal(canTaskBudget(MODEL), false)
  })

  it("prices at Moonshot's list rate, with cache hits at a tenth of fresh input", () => {
    const usage = { ...emptyUsage(), input: 1_000_000, output: 1_000_000 }
    assert.equal(calculateCost(MODEL, usage), 3 + 15)
    // $0.30 per Mtok cache-hit input — the 0.10x cacheRead multiplier lands
    // exactly on Moonshot's published cached-input price.
    assert.equal(calculateCost(MODEL, { ...emptyUsage(), cacheRead: 1_000_000 }), 0.3)
  })

  it('is a paid model — usable without --free, rejected with it', () => {
    assert.doesNotThrow(() => validateModel(MODEL))
    assert.throws(() => validateModel(MODEL, { free: true }), /is not free/u)
  })
})

describe('Gemma 4 (google/gemma-4-31b-it, google/gemma-4-26b-a4b-it)', () => {
  const PAID = ['google/gemma-4-31b-it', 'google/gemma-4-26b-a4b-it']
  const FREE = ['google/gemma-4-31b-it:free', 'google/gemma-4-26b-a4b-it:free']
  const ALL = [...PAID, ...FREE]

  it('registers all four rows, paid tier and free endpoint alike', () => {
    for (const model of ALL) {
      assert.ok(KNOWN_MODELS.includes(model), model)
      assert.equal(isRecognizedModel(model), true, model)
    }
  })

  it('caps output at 128k on every row — the free endpoint serves the same weights', () => {
    for (const model of ALL) assert.equal(getMaxTokens(model), 128 * 1024, model)
  })

  it('prices the paid rows per Mtok in + out, and charges nothing for the free ones', () => {
    const usage = { ...emptyUsage(), input: 1_000_000, output: 1_000_000 }
    assert.equal(calculateCost('google/gemma-4-31b-it', usage), 0.14 + 0.4)
    assert.equal(calculateCost('google/gemma-4-26b-a4b-it', usage), 0.13 + 0.4)
    for (const model of FREE) assert.equal(calculateCost(model, usage), 0, model)
  })

  it('thinks and reads an effort knob on the free rows too', () => {
    for (const model of ALL) {
      assert.equal(canThink(model), true, model)
      assert.equal(canEffort(model), true, model)
      assert.equal(canAdaptive(model), false, model)
      assert.deepEqual(normalizeThinkEffort(model, true), { useThink: true, useEffort: 'high' })
    }
  })

  it('takes the full effort ladder — no gemma row narrows it', () => {
    for (const model of ALL) assert.equal(effortsFor(model), undefined, model)
  })

  it('gates each row on --free in the direction its price says', () => {
    for (const model of PAID) {
      assert.doesNotThrow(() => validateModel(model))
      assert.throws(() => validateModel(model, { free: true }), /is not free/u)
    }
    for (const model of FREE) {
      assert.doesNotThrow(() => validateModel(model, { free: true }))
      assert.throws(() => validateModel(model), /requires --free flag/u)
    }
  })

  it('does not accept the Anthropic task-budgets beta', () => {
    for (const model of ALL) assert.equal(canTaskBudget(model), false, model)
  })
})

describe('effortsFor / EFFORT_LEVELS', () => {
  // Every model that narrows, so the subset/'manual' checks below can't drift
  // past a row added later.
  const NARROWED = [
    'moonshotai/kimi-k3',
    'openai/gpt-6-astra', 'openai/gpt-6-astra-pro',
    'openai/gpt-5.6-sol', 'openai/gpt-5.6-terra', 'openai/gpt-5.6-luna',
    'openai/gpt-5.5',
    'openai/gpt-5.4', 'openai/gpt-5.4-nano', 'openai/gpt-5.4-mini', 'openai/gpt-5.4-pro',
    'openai/gpt-5.3-codex',
  ]

  it('narrows K3 to the three levels its reasoning_effort takes', () => {
    assert.deepEqual(effortsFor('moonshotai/kimi-k3'), ['low', 'high', 'max'])
  })

  it('resolves aliases first, so the bare id narrows the same', () => {
    assert.deepEqual(effortsFor('kimi-k3'), effortsFor('moonshotai/kimi-k3'))
    // openai/gpt-5.6 is an alias of the Sol variant, which takes max.
    assert.deepEqual(effortsFor('openai/gpt-5.6'), effortsFor('openai/gpt-5.6-sol'))
  })

  it('gates max to the gpt-5.6 family and gpt-6', () => {
    for (const model of ['openai/gpt-6-astra', 'openai/gpt-6-astra-pro', 'openai/gpt-5.6-sol', 'openai/gpt-5.6-terra', 'openai/gpt-5.6-luna']) {
      assert.ok(effortsFor(model).includes('max'), model)
    }
    for (const model of ['openai/gpt-5.5', 'openai/gpt-5.4', 'openai/gpt-5.4-pro', 'openai/gpt-5.3-codex']) {
      assert.equal(effortsFor(model).includes('max'), false, model)
    }
  })

  it('gates xhigh to gpt-5.6 / 5.5 / 5.4, leaving 5.3-codex capped at high', () => {
    for (const model of ['openai/gpt-5.6-sol', 'openai/gpt-5.5', 'openai/gpt-5.4', 'openai/gpt-5.4-mini']) {
      assert.ok(effortsFor(model).includes('xhigh'), model)
    }
    assert.deepEqual(effortsFor('openai/gpt-5.3-codex'), ['low', 'medium', 'high'])
  })

  it('never offers manual — it is Anthropic\'s fixed-budget marker, not a wire value', () => {
    for (const model of NARROWED) assert.equal(effortsFor(model).includes('manual'), false, model)
    // Anthropic itself takes the full ladder, manual included.
    assert.equal(effortsFor('anthropic/claude-opus-4.7'), undefined)
    assert.ok(EFFORT_LEVELS.includes('manual'))
  })

  it('is undefined for models that take the full ladder, and for junk', () => {
    assert.equal(effortsFor('anthropic/claude-opus-4.7'), undefined)
    assert.equal(effortsFor('google/gemma-4-31b-it'), undefined)
    assert.equal(effortsFor('nobody/nothing'), undefined)
    assert.equal(effortsFor(undefined), undefined)
    assert.equal(effortsFor(123), undefined)
  })

  it('every narrowed set is a subset of the ladder — a model cannot invent a level', () => {
    for (const model of NARROWED) {
      for (const level of effortsFor(model)) assert.ok(EFFORT_LEVELS.includes(level), `${model}: ${level}`)
    }
  })
})

describe('readsCacheBreakpoint', () => {
  it('is set for the gpt-5.6 family and gpt-6, aliases included', () => {
    for (const model of ['openai/gpt-6-astra', 'openai/gpt-6-astra-pro', 'openai/gpt-5.6-sol', 'openai/gpt-5.6-terra', 'openai/gpt-5.6-luna', 'openai/gpt-5.6']) {
      assert.equal(readsCacheBreakpoint(model), true, model)
    }
  })

  it('is false for every model that would 400 on the field', () => {
    for (const model of ['openai/gpt-5.5', 'openai/gpt-5.4', 'openai/gpt-5.3-codex', 'openai/gpt-4o-mini', 'anthropic/claude-opus-5', 'nobody/nothing']) {
      assert.equal(readsCacheBreakpoint(model), false, model)
    }
  })
})
