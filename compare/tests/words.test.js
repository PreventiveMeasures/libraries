import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { changeSet } from '@preventive/diff'
import { hidesMixedWhitespace, pairLines, wordRanges } from '../compare.js'
import { random } from './random.js'

// Short lines of a few words, blanks and marks, some invisible or a lone surrogate.
function lines(seed) {
  const { next } = random(seed)
  const words = ['a', 'b', 'f', 'x1', ' ', '  ', '\t', '(', ')', '.', '=', String.fromCodePoint(0xE9), String.fromCodePoint(0x200B), String.fromCodePoint(0xD800)]
  return () => Array.from({ length: Math.floor(next() * 14) }, () => words[Math.floor(next() * words.length)]).join('')
}

describe('wordRanges', () => {
  it('marks what changed inside a paired line', () => {
    assert.deepEqual(wordRanges('const total = sum(a, b)', 'const total = sum(a, c)'), { a: [[21, 22]], b: [[21, 22]] })
    assert.deepEqual(wordRanges('return foo bar', 'return baz qux'), { a: [[7, 14]], b: [[7, 14]] }, 'ranges split only by whitespace merge')
    assert.equal(wordRanges('alpha beta gamma', 'one two three'), null, 'a line mostly replaced is not worth marking')
    assert.equal(wordRanges('x'.repeat(5000), 'y'), null)
    assert.deepEqual(wordRanges('same', 'same'), { a: [], b: [] }, 'lines the same have none, not null')
    assert.deepEqual(wordRanges('a = b', 'a =  b'), { a: [[3, 4]], b: [[3, 5]] }, 'blanks changed are marked')
    assert.equal(wordRanges('', 'new code'), null, 'lines that share nothing are no line edited')
    assert.deepEqual(wordRanges('f(a)', 'f(a, b)'), { a: [], b: [[3, 6]] }, 'but a line added to is')
  })

  it('marks every character that changed, for lines made at random', () => {
    const line = lines(3)
    // What is left of a line outside its ranges, blanks aside, as merging takes some in.
    const kept = (text, ranges) => ranges.reduceRight((rest, [from, to]) => rest.slice(0, from) + rest.slice(to), text).replaceAll(/\s/gu, '')
    for (let i = 0; i < 3000; i++) {
      const [left, right] = [line(), line()]
      const words = wordRanges(left, right)
      if (words === null) continue
      for (const [text, ranges] of [[left, words.a], [right, words.b]]) {
        assert.ok(ranges.every(([from, to], at) => from < to && to <= text.length && (at === 0 || ranges[at - 1][1] < from)), JSON.stringify({ left, right, words }))
      }
      assert.equal(kept(left, words.a), kept(right, words.b), JSON.stringify({ left, right, words }))
      if (left !== right) assert.ok(words.a.length + words.b.length > 0, JSON.stringify({ left, right }))
    }
  })
})

describe('pairLines', () => {
  it('pairs a removed line with the added line it was edited into, the lines between running unpaired', () => {
    assert.deepEqual(pairLines(['  const rows = query.all({ limit: 50 })'], ['  const limit = Math.min(Number(req.query.limit) || 50, 200)', '  const rows = query.all({ limit })']), [[0, 1]],
      'the second added line, not the first')
    assert.deepEqual(pairLines(['b', 'c'], ['B', 'C2', 'C3']), [], 'unrelated lines pair with none')
    assert.deepEqual(pairLines(['f(a)', 'g(b)'], ['f(c)', 'g(b)!']), [[0, 0], [1, 1]], 'in order')
    assert.deepEqual(pairLines(['', 'f(a)'], ['f(b)']), [[1, 0]], 'a blank line takes no line from the one edited into it')
    assert.deepEqual(pairLines(['f(a)', 'f(b)'], ['f(b)']), [[1, 0]], 'the more alike of two')
    assert.deepEqual(pairLines(['f(a, bb)', 'unrelated', 'f(dddd, ccc)'], ['f(a, ccc)', 'f(dddd, a)']), [[0, 0], [2, 1]], 'the most pairs')
    assert.deepEqual(pairLines(['f(a)', 'g(x)', 'f(b)', 'h(y)'], ['g(x)', 'f(b)', 'h(y)']), [[1, 0], [2, 1], [3, 2]])
    assert.deepEqual(pairLines(['f(b)', ...Array.from({ length: 50 }, (_, k) => `u${k}`)], [...Array.from({ length: 50 }, (_, k) => `w${k}`), 'f(b)']), [[0, 50]], 'however far apart')
    assert.deepEqual(pairLines(['foo          bar'], ['one          two']), [], 'blanks between two changes being no more kept than a word view keeps them')
    assert.deepEqual(pairLines(['  foo'], ['  bar']), [[0, 0]], 'but blanks before the first')
    assert.deepEqual(pairLines(['x,two,o'], ['two(x,']), [[0, 0]], 'and as wordRanges finds the words kept, of scripts as short')
  })

  it('looks ahead alone where weighing every pair would take too long, still pairing in order', () => {
    // Long lines all alike: each pair a long script, more of them than the budget weighs.
    const line = (k, mark) => Array.from({ length: 390 }, (_, t) => ((t * 7 + k) % 13 === 0 ? `q${k}${mark}` : `w${t % 50}`)).join(' ')
    const news = Array.from({ length: 40 }, (_, k) => line(k, 'x')), olds = Array.from({ length: 40 }, (_, k) => line(k, ''))
    const start = performance.now()
    assert.deepEqual(pairLines(olds, news), olds.map((_, k) => [k, k]))
    assert.ok(performance.now() - start < 2000)
  })

  it('pairs each line once, in order, and two lines just where a word view marks them, for lines made at random', () => {
    const line = lines(5)
    for (let i = 0; i < 300; i++) {
      const news = Array.from({ length: (i * 7) % 9 }, line), olds = Array.from({ length: i % 9 }, line)
      const pairs = pairLines(olds, news)
      assert.ok(pairs.every(([a, b], at) => a < olds.length && b < news.length && (at === 0 || (pairs[at - 1][0] < a && pairs[at - 1][1] < b))), JSON.stringify({ olds, news, pairs }))
      assert.ok(pairs.every(([a, b]) => wordRanges(olds[a], news[b]) !== null), JSON.stringify({ olds, news, pairs }))
    }
    for (let i = 0; i < 3000; i++) {
      const [old, fresh] = [line(), line()]
      assert.equal(pairLines([old], [fresh]).length, Number(wordRanges(old, fresh) !== null), JSON.stringify([old, fresh]))
    }
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

  it('takes blocks that do not carry one text to the other under -w to hide, as they may hide anything', () => {
    assert.equal(hidesMixedWhitespace('a\nb\n', 'a\nc\n', []), true, 'a change left out')
    assert.equal(hidesMixedWhitespace('  a\nb\n', '\ta\nb\n', [{ a0: 1, a1: 2, b0: 1, b1: 2 }]), true, 'and a block that changes nothing')
    assert.equal(hidesMixedWhitespace('    a\nb\n', '\ta\nb\n', changeSet('    a\nb\n', '\ta\nb\n', { horizon: 0 })), false, 'but blocks found without -w, which hide nothing')
  })
})
