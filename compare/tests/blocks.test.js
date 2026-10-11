import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { changeSet } from '@preventive/diff'
import { blocksHold, markedBlocks } from '../compare.js'
import { random } from './random.js'

const ranges = (blocks) => blocks.map(({ a0, a1, b0, b1 }) => ({ a0, a1, b0, b1 }))
const blocksOf = (before, after, options) => ranges(changeSet(before, after, { horizon: 0, ...options }))

describe('blocksHold', () => {
  it('takes a change set that carries one text to another, and refuses any that would hide a change', () => {
    const after = 'a\nB\nc\nd\ne\n', before = 'a\nb\nc\nd\n'
    const blocks = blocksOf(before, after)
    assert.deepEqual(blocks, [{ a0: 1, a1: 2, b0: 1, b1: 2 }, { a0: 4, a1: 4, b0: 4, b1: 5 }])
    assert.equal(blocksHold(before, after, blocks), true)
    for (const [label, wrong] of [
      ['none', []],
      ['one left out', blocks.slice(1)],
      ['moved a line', blocks.map((block) => ({ ...block, a0: block.a0 + 1, a1: block.a1 + 1 }))],
      ['out of order', blocks.toReversed()],
      ['past the end', [...blocks, { a0: 4, a1: 5, b0: 5, b1: 6 }]],
      ['changing nothing', [{ a0: 0, a1: 0, b0: 0, b1: 0 }, ...blocks]],
      ['a changed line left between', [{ a0: 2, a1: 3, b0: 2, b1: 3 }, blocks[1]]],
      ['a count no number', [{ ...blocks[0], a0: '1' }, blocks[1]]],
      ['a count no whole number', [{ ...blocks[0], a1: 1.5 }, blocks[1]]],
      ['a count below zero', [{ a0: -1, a1: 2, b0: -1, b1: 2 }, blocks[1]]],
      ['no block', [null, ...blocks]],
      ['no list', null],
      ['a list of another kind', { length: 0 }],
    ]) assert.equal(blocksHold(before, after, wrong), false, label)
    assert.equal(blocksHold('a b\n', 'ab\n', [], { whitespace: 'all' }), true, 'whitespace ignored, as diff -w ignores it')
    assert.equal(blocksHold('a b\n', 'ab\n', []), false)
    assert.equal(blocksHold('A\n', 'a\n', [], { ignoreCase: true }), true)
    assert.equal(blocksHold('', '', []), true)
    assert.equal(blocksHold('', 'x\n', [{ a0: 0, a1: 0, b0: 0, b1: 1 }]), true)
    assert.throws(() => blocksHold('', '', [], { whitespace: 'some' }), RangeError, 'options checked as compareLines checks them')
  })

  it('takes a newline dropped after the last line for a change of that line, but under -w', () => {
    assert.deepEqual(blocksOf('a\nx', 'a\nx\n'), [{ a0: 1, a1: 2, b0: 1, b1: 2 }])
    assert.equal(blocksHold('a\nx', 'a\nx\n', blocksOf('a\nx', 'a\nx\n')), true)
    for (const [old, now] of [['a\nx', 'a\nx\n'], ['x\n', 'x'], ['a\nx', 'b\nx\n']]) {
      assert.equal(blocksHold(old, now, old.startsWith('a') === now.startsWith('a') ? [] : [{ a0: 0, a1: 1, b0: 0, b1: 1 }]), false, `${JSON.stringify(old)} -> ${JSON.stringify(now)}: its newline left out`)
    }
    assert.equal(blocksHold('a\nx', 'a\nx\n', [], { whitespace: 'all' }), true, 'as diff -w ignores it')
  })

  it('takes every change set the diff finds, for texts made at random, some ending in no newline', () => {
    const { next } = random(7)
    const text = () => {
      const lines = Array.from({ length: Math.floor(next() * 12) }, () => ['a', 'b', ' a', 'a ', 'c d', 'cd', ''][Math.floor(next() * 7)]).map((line) => `${line}\n`).join('')
      return next() < 0.3 ? lines.slice(0, -1) : lines
    }
    for (let i = 0; i < 400; i++) {
      const [before, after] = [text(), text()]
      for (const whitespace of ['none', 'all', 'change', 'trailing']) {
        assert.ok(blocksHold(before, after, blocksOf(before, after, { whitespace }), { whitespace }), JSON.stringify({ before, after, whitespace }))
      }
    }
  })
})

describe('markedBlocks', () => {
  it('marks the blocks whose lines differ in renamed names alone, as the given text has them', () => {
    const after = 'f(b);\nh();\ng(2);\n', before = 'f(a);\nh();\ng(1);\n'
    assert.deepEqual(markedBlocks(before, 'f(b);\nh();\ng(1);\n', after, { horizon: 0 }), [{ a0: 0, a1: 1, b0: 0, b1: 1 }])
    assert.deepEqual(markedBlocks('f(a);\ng(a);\n', 'f(b);\ng(b);\n', 'f(b);\ng(b);'), [], 'none where a newline was dropped after the last line')
    assert.deepEqual(markedBlocks('f(a);\ng(a);\n', 'f(b);\ng(b);\n', 'f(b);\ng(b);', { whitespace: 'all' }), [{ a0: 0, a1: 2, b0: 0, b1: 2 }], 'but under -w, which takes the newline for whitespace')
    assert.deepEqual(markedBlocks('f(a ,x);\n', 'f(b ,x);\n', 'f(b, x);\n', { whitespace: 'all' }), [{ a0: 0, a1: 1, b0: 0, b1: 1 }], 'under -w, spacing changed besides')
    assert.deepEqual(markedBlocks('f(a ,x);\nq;\n', 'f(b ,x);\nq;\n', 'f(b, x);\nr;\n', { whitespace: 'all', horizon: 0 }), [], 'one alike under -w in a block with a change')
    assert.deepEqual(markedBlocks('f(a ,x);\nq;\n', 'f(b ,x);\nq;\n', 'f(b, x);\nq;\n', { horizon: 0 }), [], 'and no whitespace ignored unasked')
    assert.equal(markedBlocks('f(a);\n', 'f(b);\ng();\n', 'f(b);\n'), null, 'a renamed text of other lines')
  })
})
