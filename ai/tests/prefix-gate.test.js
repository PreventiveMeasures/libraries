import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'

import { claimPrefix, prefixKey, resetPrefixGates } from '../src/prefix-gate.js'

// Lets a pending claim prove it is actually blocked: settle() only runs once
// the claim resolves, so a few turns of the microtask queue with the flag
// still false means it is waiting on the head.
const tick = () => new Promise((resolve) => { setImmediate(resolve) })

describe('prefixKey', () => {
  it('separates entries that would not share a cache prefix', () => {
    const keys = new Set([
      prefixKey('anthropic/claude-opus-5', undefined, 'SYS'),
      prefixKey('anthropic/claude-opus-4.7', undefined, 'SYS'), // caches are model-scoped
      prefixKey('anthropic/claude-opus-5', [{ name: 'get_source' }], 'SYS'), // tools render first
      prefixKey('anthropic/claude-opus-5', undefined, 'OTHER SYS'), // scan vs validate
    ])
    assert.equal(keys.size, 4)
  })

  it('is stable for the same model, tool set, and system prompt', () => {
    const tools = [{ name: 'get_source' }]
    assert.equal(
      prefixKey('anthropic/claude-opus-5', tools, 'SYS'),
      prefixKey('anthropic/claude-opus-5', [{ name: 'get_source' }], 'SYS'),
    )
  })
})

describe('claimPrefix', () => {
  beforeEach(resetPrefixGates)

  it('lets the head through immediately and holds everyone else until it replies', async () => {
    const release = await claimPrefix('k')

    let secondIn = false
    const second = claimPrefix('k').then(() => { secondIn = true; return null })
    let thirdIn = false
    const third = claimPrefix('k').then(() => { thirdIn = true; return null })

    await tick()
    assert.equal(secondIn, false, 'sibling must not issue while the head is in flight')
    assert.equal(thirdIn, false)

    release()
    await Promise.all([second, third])
    assert.equal(secondIn, true)
    assert.equal(thirdIn, true)
  })

  it('stops gating once the head has replied — the entry is warm', async () => {
    ;(await claimPrefix('k'))()

    let entered = 0
    await Promise.all([claimPrefix('k'), claimPrefix('k'), claimPrefix('k')].map((p) => p.then(() => { entered++; return null })))
    assert.equal(entered, 3)
  })

  it('gates each prefix independently — a scan pass cannot block a validate pass', async () => {
    await claimPrefix('scan') // held, never released

    let validateIn = false
    await claimPrefix('validate').then(() => { validateIn = true; return null })
    assert.equal(validateIn, true)
  })

  it('releases the waiters when the head request fails', async () => {
    // The caller releases from a `finally`, so a rejected request opens the
    // gate too — otherwise every sibling hangs behind one failure.
    const release = await claimPrefix('k')
    const waiting = claimPrefix('k')
    await Promise.reject(new Error('boom')).finally(() => release()).catch(() => {})
    await waiting
  })

  it('gives the head a real release and the waiters a no-op', async () => {
    const release = await claimPrefix('k')
    const waiter = claimPrefix('k')
    release()
    const waiterRelease = await waiter
    // Calling it must not re-open the gate for a later prefix generation.
    waiterRelease()
    assert.equal(typeof waiterRelease, 'function')
  })
})
