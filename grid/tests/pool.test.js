import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { mapLimit } from '../src/pool.js'

const tick = () => new Promise((resolve) => { setTimeout(resolve, 5) })

describe('mapLimit', () => {
  it('maps in input order with at most `limit` in flight', async () => {
    let inFlight = 0
    let peak = 0
    const results = await mapLimit([30, 10, 20, 5], 2, async (ms) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => { setTimeout(resolve, ms) })
      inFlight -= 1
      return ms * 2
    })
    assert.deepEqual(results, [60, 20, 40, 10])
    assert.equal(peak, 2)
  })

  it('runs at least one worker, and no more workers than items', async () => {
    assert.deepEqual(await mapLimit([1, 2], 0, (n) => Promise.resolve(n)), [1, 2])
    assert.deepEqual(await mapLimit([], 5, () => Promise.reject(new Error('never'))), [])
  })

  it('rejects with the first error, after every started item has settled, starting none after it', async () => {
    const seen = []
    let slowDone = false
    const run = mapLimit(['fails', 'slow', 'never'], 2, async (item) => {
      seen.push(item)
      if (item === 'fails') throw new Error('first')
      await tick()
      await tick()
      slowDone = true
    })
    await assert.rejects(run, /^Error: first$/u)
    assert.equal(slowDone, true, 'the in-flight sibling finished before the pool rejected')
    assert.deepEqual(seen, ['fails', 'slow'])
  })
})
