import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import * as csstree from 'css-tree'
import { minifySync } from 'oxc-minify'
import { format } from '../pretty.js'
import { sameCode } from '../src/pretty.js'

const sameCss = (text, formatted) => sameCode(text, formatted, 'css', csstree)
// A name's escape as a file writes it.
const esc = (hex) => `\\u${hex}`

describe('sameCode', () => {
  it('takes what formatting may respell: whitespace, quotes, parentheses, semicolons, numbers', () => {
    assert.equal(sameCode(
      "var a='x',b='it\\'s';f(x=>x);a=1,b=2;x={'a':1};var n=.5,m=1E+3,k=1.50;!(a||b)||(c||d);new Foo",
      'var a = "x",\n  b = "it\'s";\nf((x) => x);\n((a = 1), (b = 2));\nx = { "a": 1 };\nvar n = 0.5,\n  m = 1e3,\n  k = 1.5;\n!(a || b) || c || d;\nnew Foo();\n'), true)
    assert.equal(sameCode('a=/x/img.test(s)', 'a = /x/gim.test(s);\n'), true, 'flags in order')
    assert.equal(sameCode('x=!0,y=!1;f(!(0),-!1)', '((x = true), (y = false));\nf(true, -false);\n'), true, '`!0` and `!1` as the literals they read as')
    assert.equal(sameCode('a=/x/yu\nb=/y/ig', 'a = /x/uy;\nb = /y/gi;\n'), true, 'and ending a statement, the next one\'s name after')
    assert.equal(sameCode('x=a/ig;b', 'x = a / ig;\nb;\n'), true, 'a name divided by, as written')
    assert.equal(sameCode(';!function(){}()', '!(function () {})();\n'), true, 'an empty statement dropped, an expression wrapped')
    assert.equal(sameCode('a&&(b&&c)', 'a && b && c;\n'), true, 'a chain of one operator regrouped')
    assert.equal(sameCode('const x:number=(a as any)+1', 'const x: number = (a as any) + 1;\n', 'ts'), true)
    assert.equal(sameCode('import{a,b,}from"m";f(a,b,);x={a,b,};y=[a,b,]', 'import { a, b } from "m";\nf(a, b);\nx = { a, b };\ny = [a, b];\n'), true, 'trailing commas dropped')
    assert.equal(sameCode('y=[1,// one\n2,// two\n]', 'y = [\n  1, // one\n  2 // two\n];\n'), true, 'and before a comment')
    assert.equal(sameCode('type P=A|B|C;let x:(A|B)[];f<A|B>();g(x as {a:1}|null)', 'type P =\n  | A\n  | B\n  | C;\nlet x: (\n  | A\n  | B\n)[];\nf<\n  | A\n  | B\n>();\ng(\n  x as\n    | { a: 1 }\n    | null\n);\n', 'ts'), true,
      'a union broken over lines, each part led by `|`')
    assert.equal(sameCode('type I=A&B;type M={[K in A|B]:1}', 'type I =\n  & A\n  & B;\ntype M = {\n  [K in\n    | A\n    | B]: 1;\n};\n', 'ts'), true, 'an intersection led by `&`, a mapped type\'s keys by `|`')
    assert.equal(sameCode('a()// x  \nb()/* y */', 'a(); // x\nb(); /* y */\n'), true, 'blanks ending a comment')
    const members = `type T = { ${Array.from({ length: 130_000 }, (_, i) => `a${i}: 1,`).join(' ')} };\n`, statements = `${Array.from({ length: 130_000 }, (_, i) => `let a${i} = 0;`).join('\n')}\n`
    assert.equal(sameCode(statements, statements, 'ts'), true, 'more statements than a call takes arguments')
    assert.equal(sameCode(members, members, 'ts'), true, 'and more members')
    assert.equal(sameCode('type T={a:string,b?:number};interface I{c:1,d():void}', 'type T = { a: string; b?: number };\ninterface I {\n  c: 1;\n  d(): void;\n}\n', 'ts'), true,
      'a type\'s members separated by `;` for `,`')
  })

  it('refuses anything else, as two checks apart from the formatter find', () => {
    for (const [output, what] of [['a = b + c;', 'an operator'], ['a = b;', 'a name'], ['a = c - b;', 'the order'], ['a = b - c; d;', 'an addition'],
      ['a = b - 2;', 'a name for a number'], ['a = "b" - c;', 'a name for a string']]) {
      assert.equal(sameCode('a=b-c', output), false, what)
    }
    assert.equal(sameCode('a=/x/im', 'a = /x/gim;\n'), false, 'a flag')
    for (const [text, formatted, what] of [['x=!0', 'x = false;\n', '`!0` as `false`'], ['x=!1', 'x = true;\n', '`!1` as `true`'], ['x=!2', 'x = false;\n', 'another number'],
      ['x=!0n', 'x = true;\n', 'a BigInt'], ['x="!0"', 'x = "true";\n', 'a string'], ['x=!!0', 'x = true;\n', 'one `!` more'],
      ['function f(){return!0}', 'function f() {\n  returntrue;\n}\n', 'run on into the word before']]) assert.equal(sameCode(text, formatted), false, what)
    assert.equal(sameCode('const a=!0', 'const a = true;\n', 'ts'), false, 'nor in a typed script, as TypeScript types `true` otherwise')
    assert.equal(sameCode('x=a/ig;b', 'x = a / gi;\nb;\n'), false, 'a name\'s letters sorted as flags would be')
    assert.equal(sameCode(`var ${esc('0061')}=1`, 'var a = 1;\n'), false, 'a name\'s escape read')
    assert.equal(sameCode('x=a&&/* c */\nb', 'x = a /* c */ && b;\n'), false, 'a comment moved before the operator it followed')
    assert.equal(sameCode('a=1.5', 'a = 1.25;\n'), false, 'a number')
    assert.equal(sameCode('a()/* keep me */', 'a();\n'), false, 'a comment')
    // What reads alike once parentheses and semicolons are set aside, but means otherwise.
    assert.equal(sameCode('x = (a + b) * c\n', 'x = a + b * c\n'), false, 'parentheses that group')
    assert.equal(sameCode('a\n(b)\n', 'a;\n(b);\n'), false, 'a call split in two')
    assert.equal(sameCode('let x = 1\n[y] = z\n', 'let x = 1;\n[y] = z;\n'), false, 'a member read made a statement')
    assert.equal(sameCode('(a?.b).c\n', 'a?.b.c\n'), false, 'an optional chain extended')
    assert.equal(sameCode('a&&(b||c)', 'a && b || c;\n'), false, 'chains of two operators regrouped')
    assert.equal(sameCode('const x:number=a', 'const x: string = a;\n', 'ts'), false)
    // A comma or a `|` set aside, the syntax tree still has what they mean.
    assert.equal(sameCode('x=[a,,]', 'x = [a];\n'), false, 'a hole dropped beside a trailing comma')
    assert.equal(sameCode('type P=A|B', 'type P = A & B;\n', 'ts'), false, 'a union made an intersection')
    assert.equal(sameCode('type P=|A|B', 'type P = | A & B;\n', 'ts'), false, 'and after a leading `|`')
    assert.equal(sameCode('let x={a:1,b:2}', 'let x = { a: 1; b: 2 };\n', 'ts'), false, 'an object\'s `,` made `;`, which no longer parses')
    assert.equal(sameCode('f(a,b)', 'f(a; b);\n', 'ts'), false, 'and an argument list\'s')
    assert.equal(sameCode('f(', 'f(\n'), false, 'text that does not parse')
  })

  it('compares strings and comments as written, but for quotes and a comment\'s indentation', () => {
    assert.equal(sameCode('/**\n     * a  b\n     */\nf()//x(y)', '/**\n * a  b\n */\nf(); //x(y)\n'), true)
    for (const [text, formatted, what] of [['a()/* a b */', 'a(); /* ab */\n', 'a space in a comment'], ['a()/* A  B */', 'a(); /* A B */\n', 'spaces within one of its lines'],
      ['a()// x(y)', 'a(); // xy\n', 'parentheses in one'], ["a()// 'x'", 'a(); // "x"\n', 'quotes in one']]) assert.equal(sameCode(text, formatted), false, what)
    assert.equal(sameCss('a{/* columns: A  B */x:y}', 'a {\n  /* columns: A B */\n  x: y;\n}\n'), false)
    assert.equal(sameCode('{"x":"a b","y":1.50,"z":[1.00,1E+03,1.5e0]}', '{ "x": "a b", "y": 1.5, "z": [1.0, 1e3, 1.5] }\n', 'json'), true)
    for (const [text, formatted] of [['{"x":"a b"}', '{ "x": "ab" }\n'], ['{"x":"1.50"}', '{ "x": "1.5" }\n'], ['{"x":1}', '{ "x": 1 } // c\n'],
      ['{"x":0.100000000000000004}', '{ "x": 0.1 }\n'], ['{"x":1.0}', '{ "x": 1 }\n'], ['{"x":1e0}', '{ "x": 1 }\n'],
      // Numbers JSON does not have, which a copy would show as valid.
      ['{"x":.5}', '{ "x": 0.5 }\n'], ['{"x":1.}', '{ "x": 1 }\n'], ['{"x":1.e5}', '{ "x": 1e5 }\n'],
      // A double quote in a string quoted otherwise, and a line carried on by a backslash, keep the strings after it strings.
      [`['a"b', "c  d"]`, `['a"b', "c d"]\n`], ['["x\\\r\n  1.50 y"]', '["x\\\r\n1.5y"]\n'],
      // Blanks JSON does not have, a no-break space and a byte order mark, which a copy would drop.
      [`{"x":${String.fromCodePoint(0xA0)}1}`, '{ "x": 1 }\n'], [`${String.fromCodePoint(0xFEFF)}{"x":1}`, '{ "x": 1 }\n']]) assert.equal(sameCode(text, formatted, 'json'), false, text)
  })

  it('compares CSS as css-tree reads it, but for the case CSS ignores, a number\'s needless zeros and an attribute\'s quotes', () => {
    const text = 'A:HOVER,.Foo:NOT(.Bar)[class*=x]{COLOR:RED;--Brand:#abc;background:#ABC;margin:.5EM!IMPORTANT}@MEDIA screen{a{b:c}}'
    const formatted = 'A:hover,\n.Foo:not(.Bar)[class*="x"] {\n  color: RED;\n  --Brand: #abc;\n  background: #abc;\n  margin: 0.5em !important;\n}\n'
      + '@media screen {\n  a {\n    b: c;\n  }\n}\n'
    assert.equal(sameCss(text, formatted), true, "oxfmt's own output")
    assert.equal(sameCode(text, formatted, 'css'), false, 'not without css-tree')
    assert.equal(sameCode(text, formatted), false, 'nor as a script')
    for (const [before, after] of [
      ["@media(min-width:1px){a>b,.c .d{src:url(x)format('woff');margin:0 .5EM}}", '@media (min-width: 1px) {\n  a > b,\n  .c .d {\n    src: url(x) format("woff");\n    margin: 0 0.5em;\n  }\n}\n'],
      ['a+b,a:NTH-CHILD(2N+1){x:calc(1px + 2px)}', 'a + b,\na:nth-child(2n + 1) {\n  x: calc(1px + 2px);\n}\n'],
      ['a{b:c}/* x */d{e:f}', 'a {\n  b: c;\n} /* x */\nd {\n  e: f;\n}\n'], ['a{b:url( x )}', 'a {\n  b: url(x);\n}\n'],
      ['a{background:linear-gradient(#ABC,#DEF)}', 'a {\n  background: linear-gradient(#abc, #def);\n}\n'],
      ['/**\n     * a  b\n     */\na{b:c}', '/**\n * a  b\n */\na {\n  b: c;\n}\n'],
    ]) assert.equal(sameCss(before, after), true, before)
  })

  it('takes numbers as written, but for zeros that change neither value nor type, in a custom property\'s too', () => {
    assert.equal(sameCss('a{b:.1;c:-.5px;d:+.50%;e:1.50;f:.10em;g:2.500e3;h:1.00}', 'a {\n  b: 0.1;\n  c: -0.5px;\n  d: +0.5%;\n  e: 1.5;\n  f: 0.1em;\n  g: 2.5e3;\n  h: 1.0;\n}\n'), true)
    assert.equal(sameCss(':root{--x:.30px .50;--y:"a  .5"}', ':root {\n  --x: 0.3px 0.5;\n  --y: "a  .5";\n}\n'), true)
    for (const [before, after, what] of [['a{b:0.100000000000000004}', 'a {\n  b: 0.1;\n}\n', 'a digit dropped'], ['a{b:1.05}', 'a {\n  b: 1.5;\n}\n', 'a zero within'],
      ['a{b:10}', 'a {\n  b: 1;\n}\n', 'an integer\'s zero'], ['a{z-index:1.0}', 'a {\n  z-index: 1;\n}\n', 'the point that makes it no integer, as oxfmt drops it'],
      [':root{--x:1.0}', ':root {\n  --x: 1;\n}\n', 'and in a custom property'], ['a{b:1E3}', 'a {\n  b: 1e3;\n}\n', 'an exponent\'s case'], ['a{b:.1}', 'a {\n  b: 0.2;\n}\n', 'another number'],
      [':root{--y:"a .5"}', ':root {\n  --y: "a 0.5";\n}\n', 'a string in a custom property'], [':root{--x:a  b}', ':root {\n  --x: a b;\n}\n', 'its spaces'],
      [`:root{--x:a${String.fromCodePoint(0xA0)}}`, ':root {\n  --x: a;\n}\n', 'a no-break space ending it, which CSS takes for part of a word']]) assert.equal(sameCss(before, after), false, what)
  })

  it('refuses any other change, Prettier\'s own among them', () => {
    for (const [before, after, what] of [['.a .b{}', '.a.b {\n}\n', 'a descendant made a compound'], ['* .a{}', '*.a {\n}\n', 'and after `*`'],
      ['.a/**/.b{x:y}', '.a /**/ .b {\n  x: y;\n}\n', 'a compound made a descendant beside a comment'],
      ['a{content:"a b"}', 'a {\n  content: "ab";\n}\n', 'a string\'s spaces'], ['a{content:"A"}', 'a {\n  content: "a";\n}\n', 'its case'],
      ['a{b:c;d:e}', 'a {\n  b: cd: e;\n}\n', 'two declarations made one'], [':root{--Brand:red}', ':root {\n  --brand: red;\n}\n', 'a custom property\'s case'],
      ['.Foo{a:b}', '.foo {\n  a: b;\n}\n', 'a class\'s'], ['.col-2XL{a:b}', '.col-2xl {\n  a: b;\n}\n', 'one that looks like a unit'], ['#Face{a:b}', '#face {\n  a: b;\n}\n', 'an id\'s'], ['a{animation:Spin}', 'a {\n  animation: spin;\n}\n', 'a value\'s'],
      ['a{b:url(A.png)}', 'a {\n  b: url(a.png);\n}\n', 'a URL\'s'], ['clipPath{a:b}', 'clippath {\n  a: b;\n}\n', 'an element\'s'], ['@MEDIA SCREEN{a{b:c}}', '@media screen {\n  a {\n    b: c;\n  }\n}\n', 'a media type\'s'],
      ['#ABC[x=";"]{a:b}', '#abc[x=";"] {\n  a: b;\n}\n', 'an id\'s, a string read past'], ['@media /* KEEP */ screen{a{x:y}}', '@media /* keep */ screen {\n  a {\n    x: y;\n  }\n}\n', 'a comment\'s in a query'],
      ['@supports (--Foo:1){a{x:y}}', '@supports (--foo: 1) {\n  a {\n    x: y;\n  }\n}\n', 'a custom property\'s in one'], ['a{filter:url(#ABC)}', 'a {\n  filter: url(#abc);\n}\n', 'a URL\'s fragment'],
      [`a{${String.fromCodePoint(0x212A)}:b}`, 'a {\n  k: b;\n}\n', 'a capital outside ASCII'], ['a{b:c!ie}', 'a {\n  b: c !important;\n}\n', 'a hack made `!important`'],
      ['a{x:calc(1px + 2px)}', 'a {\n  x: calc(1px +2px);\n}\n', 'the spaces calc() needs'], [':root{--x:# fff}', ':root {\n  --x: #fff;\n}\n', 'two tokens made one'], ['a{--x:5 %}', 'a {\n  --x: 5%;\n}\n', 'and with `%`'],
      ['[a*=x]{}', '[a^="x"] {\n}\n', 'an attribute\'s matcher'], ['[a=x i]{}', '[a="x" s] {\n}\n', 'its flag'], ['[a=\\41]{}', '[a="\\\\41"] {\n}\n', 'an escape quoted'],
      ['a{background:-moz-element(#ABC)}', 'a {\n  background: -moz-element(#abc);\n}\n', 'an element\'s id, as Prettier lowers it'],
      [':root{--token:#ABC}', ':root {\n  --token: #abc;\n}\n', 'a custom property\'s value, as Prettier lowers it'],
      ['a{--x:{foo}}', 'a {\n  --x: {\n    foo;\n  };\n}\n', 'a `;` added in a custom property\'s block, as Prettier adds it'],
      ['a{b:"x\n}', 'a {\n  b: "x\n}\n', 'text css-tree finds an error in']]) assert.equal(sameCss(before, after), false, what)
  })

  it('reads text in time linear in its length', { timeout: 20_000 }, () => {
    const start = performance.now()
    for (const text of ['a:b'.repeat(12_500) + '{c:d}', `a{${'b:c;'.repeat(12_500)}}`, '/*'.repeat(25_000), `a${' '.repeat(300_000)}b{}`, `[a=${' '.repeat(300_000)}b]{}`,
      `/*${' '.repeat(300_000)}*/`, `a{${'color:#ABC;'.repeat(5000)}}`, `a{${'b:#ABC;'.repeat(5000)}}`, `a{background:${'url(x) #ABC 1px, '.repeat(2500)}red}`, `a{--x:${'.5 '.repeat(25_000)}}`]) {
      sameCss(text, text)
    }
    for (const text of ['/*'.repeat(100_000), `['"${'\\"'.repeat(100_000)}']`, '"'.repeat(100_000)]) sameCode(text, text, 'json')
    // A comma, comments after it, and no bracket: each comment read one way, not split every way, which
    // for these takes seconds, doubling with each comment more.
    for (const text of [`f(a,${'/* x */ '.repeat(29)}b)`, `f(a,${'// x // y\n'.repeat(17)}b)`]) assert.ok(sameCode(text, text, 'js'))
    assert.ok(performance.now() - start < 5000)
  })

  it('takes no other kind of file', () => {
    assert.equal(sameCode('a', 'a', 'md'), false)
    assert.equal(sameCode('a: 1', 'a: 1', 'yaml'), false)
    assert.equal(sameCode('a{}', 'a{}', 'css'), false, 'nor CSS without css-tree')
  })
})

