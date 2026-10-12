import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { minifySync } from 'oxc-minify'
import { formatChecked, sameCode } from '../pretty.js'

describe('sameCode', () => {
  it('takes what formatting may respell: whitespace, quotes, parentheses, semicolons, numbers', () => {
    assert.equal(sameCode(
      "var a='x',b='it\\'s';f(x=>x);a=1,b=2;x={'a':1};var n=.5,m=1E+3,k=1.50;!(a||b)||(c||d);new Foo",
      'var a = "x",\n  b = "it\'s";\nf((x) => x);\n((a = 1), (b = 2));\nx = { "a": 1 };\nvar n = 0.5,\n  m = 1e3,\n  k = 1.5;\n!(a || b) || c || d;\nnew Foo();\n'), true)
    assert.equal(sameCode('a=/x/img.test(s)', 'a = /x/gim.test(s);\n'), true, 'flags in order')
    assert.equal(sameCode(';!function(){}()', '!(function () {})();\n'), true, 'an empty statement dropped, an expression wrapped')
    assert.equal(sameCode('a&&(b&&c)', 'a && b && c;\n'), true, 'a chain of one operator regrouped')
    assert.equal(sameCode('const x:number=(a as any)+1', 'const x: number = (a as any) + 1;\n', 'ts'), true)
  })

  it('refuses anything else, as two checks apart from the formatter find', () => {
    for (const [output, what] of [['a = b + c;', 'an operator'], ['a = b;', 'a name'], ['a = c - b;', 'the order'], ['a = b - c; d;', 'an addition'],
      ['a = b - 2;', 'a name for a number'], ['a = "b" - c;', 'a name for a string']]) {
      assert.equal(sameCode('a=b-c', output), false, what)
    }
    assert.equal(sameCode('a=/x/im', 'a = /x/gim;\n'), false, 'a flag')
    assert.equal(sameCode('a=1.5', 'a = 1.25;\n'), false, 'a number')
    assert.equal(sameCode('a()/* keep me */', 'a();\n'), false, 'a comment')
    // What reads alike once parentheses and semicolons are set aside, but means otherwise.
    assert.equal(sameCode('x = (a + b) * c\n', 'x = a + b * c\n'), false, 'parentheses that group')
    assert.equal(sameCode('a\n(b)\n', 'a;\n(b);\n'), false, 'a call split in two')
    assert.equal(sameCode('let x = 1\n[y] = z\n', 'let x = 1;\n[y] = z;\n'), false, 'a member read made a statement')
    assert.equal(sameCode('(a?.b).c\n', 'a?.b.c\n'), false, 'an optional chain extended')
    assert.equal(sameCode('a&&(b||c)', 'a && b || c;\n'), false, 'chains of two operators regrouped')
    assert.equal(sameCode('const x:number=a', 'const x: string = a;\n', 'ts'), false)
    assert.equal(sameCode('f(', 'f(\n'), false, 'text that does not parse')
  })

  it('compares strings and comments as written, but for quotes and a comment\'s indentation', () => {
    assert.equal(sameCode('/**\n     * a  b\n     */\nf()//x(y)', '/**\n * a  b\n */\nf(); //x(y)\n'), true)
    for (const [text, formatted, what] of [['a()/* a b */', 'a(); /* ab */\n', 'a space in a comment'], ['a()/* A  B */', 'a(); /* A B */\n', 'spaces within one of its lines'],
      ['a()// x(y)', 'a(); // xy\n', 'parentheses in one'], ["a()// 'x'", 'a(); // "x"\n', 'quotes in one']]) assert.equal(sameCode(text, formatted), false, what)
    assert.equal(sameCode('a{/* columns: A  B */x:y}', 'a {\n  /* columns: A B */\n  x: y;\n}\n', 'css'), false)
    assert.equal(sameCode('{"x":"a b","y":1.50}', '{ "x": "a b", "y": 1.5 }\n', 'json'), true)
    for (const [text, formatted] of [['{"x":"a b"}', '{ "x": "ab" }\n'], ['{"x":"1.50"}', '{ "x": "1.5" }\n'], ['{"x":1}', '{ "x": 1 } // c\n']]) assert.equal(sameCode(text, formatted, 'json'), false, text)
  })

  it('compares CSS but for the case formatting lowers and spaces no selector needs', () => {
    const text = 'A:HOVER,.Foo:NOT(.Bar)[class*=x]{COLOR:RED;--Brand:#ABC;background:#ABC;margin:.5EM!IMPORTANT}@MEDIA SCREEN AND (MAX-WIDTH:10PX){a{b:c}}'
    const formatted = 'A:hover,\n.Foo:not(.Bar)[class*="x"] {\n  color: RED;\n  --Brand: #abc;\n  background: #abc;\n  margin: 0.5em !important;\n}\n'
      + '@media screen and (max-width: 10px) {\n  a {\n    b: c;\n  }\n}\n'
    assert.equal(sameCode(text, formatted, 'css'), true, "oxfmt's own output")
    assert.equal(sameCode(text, formatted), false, 'not as a script')
    assert.equal(sameCode("@media(min-width:1px){a>b,.c .d{src:url(x)format('woff');margin:0 .5EM}}",
      '@media (min-width: 1px) {\n  a > b,\n  .c .d {\n    src: url(x) format("woff");\n    margin: 0 0.5em;\n  }\n}\n', 'css'), true)
    for (const [before, after, what] of [['.a .b{}', '.a.b {\n}\n', 'a descendant made a compound'], ['* .a{}', '*.a {\n}\n', 'and after `*`'],
      ['a{content:"a b"}', 'a {\n  content: "ab";\n}\n', 'a string\'s spaces'], ['a{content:"A"}', 'a {\n  content: "a";\n}\n', 'its case'],
      ['a{b:c;d:e}', 'a {\n  b: cd: e;\n}\n', 'two declarations made one'], [':root{--Brand:red}', ':root {\n  --brand: red;\n}\n', 'a custom property\'s case'],
      ['.Foo{a:b}', '.foo {\n  a: b;\n}\n', 'a class\'s'], ['.col-2XL{a:b}', '.col-2xl {\n  a: b;\n}\n', 'one that looks like a unit'], ['#Face{a:b}', '#face {\n  a: b;\n}\n', 'an id\'s'], ['a{animation:Spin}', 'a {\n  animation: spin;\n}\n', 'a value\'s'],
      ['a{b:url(A.png)}', 'a {\n  b: url(a.png);\n}\n', 'a URL\'s'], ['clipPath{a:b}', 'clippath {\n  a: b;\n}\n', 'an element\'s'],
      ['#ABC[x=";"]{a:b}', '#abc[x=";"] {\n  a: b;\n}\n', 'an id\'s, a string read past'], ['@media /* KEEP */ screen{a{x:y}}', '@media /* keep */ screen {\n  a {\n    x: y;\n  }\n}\n', 'a comment\'s in a query'],
      ['@supports (--Foo:1){a{x:y}}', '@supports (--foo: 1) {\n  a {\n    x: y;\n  }\n}\n', 'a custom property\'s in one'],
      ['a{x:calc(1px + 2px)}', 'a {\n  x: calc(1px+2px);\n}\n', 'the spaces calc() needs']]) assert.equal(sameCode(before, after, 'css'), false, what)
    assert.equal(sameCode('a+b,a:NTH-CHILD(2N+1){x:calc(1px + 2px)}', 'a + b,\na:nth-child(2n + 1) {\n  x: calc(1px + 2px);\n}\n', 'css'), true, 'a selector\'s `+` spaced')
  })

  it('reads text in time linear in its length', () => {
    const start = performance.now()
    for (const text of ['a:b'.repeat(100_000) + '{c:d}', `a{${'b:c'.repeat(100_000)}}`, '/*'.repeat(100_000), `a${' '.repeat(300_000)}b{}`, `[a=${' '.repeat(300_000)}b]{}`, `/*${' '.repeat(300_000)}*/`]) {
      sameCode(text, text, 'css')
    }
    sameCode('/*'.repeat(100_000), '/*'.repeat(100_000), 'json')
    assert.ok(performance.now() - start < 5000)
  })

  it('takes no other kind of file', () => {
    assert.equal(sameCode('a', 'a', 'md'), false)
    assert.equal(sameCode('a: 1', 'a: 1', 'yaml'), false)
  })
})

describe('formatChecked', () => {
  it('formats a minified file, leaving template literals as they are', async () => {
    const { code } = await formatChecked('const a=css`a{color:red}`;function f(x){return x+1}', 'js')
    assert.ok(code.split('\n').length > 3)
    assert.match(code, /css`a\{color:red\}`/u)
  })

  it('answers why where it does not', async () => {
    assert.deepEqual(await formatChecked('function (', 'js'), { error: 'unformattable' })
  })

  it('takes published code minified as it is formatted', async () => {
    for (const file of ['src/names/analyze.js', 'src/renames.js', 'src/layout.js']) {
      const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
      const { code, errors } = minifySync('file.mjs', source, { compress: false, mangle: { toplevel: true }, codegen: { removeWhitespace: true } })
      assert.deepEqual(errors, [])
      const formatted = await formatChecked(code, 'mjs')
      assert.ok('code' in formatted, file)
      assert.ok(formatted.code.split('\n').length > 50, file)
    }
  })
})
