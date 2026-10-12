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
    for (const [text, formatted, what] of [['a()/* a b */', 'a(); /* ab */\n', 'whitespace in a comment'], ['a()// x(y)', 'a(); // xy\n', 'parentheses in one'],
      ["a()// 'x'", 'a(); // "x"\n', 'quotes in one']]) assert.equal(sameCode(text, formatted), false, what)
    assert.equal(sameCode('{"x":"a b","y":1.50}', '{ "x": "a b", "y": 1.5 }\n', 'json'), true)
    for (const [text, formatted] of [['{"x":"a b"}', '{ "x": "ab" }\n'], ['{"x":"1.50"}', '{ "x": "1.5" }\n'], ['{"x":1}', '{ "x": 1 } // c\n']]) assert.equal(sameCode(text, formatted, 'json'), false, text)
  })

  it('compares CSS but for its keywords\' case and spaces no selector needs', () => {
    assert.equal(sameCode('A[class*=x]{COLOR:RED}', 'a[class*="x"] {\n  color: red;\n}\n'), false)
    assert.equal(sameCode('A[class*=x]{COLOR:RED}', 'a[class*="x"] {\n  color: red;\n}\n', 'css'), true)
    assert.equal(sameCode("@media(min-width:1px){a>b,.c .d{src:url(x)format('woff');margin:0 .5EM}}",
      '@media (min-width: 1px) {\n  a > b,\n  .c .d {\n    src: url(x) format("woff");\n    margin: 0 0.5em;\n  }\n}\n', 'css'), true)
    for (const [text, formatted, what] of [['.a .b{}', '.a.b {\n}\n', 'a descendant made a compound'], ['* .a{}', '*.a {\n}\n', 'and after `*`'],
      ['a{content:"a b"}', 'a {\n  content: "ab";\n}\n', 'a string\'s spaces'], ['a{content:"A"}', 'a {\n  content: "a";\n}\n', 'its case'],
      ['a{b:c;d:e}', 'a {\n  b: cd: e;\n}\n', 'two declarations made one']]) assert.equal(sameCode(text, formatted, 'css'), false, what)
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
