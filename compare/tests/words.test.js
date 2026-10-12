import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { changeSet } from '@preventive/diff'
import { hidesMixedWhitespace, pairLines, renamedAlone, wordRanges } from '../compare.js'

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

describe('renamedAlone', () => {
  it('takes two lines for renamed alone where they differ in short names alone, by a reading of its own', () => {
    assert.equal(renamedAlone('f(a, b);', 'f(c, d);'), true)
    for (const [before, after] of [['x.ab = 1;', 'x.cd = 1;'], ['f("ab");', 'f("cd");'], ['for (a in b)', 'for (a of b)'], ['{ ab: 1 }', '{ cd: 1 }'],
      ['return a + 1;', 'return a + 2;'], ['var abcd;', 'var efgh;'], ['f(a);', 'f(a);'], ['f(a) // ab', 'f(a) // cd'], ['f(a ,b)', 'f(a, b)'],
      ['a.replace(/ab/g, b)', 'a.replace(/cd/g, b)'], ['if (a) /x[/]ab/.test(b);', 'if (a) /x[/]cd/.test(b);'], ['return /ab/;', 'return /cd/;'],
      ['f((a) / b);', 'f((c) / d);'], ['a ? b : c', 'a ? d : c'], ['this.#ab', 'this.#cd']]) {
      assert.equal(renamedAlone(before, after), false, `${before} -> ${after}`)
    }
    assert.equal(renamedAlone('f(a ,b)', 'f(c, d)', { whitespace: 'all' }), true, 'whitespace ignored under -w')
    assert.equal(renamedAlone('f(a ,b)', 'f(c, d)', { whitespace: 'change' }), false, 'and compared otherwise')
    for (const [before, after] of [['f(a / b, c[0] / 2);', 'f(d / e, g[0] / 2);'], ['x = this.n / a;', 'x = this.n / b;']]) assert.equal(renamedAlone(before, after), true, `${before} -> ${after}: a division`)
    assert.equal(renamedAlone('f(a) /* x', 'f(b) /* y'), false, 'a comment unclosed runs to the end')
    for (const [before, after] of [['class X{a(){}}', 'class X{b(){}}'], ['x={a(c){return c}}', 'x={b(c){return c}}'], ['class X{get a(){}}', 'class X{get b(){}}'], ['class X{*a(){}}', 'class X{*b(){}}']]) {
      assert.equal(renamedAlone(before, after), false, `${before} -> ${after}: a method`)
    }
    for (const [before, after] of [['return {a}', 'return {b}'], ['const {a}=x', 'const {b}=x'], ['f({a,c})', 'f({b,c})'], ['const{a=1}=x', 'const{b=1}=x'], ['export{a}', 'export{b}']]) {
      assert.equal(renamedAlone(before, after), false, `${before} -> ${after}: a shorthand property`)
    }
    for (const [before, after] of [['class X{a=1}', 'class X{b=1}'], ['x=class extends Y{m(){}a;c=2}', 'x=class extends Y{m(){}b;c=2}'], ['class X{static a=1}', 'class X{static b=1}']]) {
      assert.equal(renamedAlone(before, after), false, `${before} -> ${after}: a public field`)
    }
    for (const [before, after] of [['if(x){a}', 'if(x){b}'], ['if(x){a=1}', 'if(x){b=1}'], ['y=>{a,c}', 'y=>{b,c}'], ['x={c:a}', 'x={c:b}'], ['function a(){}', 'function b(){}'], ['function*a(c){}', 'function*b(c){}'], ['if(a(c)){d()}', 'if(b(c)){d()}']]) assert.equal(renamedAlone(before, after), true, `${before} -> ${after}`)
    const line = `a${'/*a'.repeat(50_000)}`, start = performance.now()
    renamedAlone(line, `b${line.slice(1)}`)
    assert.ok(performance.now() - start < 2000, 'in time linear in its length')
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