describe('format', () => {
  it('formats a minified file, leaving template literals as they are', async () => {
    const { code } = await format('const a=css`a{color:red}`;function f(x){return x+1}', 'js')
    assert.ok(code.split('\n').length > 3)
    assert.match(code, /css`a\{color:red\}`/u)
  })

  it('answers why where it does not', async () => {
    assert.deepEqual(await format('function (', 'js'), { error: 'unformattable' })
    assert.deepEqual(await format('a', 'md'), { error: 'unsupported' })
    assert.deepEqual(await format('a{--x:{foo}}', 'css'), { error: 'pretty-mismatch' })
  })

  it('answers rather than throws where its own check gives out', async () => {
    assert.ok('code' in await format(`x = ${Array.from({ length: 10_000 }, () => 'a').join(' || ')}`, 'js'))
  })

  it('ends the line a block comment over more than one ends, indented as its first', async () => {
    const license = '/**\n * @license\n * Copyright 2017 Google LLC\n * SPDX-License-Identifier: BSD-3-Clause\n */'
    assert.deepEqual(await format(`import{a as s}from"x";${license}class e extends s{}`, 'mjs'),
      { code: `import { a as s } from "x";\n${license}\nclass e extends s {}\n` })
    assert.deepEqual(await format('function f(){/**\n * a\n */return 1}', 'js'), { code: 'function f() {\n  /**\n   * a\n   */\n  return 1;\n}\n' })
    assert.deepEqual(await format('/**\n * a\n *//**\n * b\n */c()', 'js'), { code: '/**\n * a\n */\n/**\n * b\n */\nc();\n' }, 'one after another')
    assert.deepEqual(await format('/* a */f()', 'js'), { code: '/* a */ f();\n' }, 'one on one line keeps it')
    // One holding a line break ends a line to the parser already: `return` returns nothing here, before and after.
    assert.deepEqual(await format('function f(){return/**\n*/1}', 'js'), { code: 'function f() {\n  return;\n  /**\n   */\n  1;\n}\n' })
  })

  it('takes trailing commas it drops and the `|` it leads a union\'s lines with', async () => {
    const union = Array.from({ length: 6 }, (_, i) => `Part${i}WithALongName`).join(' | ')
    const { code } = await format(`import{directive,Directive,PartType,}from"./directive.js";export type Part=${union};`, 'ts')
    assert.match(code, /^import \{ directive, Directive, PartType \} from "\.\/directive\.js";\nexport type Part =\n {2}\| Part0WithALongName\n/u)
    assert.match((await format(`export function isPart(x: unknown): x is ${union} { return true }`, 'ts')).code, /x is\n {2}\| Part0WithALongName\n/u, 'and after a type predicate\'s `is`')
    assert.match((await format(`export type M = { [P in ${union}]: 1 };`, 'ts')).code, /P in\n\s+\| Part0WithALongName\n/u, 'and a mapped type\'s `in`')
  })

  it('writes `!0` and `!1` as `true` and `false`, as they read', async () => {
    assert.deepEqual(await format('x=!0,y=!1;f(!0,typeof!1,-!0,!!0);r=()=>a?!0:!1', 'js'),
      { code: '((x = true), (y = false));\nf(true, typeof false, -true, !true);\nr = () => (a ? true : false);\n' })
    assert.deepEqual(await format('const a=!0 as const;let b=!1', 'ts'), { code: 'const a = !0 as const;\nlet b = !1;\n' }, 'but where TypeScript types them otherwise')
    assert.deepEqual(await format('function f(a){switch(a){case!1:return!0}return void!0}', 'js'),
      { code: 'function f(a) {\n  switch (a) {\n    case false:\n      return true;\n  }\n  return void true;\n}\n' }, 'set apart from a word it follows')
    assert.deepEqual(await format('x="!0";y=`!1`;z=/!0/;w=[!0n,!00,!0.5,!2];v=!/* c */0', 'js'),
      { code: 'x = "!0";\ny = `!1`;\nz = /!0/;\nw = [!0n, !00, !0.5, !2];\nv = !(/* c */ 0);\n' }, 'anything else kept, a comment within one too')
  })

  it('writes a name as the file does, escapes and all', async () => {
    const [a, b, c] = [esc('0061'), esc('0062'), esc('0063')]
    assert.deepEqual(await format(`var ${a}=1;a.${b};x={${a}:1,${c}};class A{#${a};static ${esc('0275')}x=1;m(){this.#${a}}}`, 'js'),
      { code: `var ${a} = 1;\na.${b};\nx = { ${a}: 1, ${c} };\nclass A {\n  #${a};\n  static ${esc('0275')}x = 1;\n  m() {\n    this.#${a};\n  }\n}\n` })
    assert.deepEqual(await format(`var ${esc('{61}')}b=a${esc('200c')}b`, 'js'), { code: `var ${esc('{61}')}b = a${esc('200c')}b;\n` }, 'a joiner, unseen once read')
    assert.deepEqual(await format(`function f(${a}:string,b?:${esc('0074')}){}`, 'ts'), { code: `function f(${a}: string, b?: ${esc('0074')}) {}\n` }, 'and a typed one')
  })

  it('keeps a comment after the operator, `,`, `?` or `:` it follows', async () => {
    for (const [text, code] of [['x=a&&/* c */\n(b||c)', 'x = a && /* c */ (b || c);\n'], ['x=a+/* c */\nb', 'x = a + /* c */ b;\n'],
      ['x=a?/* c */\nb:c', 'x = a ? /* c */ b : c;\n'], ['x=a?b:/* c */\nc', 'x = a ? b : /* c */ c;\n'], ['f(a,/* c */\nb)', 'f(a, /* c */ b);\n'],
      ['x=a in/* c */\nb', 'x = a in /* c */ b;\n'], ['x=a&&/* c */ /* d */\nb', 'x = a && /* c */ /* d */ b;\n'],
      // One over more than one line still ends its line.
      ['x=a&&/** c\n */\nb', 'x =\n  a && /** c\n   */\n  b;\n']]) assert.deepEqual(await format(text, 'js'), { code }, text)
    // A name's escape repaired alike, a sign after a comment is no operator it moved past.
    for (const sign of ['+', '-']) {
      assert.deepEqual(await format(`var ${esc('0061')}=1;x=y${sign}/* c */${sign}z`, 'js'), { code: `var ${esc('0061')} = 1;\nx = y ${sign} /* c */ ${sign}z;\n` }, sign)
    }
  })

  it('formats CSS where css-tree is there to check it', async () => {
    assert.deepEqual(await format('a{color:#ABC;margin:.5EM}', 'css'), { code: 'a {\n  color: #abc;\n  margin: 0.5em;\n}\n' })
  })

  it('takes published code minified as it is formatted', async () => {
    for (const file of ['src/names/analyze.js', 'src/renames.js', 'src/layout.js']) {
      const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
      const { code, errors } = minifySync('file.mjs', source, { compress: false, mangle: { toplevel: true }, codegen: { removeWhitespace: true } })
      assert.deepEqual(errors, [])
      const formatted = await format(code, 'mjs')
      assert.ok('code' in formatted, file)
      assert.ok(formatted.code.split('\n').length > 50, file)
    }
  })
})
