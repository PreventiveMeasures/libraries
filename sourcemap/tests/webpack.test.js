import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { bundleEdges } from '@preventive/sourcemap/edges.js'
import { bundleEdges as liteEdges } from '@preventive/sourcemap/edges-lite.js'
import { bundle as fixture } from './fixtures.js'
import { handWritten, shown } from './helpers.js'

// webpack keeps a module apart as a factory in a table by its id, and its
// require calls name that id, so an edge is exact; the modules it
// concatenates into one scope read as any scope-hoisted bundle does.

describe('the fixture project (see fixtures.js), as webpack bundled it', () => {
  it('in development: every import, ext\'s as the external webpack left it', () => {
    assert.deepEqual(shown(bundleEdges(...fixture('webpack-development')).edges), [
      'node_modules/cjsdep/index.js -> node_modules/cjsdep/inner.js [dependency]',
      'node_modules/dep/index.js -> node_modules/dep/util.js [dependency]',
      'src/a.js -> src/b.js [dependency]',
      'src/index.js -> (ext, package ext) [dependency]',
      'src/index.js -> node_modules/cjsdep/index.js [dependency]',
      'src/index.js -> node_modules/dep/index.js [dependency]',
      'src/index.js -> src/a.js [dependency]',
      'src/index.js -> src/dead.js [dependency]',
      'src/index.js -> src/side.js [dependency]',
    ])
  })

  it('in production: the CommonJS modules by id, the concatenated ones by name', () => {
    // The minifier folded a() + b() and fromDep() into constants, and
    // side.js's one statement has no name to it.
    assert.deepEqual(shown(bundleEdges(...fixture('webpack-production')).edges), [
      'node_modules/cjsdep/index.js -> node_modules/cjsdep/inner.js [dependency]',
      'src/index.js -> (ext, package ext) [dependency]',
      'src/index.js -> node_modules/cjsdep/index.js [dependency]',
      'src/index.js -> node_modules/dep/index.js [reference]',
      'src/index.js -> src/a.js [reference]',
    ])
  })

  it('which edges-lite.js does not read', () => {
    for (const name of ['webpack-development', 'webpack-production']) assert.throws(() => liteEdges(...fixture(name)), /not a Metro bundle/u)
  })
})

// Bundles written out by hand, each line given to the file named with it.
const RUNTIME = 'webpack://p/webpack/bootstrap'
const EXT = 'webpack://p/external commonjs "ext"'
const generated = (lines) => shown(bundleEdges(...handWritten(lines)).edges)

describe('every shape webpack writes its table in', () => {
  it('webpack 5\'s, minified: methods by number, run by a require that passes itself on', () => {
    assert.deepEqual(generated([
      [RUNTIME, '(()=>{var e={'],
      ['webpack://p/./a.js', '1(e,t,o){o(2);o(3);o(9)},'],
      ['webpack://p/./b.js', '2(e,t,o){o(1)},'],
      [EXT, '3(e){e.exports=require("ext")}};'],
      [RUNTIME, 'function o(r){var n={exports:{}};return e[r](n,n.exports,o),n.exports}'],
      [RUNTIME, 'o(1)})();'],
    ]), ['a.js -> (ext, package ext) [dependency]', 'a.js -> b.js [dependency]', 'b.js -> a.js [dependency]'])
  })

  it('webpack 4\'s: an array of functions in parentheses, each run by .call', () => {
    assert.deepEqual(generated([
      [RUNTIME, '(function(modules){function req(id){var m={exports:{}};modules[id].call(m.exports,m,m.exports,req);return m.exports}return req(req.s=0)})(['],
      ['webpack://p/./a.js', '(function(module,exports,__webpack_require__){__webpack_require__(1);__webpack_require__(2);__webpack_require__(3)}),'],
      ['webpack://p/./b.js', ',(function(module,exports){}),'],
      ['webpack://p/./c.js', '(function(module,exports,n){n(0)})]);'],
    ]), ['a.js -> b.js [dependency]', 'a.js -> c.js [dependency]', 'c.js -> a.js [dependency]'])
  })

  it('by path, as in development', () => {
    assert.deepEqual(generated([
      [RUNTIME, 'var __webpack_modules__=({'],
      ['webpack://p/./src/a.js', '"./src/a.js":((module,exports,__webpack_require__)=>{__webpack_require__("./src/b.js")}),'],
      ['webpack://p/./src/b.js', '"./src/b.js":((module)=>{})});'],
    ]), ['src/a.js -> src/b.js [dependency]'])
  })

  it('and the require calls of concatenated modules, written ahead of their own code', () => {
    // webpack maps no file to a concatenated module's require of a table
    // entry, and an inlined external's to its stand-in.
    assert.deepEqual(generated([
      [RUNTIME, '(()=>{var e={'],
      ['webpack://p/./c.js', '7(e){e.exports=1}};'],
      [RUNTIME, 'function o(r){var n={exports:{}};return e[r](n,n.exports,o),n.exports}'],
      [null, 'var r=o(7);'],
      [EXT, 'const s=require("ext");'],
      ['webpack://p/./main.js', 'module.exports=r+s;'],
      [RUNTIME, '})();'],
    ]), ['main.js -> (ext, package ext) [dependency]', 'main.js -> c.js [dependency]'])
  })
})

it('takes no table inside a module for webpack\'s: an array of functions there is the module\'s own', () => {
  assert.deepEqual(generated([
    [RUNTIME, '(()=>{var e={'],
    ['webpack://p/./a.js', '0(e,t,o){o(1)},'],
    ['webpack://p/./b.js', '1(e,t,o){var handlers=[function(){},function(){}];o(0)}};'],
    [RUNTIME, 'function o(r){var n={exports:{}};return e[r](n,n.exports,o),n.exports}'],
    [RUNTIME, '})();'],
  ]), ['a.js -> b.js [dependency]', 'b.js -> a.js [dependency]'])
})

it('a table of functions in a bundle no webpack:// source names is read for names alone', () => {
  assert.deepEqual(generated([
    ['a.js', 'var t={1(e,n,o){o(2)},2(){}};'],
    ['b.js', 'function o(r){return t[r](0,0,o)}'],
  ]), ['b.js -> a.js [reference]'])
})
