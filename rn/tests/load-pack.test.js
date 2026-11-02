import assert from 'node:assert/strict'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { createPack, pause } from '../src/load-pack.js'
import { writeTree } from './fixtures.js'

const key = (n) => String(n).padStart(64, '0')

describe('createPack', () => {
  const { root, cleanup } = writeTree({})
  after(cleanup)
  // A run's build of the pack in `dir`: what it asks for, then what it
  // sets, its segment written as it ends.
  const build = async (dir, { ask = [], set = [] } = {}) => {
    const pack = createPack(dir)
    pack.start()
    const got = ask.map((each) => pack.get(key(each)))
    for (const [each, value] of set) pack.set(key(each), value)
    await pack.finish()
    return got
  }
  const segments = (dir) => readdirSync(dir).filter((name) => name.endsWith('.pack'))

  it("writes a build's entries, a segment of their own, which a run after reads whole, each as it is asked for", async () => {
    const dir = join(root, 'a')
    assert.deepEqual(await build(dir, { ask: [1], set: [[1, { one: 1 }], [2, 'two']] }), [null])
    assert.equal(segments(dir).length, 1)
    assert.deepEqual(await build(dir, { ask: [1, 2, 3], set: [[3, [3]]] }), [{ one: 1 }, 'two', null])
    assert.deepEqual(await build(dir, { ask: [3] }), [[3]])
    assert.equal(segments(dir).length, 2)
  })

  it('asks for none of what it read once its builds are done: each is in memory then', async () => {
    const dir = join(root, 'b')
    await build(dir, { set: [[1, 'one']] })
    const pack = createPack(dir)
    pack.start()
    assert.equal(pack.get(key(1)), 'one')
    await pack.finish()
    pack.start()
    assert.equal(pack.get(key(1)), null)
    await pack.finish()
  })

  it('writes the segments as one, of as many as it has, of those the build asked for', async () => {
    const dir = join(root, 'c')
    for (let n = 0; n < 8; n++) await build(dir, { set: [[n, n]] })
    assert.equal(segments(dir).length, 8)
    await build(dir, { ask: [1, 2], set: [[9, 9]] })
    assert.equal(segments(dir).length, 1)
    assert.deepEqual(await build(dir, { ask: [0, 1, 2, 9] }), [null, 1, 2, 9])
  })

  it('reads what is whole of a segment cut short', async () => {
    const dir = join(root, 'd')
    await build(dir, { set: [[1, 'one'], [2, 'two']] })
    const [name] = segments(dir)
    const buffer = readFileSync(join(dir, name))
    writeFileSync(join(dir, name), buffer.subarray(0, buffer.length - 2))
    assert.deepEqual(await build(dir, { ask: [1, 2] }), ['one', null])
  })
})

describe('pause', () => {
  it('gives the event loop its turn of work that ran on so long, and not before', async () => {
    await pause()
    let turned = false
    setImmediate(() => (turned = true))
    assert.equal(pause(), null)
    for (const end = performance.now() + 25; performance.now() < end; );
    await pause()
    assert.equal(turned, true)
  })
})
