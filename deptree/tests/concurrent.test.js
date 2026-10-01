import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { eachConcurrently } from '../src/concurrent.js'

const wait = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms)
})

describe('eachConcurrently', () => {
  it('runs each job once, eight at a time', async () => {
    const done = []
    let open = 0
    let most = 0
    await eachConcurrently(Array.from({ length: 20 }, (_, i) => i), async (i) => {
      open++
      most = Math.max(most, open)
      await wait(1)
      open--
      done.push(i)
    })
    assert.equal(most, 8)
    assert.deepEqual(done.toSorted((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i))
  })

  it('starts none after a failure, and throws the first once every job started has ended', async () => {
    const first = new Error('first')
    const started = []
    let open = 0
    const run = eachConcurrently(Array.from({ length: 20 }, (_, i) => i), async (i) => {
      started.push(i)
      open++
      await wait(i === 0 ? 0 : 10)
      open--
      if (i === 0) throw first
      if (i === 1) throw new Error('second')
    })
    await assert.rejects(run, (error) => error === first)
    assert.equal(open, 0)
    assert.deepEqual(started, [0, 1, 2, 3, 4, 5, 6, 7])
  })
})
