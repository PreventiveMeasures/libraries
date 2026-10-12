import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { changeSet } from '@preventive/diff'
import { hidesMixedWhitespace, pairLines, wordRanges } from '../compare.js'

describe('wordRanges', () => {
  it('marks what changed inside a paired line', () => {
    assert.deepEqual(wordRanges('const total = sum(a, b)', 'const total = sum(a, c)'), { a: [[21, 22]], b: [[21, 22]] })
    assert.deepEqual(wordRanges('return foo bar', 'return baz qux'), { a: [[7, 14]], b: [[7, 14]] }, 'ranges split only by whitespace merge')
    assert.equal(wordRanges('alpha beta gamma', 'one two three'), null, 'a line mostly replaced is not worth marking')
    assert.equal(wordRanges('x'.repeat(5000), 'y'), null)
    assert.equal(wordRanges('same', 'same'), null)
  })
})

describe('pairLines', () => {
  it('pairs a removed line with the added line it was edited into, the lines between running unpaired', () => {
    assert.deepEqual(pairLines(['  const rows = query.all({ limit: 50 })'], ['  const limit = Math.min(Number(req.query.limit) || 50, 200)', '  const rows = query.all({ limit })']), [[0, 1]],
      'the second added line, not the first')
    assert.deepEqual(pairLines(['b', 'c'], ['B', 'C2', 'C3']), [], 'unrelated lines pair with none')
    assert.deepEqual(pairLines(['f(a)', 'g(b)'], ['f(c)', 'g(b)!']), [[0, 0], [1, 1]], 'in order')
    assert.deepEqual(pairLines(Array.from({ length: 201 }, () => 'f(a)'), ['f(b)']), [], 'past 200 lines, none')
  })
})

describe('hidesMixedWhitespace', () => {
  it('tells where diff -w hides blanks of more than one kind changing between the same two characters', () => {
    const hides = (before, after) => hidesMixedWhitespace(before, after, changeSet(before, after, { horizon: 0, whitespace: 'all' }))
    for (const [before, after] of [['    a()\n', '\ta()\n'], ['f(a, b)\n', 'f(a,\tb)\n'], ['x = 1\n', 'x =\t 1\n'], ['\t x\n', '\t  x\n'], ['a\n  b\nc\n', 'a\n\tb\nc\n'],
      ['x  \r\n', 'x\n']]) assert.equal(hides(before, after), true, JSON.stringify([before, after]))
    for (const [before, after] of [['  a()\n', '    a()\n'], ['\t\ta()\n', '\ta()\n'], ['f(a,b)\n', 'f(a, b)\n'], ['x\r\n', 'x\n'], ['a\n', 'a\n'], ['a\n', 'b\n'],
      ['  a\n', '\tb\n']]) assert.equal(hides(before, after), false, JSON.stringify([before, after]))
  })
})
