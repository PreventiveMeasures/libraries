import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { scanSpecifiers } from '../src/scan.js'

// The module requests a source makes, read with no parser: what Metro reads
// from a map alone, where React Native's own sources are Flow, which oxc
// does not parse.

const scanned = (text) => scanSpecifiers(text).map(({ kind, specifier }) => `${kind} ${specifier}`)

describe('a source\'s module requests, read with no parser', () => {
  it('every shape that requests a module', () => {
    assert.deepEqual(scanned([
      "import a from 'a'",
      "import * as b from 'b'",
      "import c, { d } from 'c'",
      "import 'side'",
      "export * from 'e'",
      "export * as f from 'f'",
      "export { g, h as i } from 'g'",
      "const j = require('j')",
      "import('k').then(() => require(\"l\"))",
    ].join('\n')), ['import a', 'import b', 'import c', 'import side', 'export-from e', 'export-from f', 'export-from g', 'require j', 'dynamic-import k', 'require l'])
  })

  it('Flow\'s and TypeScript\'s, but not those that request types alone', () => {
    assert.deepEqual(scanned([
      "import type { A } from 'type-only'",
      "import typeof B from 'typeof-only'",
      "import { type C, typeof D } from 'types-only'",
      "import { type E, f } from 'mixed'",
      "import type, { g } from 'default-named-type'",
      "export type { H } from 'type-export'",
      "function f(x: ?string, y: {| a: 'quoted' |}): Array<'b'> { return require('flow') }",
    ].join('\n')), ['import mixed', 'import default-named-type', 'require flow'])
  })

  it('nothing in a comment, string, template, or regular expression', () => {
    assert.deepEqual(scanned([
      "// require('line-comment')",
      "/* import x from 'block-comment' */",
      "const s = \"require('in-a-string')\"",
      "const t = `import('in-a-template') ${require('in-its-expression')} ${{ a: `${require('nested')}` }.a}`",
      "const r = /require\\('in-a-regex'\\)|['\"]/u, q = a / require('after-a-division') / 2",
      "x.require('a-method'); import.meta.url",
    ].join('\n')), ['require in-its-expression', 'require nested', 'require after-a-division'])
  })

  it('past a quote in JSX text, which ends with its line', () => {
    assert.deepEqual(scanned("const e = <Text>Don't</Text>\nconst m = require('after-jsx')"), ['require after-jsx'])
  })

  it('with a line ended by any of JavaScript\'s line terminators', () => {
    for (const end of ['\r', '\u2028', '\u2029', '\r\n']) {
      assert.deepEqual(scanned(`// a comment${end}require('a')${end}<Text>Don't</Text>${end}require('b')`), ['require a', 'require b'], JSON.stringify(end))
    }
  })

  it('no specifier that is computed, escaped, or cut off', () => {
    assert.deepEqual(scanned("require(name); require('a' + b); import(`t${x}`); require('\\x61'); require('cut"), [])
  })
})
