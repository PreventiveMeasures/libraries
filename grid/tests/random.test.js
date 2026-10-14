import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { hashSeed, paginate, random, shuffle } from '../src/random.js'

describe('seeded shuffling', () => {
  it('is deterministic for a seed and differs across seeds', () => {
    const items = Array.from({ length: 50 }, (_, i) => i)
    const a = shuffle(items, random(hashSeed('one')))
    const b = shuffle(items, random(hashSeed('one')))
    const c = shuffle(items, random(hashSeed('two')))
    assert.deepEqual(a, b)
    assert.notDeepEqual(a, c)
    assert.deepEqual([...a].sort((x, y) => x - y), items)
    assert.deepEqual(items, Array.from({ length: 50 }, (_, i) => i), 'the input is not reordered')
  })

  it('hashSeed spreads nearby strings', () => {
    const seeds = new Set(['a', 'b', 'ab', 'ba', '', 'aa'].map(hashSeed))
    assert.equal(seeds.size, 6)
    assert.ok([...seeds].every((seed) => Number.isInteger(seed) && seed >= 0 && seed < 2 ** 32))
  })
})

describe('paginate', () => {
  it('pages by count', () => {
    assert.deepEqual(paginate([1, 2, 3, 4, 5], { size: 2 }), [[1, 2], [3, 4], [5]])
    assert.deepEqual(paginate([], { size: 2 }), [])
  })

  it('pages by weight, giving an overweight item a page of its own', () => {
    const items = ['aa', 'bbb', 'c', 'dddddddd', 'e']
    assert.deepEqual(paginate(items, { maxWeight: 5, weigh: (s) => s.length }), [['aa', 'bbb'], ['c'], ['dddddddd'], ['e']])
  })

  it('honours both bounds at once', () => {
    assert.deepEqual(paginate(['a', 'b', 'c', 'd'], { size: 3, maxWeight: 2, weigh: () => 1 }), [['a', 'b'], ['c', 'd']])
  })
})
