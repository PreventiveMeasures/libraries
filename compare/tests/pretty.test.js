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

  it('compares CSS without quotes or case, and other text as it is', () => {
    assert.equal(sameCode('A[class*=x]{COLOR:RED}', 'a[class*="x"] {\n  color: red;\n}\n'), false)
    assert.equal(sameCode('A[class*=x]{COLOR:RED}', 'a[class*="x"] {\n  color: red;\n}\n', 'css'), true)
    assert.equal(sameCode('{"a":[1,2]}', '{ "a": [1, 2] }\n', 'json'), true)
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
