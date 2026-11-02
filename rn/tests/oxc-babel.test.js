import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { parseSync } from 'oxc-parser'

import { Unconverted, babelFile } from '../src/oxc-babel.js'

const { parse } = createRequire(fileURLToPath(import.meta.resolve('@babel/core')))('@babel/parser')

// The AST as data: comments attached by where they start, keys in order.
const plain = (value, key) => {
  if (key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') return value.map(({ start }) => start)
  if (value instanceof RegExp) return String(value)
  if (Array.isArray(value)) return value.map((item) => plain(item))
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value)
      .filter((name) => value[name] !== undefined && name !== 'errors')
      .toSorted()
      .map((name) => [name, plain(value[name], name)]),
  )
}

const oxc = (code, { sourceType = 'unambiguous', flow = false } = {}) => {
  const { program, comments, errors } = parseSync('file.js', code, { lang: 'jsx', sourceType, preserveParens: true, experimentalRawTransfer: true })
  assert.deepEqual(errors, [])
  return babelFile(program, comments, code, { sourceType, flow })
}

const babel = (code, { sourceType = 'unambiguous', flow = false } = {}) => parse(code, { sourceType, plugins: ['jsx', ...(flow ? [['flow', {}]] : [])] })

const same = (code, options) => assert.deepEqual(plain(oxc(code, options)), plain(babel(code, options)), code)

describe('babelFile', () => {
  it("makes oxc-parser's AST @babel/parser's, as esbuild prints JS and JSX", () => {
    for (const code of [
      '"use strict";\nvar a = require("a");\nmodule.exports = { b: a.b, c() {}, get d() { return 1; }, [e]: 0x10, ...f };\n',
      'import x, { y as z, w } from "x";\nimport * as ns from "ns";\nimport "side";\nexport { x, z as v };\nexport * from "all";\nexport * as some from "some";\nexport default function() {}\n',
      'class A extends B {\n  #p = 1;\n  static q;\n  x = this.#p;\n  constructor() { super(); }\n  #m() { return #p in this; }\n  get #g() { return 1; }\n  static async *s() {}\n  [k]() {}\n}\n',
      'a?.b.c(); (a?.b).c; a?.[b]?.(c); x = (1, 2); y = ((3, 4)); (function() {})(); (() => {})();\n',
      'x = `a${b}c${`d${e}`}`; tag`\\unicode`; r = /a\\/b[/]/gimsu; n = 1_000 + 1_000n + 0x1Fn + .5e3 + 0b11;\n',
      'const el = /* @__PURE__ */ React.createElement(A, null); const j = <A b="c" {...d}><B />text{e}<>{/* f */}</></A>;\n',
      'async function f() { for await (const x of y) {} await z; label: for (;;) { break label; } }\nfunction* g() { yield* h(); }\n',
      'function f() { "use strict"; return; }\nvar g = () => { "use asm"; };\nswitch (a) { case 1: break; default: }\ntry {} catch {} finally {}\nfunction h() { x = new.target === void 0 ? new A() : new B(c); }\n',
      '#!/usr/bin/env node\n// a comment\nx;\n',
      '',
      '// only\n/* comments */\n',
      'a\r\nb /* c */\r\n// d\r\nc\u2028d; /* \u2029 */ e',
      's = "😀"; /* 😀 */ t = `😀${u}😀`; <A b="😀">😀</A>;\n',
      'x = { a: 1, }; y = [1, , ]; f(a, b, );\n',
    ]) {
      for (const sourceType of ['unambiguous', 'module', 'script']) {
        if (sourceType === 'script' && /^(?:import|export)\b/mu.test(code)) continue
        for (const flow of [false, true]) same(code, { sourceType, flow })
      }
    }
  })

  it('attaches comments to nodes as @babel/parser does, which its generator reads', () => {
    for (const code of [
      'x = (/* a */ b /* c */) /* d */;\nx = (a, /* b */ c) /* d */;\nx = (/* a */ (b));',
      'f(/* a */); f(a, /* b */); x = [a, /* b */]; x = {a, /* b */}; new A(b, /* c */);',
      'x = `a${/* b */ c /* d */}e`;',
      'x = async /* a */ (b) => c; x = async (/* a */ b, c /* d */) => e; x = async /* a */ function () {};',
      'class A { /* a */ static /* b */ x = 1; get /* c */ y() {} async /* d */ *z() {} static /* e */ {} }\n({ get /* a */ x() {}, async /* b */ y() {}, /* c */ z });',
      '"use strict" /* a */; /* b */ "x"; y;\nfunction f() { /* a */ "use strict"; return /* b\n */ x; }',
      'x = <A /* a */ b={/* c */ d} {...e /* f */}>{/* g */}{h /* i */}</A>;',
      'x = a?.b /* c */.d(/* e */); if (a) /* b */ c; else /* d */ e; label: /* a */ for (;;) { break /* b */ label; }',
      'switch (a) { /* b */ case 1: /* c */ break; default: /* d */ }\ntry { /* a */ } catch /* b */ (e) {} finally /* c */ {}',
      'x = function /* a */ f /* b */ (/* c */) /* d */ {};\nexport default /* a */ function () {}\nexport /* a */ { b as /* c */ d } from "e";\nimport /* a */ f, { /* b */ g as h } from "i";\nexport * as /* a */ ns from "b";',
      '/** @license x */\n"use strict";\n// $FlowFixMe[incompatible-type]\nmodule.exports = /* @__PURE__ */ (/* a */ f(), g);\n//# sourceMappingURL=data:application/json;base64,e30=\n',
    ]) {
      same(code)
      same(code, { flow: true })
    }
  })

  it('leaves to Babel what it would make otherwise', () => {
    for (const [code, what] of [
      ['@dec class A {}', 'decorators'],
      ['using a = b;', 'using'],
      ['x = <A>&amp;</A>;', 'JSX entity'],
      ['x = <A b="&amp;" />;', 'JSX entity'],
      ['import a from "a" with { type: "json" };', 'import attributes'],
      ['x = import /* a */.meta;', 'import.meta'],
      ['const [a,] = b;', 'trailing comma'],
      ['await a;', 'top-level await'],
    ]) {
      const { program, comments } = parseSync('file.js', code, { lang: 'jsx', sourceType: 'module', preserveParens: true, experimentalRawTransfer: true })
      assert.throws(() => babelFile(program, comments, code), (error) => error instanceof Unconverted && error.message === what, code)
    }
    const html = 'x = 1 <!-- a\n'
    const { program, comments } = parseSync('file.js', html, { lang: 'jsx', sourceType: 'script', preserveParens: true, experimentalRawTransfer: true })
    assert.throws(() => babelFile(program, comments, html, { sourceType: 'script' }), Unconverted)
  })
})
