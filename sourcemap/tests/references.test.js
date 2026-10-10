import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { bundleEdges } from '@preventive/sourcemap/edges.js'
import { bundle as fixture } from './fixtures.js'
import { handWritten, shown } from './helpers.js'

// A scope-hoisted bundle has no imports left between the files it holds,
// only names: code from one file naming a declaration from another. The
// map says which file each side came from; scoping says which declaration
// a name is, which a minifier reusing names in every function makes the
// whole question.

describe('the fixture project (see fixtures.js), as bundled', () => {
  // esbuild wraps a file with no import or export in a CommonJS shim, so
  // side.js is named, as require_side(); dead.js is gone.
  const ESBUILD = [
    'node_modules/cjsdep/index.js -> node_modules/cjsdep/inner.js [reference]',
    'node_modules/dep/index.js -> node_modules/dep/util.js [reference]',
    'src/a.js -> src/b.js [reference]',
    'src/index.js -> (ext, package ext) [import]',
    'src/index.js -> node_modules/cjsdep/index.js [reference]',
    'src/index.js -> node_modules/dep/index.js [reference]',
    'src/index.js -> src/a.js [reference]',
    'src/index.js -> src/side.js [reference]',
  ]

  for (const name of ['esbuild', 'esbuild-min']) {
    it(`by ${name}: every edge to code it kept`, () => {
      assert.deepEqual(shown(bundleEdges(...fixture(name)).edges), ESBUILD)
    })
  }

  it('by rollup: what is named, which a side-effect import and its CommonJS shims are not', () => {
    // rollup inlines side.js's statement with no name to it, and maps
    // nothing of the shims its commonjs plugin writes around cjsdep.
    assert.deepEqual(shown(bundleEdges(...fixture('rollup')).edges), [
      'node_modules/dep/index.js -> node_modules/dep/util.js [reference]',
      'src/a.js -> src/b.js [reference]',
      'src/index.js -> (ext, package ext) [import]',
      'src/index.js -> node_modules/dep/index.js [reference]',
      'src/index.js -> src/a.js [reference]',
    ])
  })
})

// Generated code written by hand, each line given to the file named with it.
const generated = (lines) => bundleEdges(...handWritten(lines))

describe('a name is the declaration its scope makes it', () => {
  it('a parameter, a block\'s let, a catch\'s binding, a function\'s own name shadow what is outside', () => {
    assert.deepEqual(shown(generated([
      ['outer.js', 'var h = 1, k = 2, c = 3, f = 4;'],
      ['param.js', 'function g(h) {'],
      ['use.js', '  return h }'],
      ['block.js', '{ let k = 5;'],
      ['use.js', '  k; }'],
      ['catch.js', 'try {} catch (c) {'],
      ['use.js', '  c }'],
      ['name.js', 'var x = function f() {'],
      ['use.js', '  f() }'],
    ]).edges), ['use.js -> block.js [reference]', 'use.js -> catch.js [reference]', 'use.js -> name.js [reference]', 'use.js -> param.js [reference]'])
  })

  it('a var hoists to its function and a function to its block, so a use ahead of either resolves', () => {
    assert.deepEqual(shown(generated([
      ['use.js', 'a(); b; if (1) { c() }'],
      ['a.js', 'function a() {}'],
      ['b.js', 'if (1) { var b = 1 }'],
      ['c.js', 'if (1) { function c() {} }'],
    ]).edges), ['use.js -> a.js [reference]', 'use.js -> b.js [reference]'])
  })

  it('reads destructuring, defaults, and a class and its methods', () => {
    assert.deepEqual(shown(generated([
      ['decl.js', 'var { a, b: [c], ...d } = o, Base = class {};'],
      ['use.js', 'function f(x = a, { y } = c) { return d }'],
      ['cls.js', 'class K extends Base { m() { return y } }'],
    ]).edges), ['cls.js -> decl.js [reference]', 'use.js -> decl.js [reference]'])
  })

  it('counts no property, key, label, or member name as a reference', () => {
    assert.deepEqual(shown(generated([
      ['decl.js', 'var p = 1, q = 2, l = 3, m = 4;'],
      ['use.js', 'o.p; ({ q: 1 }); l: for (;;) break l; class X { m() {} }; ({ [p]: 1 })'],
    ]).edges), ['use.js -> decl.js [reference]'])
    assert.deepEqual(shown(generated([['decl.js', 'var p = 1;'], ['use.js', 'o.p; ({ p: 1 }); class X { p = 1; static p() {} }']]).edges), [])
  })

  it('a shorthand property is a reference, and an assignment one too', () => {
    assert.deepEqual(shown(generated([['decl.js', 'var p, q;'], ['a.js', '({ p });'], ['b.js', '[q] = [1]']]).edges), ['a.js -> decl.js [reference]', 'b.js -> decl.js [reference]'])
  })

  it('`arguments` in a function is its own; in an arrow, the scope\'s around it', () => {
    assert.deepEqual(shown(generated([
      ['outer.js', 'var arguments = 1;'],
      ['f.js', 'function f() {'],
      ['in-function.js', '  return arguments }'],
      ['g.js', 'var g = () =>'],
      ['in-arrow.js', '  arguments;'],
    ]).edges), ['in-arrow.js -> outer.js [reference]'])
  })

  it('a parameter\'s initializer sees no declaration of the body\'s', () => {
    assert.deepEqual(shown(generated([
      ['outer.js', 'var shared = 1;'],
      ['f.js', 'function f(x = shared) {'],
      ['body.js', '  var shared = 2; return shared }'],
    ]).edges), ['f.js -> outer.js [reference]'])
  })

  it('in JSX a bundle kept, a component\'s name is one, and a host element\'s or an attribute\'s is not', () => {
    assert.deepEqual(shown(generated([
      ['button.js', 'function Button() {}'],
      ['ui.js', 'var ui = { Card: 1 };'],
      ['host.js', 'var div = 1, title = 2;'],
      ['app.js', 'var el = <div title="t"><Button /><ui.Card /></div>;'],
    ]).edges), ['app.js -> button.js [reference]', 'app.js -> ui.js [reference]'])
  })

  it('skips a declaration the map gives no file, and a global', () => {
    assert.deepEqual(shown(generated([[null, 'var helper = 1;'], ['use.js', 'helper; window; undefinedName']]).edges), [])
  })
})

describe('what a bundle leaves to the runtime is an edge from the file naming it', () => {
  it('kept imports, by their bindings or their own place; require() and import() of no declared require, a computed one\'s too', () => {
    assert.deepEqual(shown(generated([
      ['top.js', "import { x } from 'kept'; import 'side-effect'; export * from 'reexported'; export { y } from './chunk.js'"],
      ['use.js', "x(); require('node:fs'); import('lazy'); require(computed); import(name); require('null')"],
      ['own.js', "function g(require) { require('not-external') }"],
    ]).edges), [
      'top.js -> (./chunk.js) [export-from]', 'top.js -> (kept, package kept) [import]', 'top.js -> (reexported, package reexported) [export-from]',
      'top.js -> (side-effect, package side-effect) [import]', 'use.js -> () [dynamic-import]', 'use.js -> () [require]', 'use.js -> (kept, package kept) [import]',
      'use.js -> (lazy, package lazy) [dynamic-import]', 'use.js -> (node:fs, builtin) [require]', 'use.js -> (null, package null) [require]',
    ])
  })

  it('throws for a bundle that does not parse', () => {
    assert.throws(() => generated([['a.js', 'var = 1']]), /bundleEdges: the bundle does not parse/u)
  })
})
