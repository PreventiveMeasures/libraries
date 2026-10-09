import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readSourceMap } from '@preventive/sourcemap'
import { importEdges } from '@preventive/sourcemap/edges.js'
import { bundle } from './fixtures.js'
import { shown } from './helpers.js'

// importEdges reads the sources a map carries, not the bundle: what each
// file asks for as written, so a file the bundler dropped is still asked
// for, and every bundler's map reads the same way.

const fixture = (name) => bundle(name)[0]

// The fixture project (see fixtures.js), as its sources import: dead.js
// is in no map but Metro's, its code tree-shaken whole, and ext was left
// out of esbuild's and rollup's bundles.
const PROJECT = [
  'node_modules/cjsdep/index.js -> node_modules/cjsdep/inner.js [require]',
  'node_modules/dep/index.js -> node_modules/dep/util.js [import]',
  'src/a.js -> src/b.js [import]',
  'src/index.js -> (./dead.js, path src/dead.js) [import]',
  'src/index.js -> (ext, package ext) [import]',
  'src/index.js -> node_modules/cjsdep/index.js [import]',
  'src/index.js -> node_modules/dep/index.js [import]',
  'src/index.js -> src/a.js [import]',
  'src/index.js -> src/side.js [import]',
]

describe('the sources\' own imports, whatever bundled them', () => {
  for (const name of ['esbuild', 'esbuild-min', 'rollup']) {
    it(`reads every edge from ${name}'s map, a dropped file's included`, () => {
      const result = importEdges(fixture(name))
      // dead.js is in neither map, its code tree-shaken whole; ext was left out.
      assert.deepEqual(shown(result.edges), PROJECT)
      assert.deepEqual([result.failed, result.unscanned], [[], []])
    })
  }

  it('reads Metro\'s too, where every file is in the bundle', () => {
    const result = importEdges(fixture('metro-prod'))
    const local = PROJECT.map((line) => line.replace('(./dead.js, path src/dead.js)', 'src/dead.js').replace('(ext, package ext)', 'node_modules/ext/index.js'))
    assert.deepEqual(shown(result.edges).map((line) => line.replaceAll('/app/', '')), local.toSorted())
    // Metro's own prelude, named with no extension, reads as a script, and requests nothing.
    assert.deepEqual(result.unscanned, [])
  })
})

// A map with these files and contents, nothing mapped.
const sources = (files, extra = {}) => readSourceMap({ version: 3, sources: Object.keys(files), sourcesContent: Object.values(files), mappings: '', ...extra })

describe('a specifier is resolved as a resolver would try it', () => {
  it('by extension, index file, platform file, and TypeScript\'s output name', () => {
    const map = sources({
      'src/main.ts': "import './a'\nimport './dir'\nimport './view'\nimport { b } from './b.js'\nexport * from './c.mjs'\nimport data from './data.json' with { type: 'json' }",
      'src/a.tsx': 'export default <div />',
      'src/dir/index.js': '',
      'src/view.ios.js': '',
      'src/b.ts': 'export const b = 1',
      'src/c.mts': '',
      'src/data.json': '{}',
    })
    assert.deepEqual(shown(importEdges(map).edges), [
      'src/main.ts -> src/a.tsx [import]', 'src/main.ts -> src/b.ts [import]', 'src/main.ts -> src/c.mts [export-from]',
      'src/main.ts -> src/data.json [import]', 'src/main.ts -> src/dir/index.js [import]', 'src/main.ts -> src/view.ios.js [import]',
    ])
  })

  it('takes a package from the node_modules Node walks up to', () => {
    const map = sources({
      'src/a.js': "import 'b'\nimport 'b/sub'",
      'node_modules/b/index.js': '',
      'node_modules/b/sub.js': '',
      'node_modules/a/x.js': "require('b')",
      'node_modules/a/node_modules/b/index.js': '',
    })
    assert.deepEqual(shown(importEdges(map).edges), [
      'node_modules/a/x.js -> node_modules/a/node_modules/b/index.js [require]',
      'src/a.js -> node_modules/b/index.js [import]',
      'src/a.js -> node_modules/b/sub.js [import]',
    ])
  })

  it('takes a store\'s one copy of a package, and names the package where copies differ', () => {
    const store = (id, name) => `node_modules/.pnpm/${id}/node_modules/${name}`
    const map = sources({
      [`${store('a@1.0.0', 'a')}/index.js`]: "import 'b'\nimport 'c'",
      [`${store('b@2.0.0', 'b')}/index.js`]: '',
      [`${store('c@1.0.0', 'c')}/index.js`]: '',
      [`${store('c@2.0.0', 'c')}/index.js`]: '',
    })
    assert.deepEqual(shown(importEdges(map).edges), [
      `${store('a@1.0.0', 'a')}/index.js -> (c, package c) [import]`,
      `${store('a@1.0.0', 'a')}/index.js -> ${store('b@2.0.0', 'b')}/index.js [import]`,
    ])
  })

  it('says what a target outside the map is: a path, a package, a builtin, or nothing it can tell', () => {
    const map = sources({ 'src/a.js': "import './gone.js'\nimport 'react'\nimport '@scope/x/sub'\nimport 'node:fs'\nrequire('path')\nimport '#internal'\nimport '@/alias'\nrequire(name)\nimport(`./${x}`)" })
    assert.deepEqual(shown(importEdges(map).edges), [
      'src/a.js -> (#internal) [import]', 'src/a.js -> () [dynamic-import]', 'src/a.js -> () [require]',
      'src/a.js -> (./gone.js, path src/gone.js) [import]', 'src/a.js -> (@/alias) [import]', 'src/a.js -> (@scope/x/sub, package @scope/x) [import]',
      'src/a.js -> (node:fs, builtin) [import]', 'src/a.js -> (path, builtin) [require]', 'src/a.js -> (react, package react) [import]',
    ])
    assert.equal(importEdges(map).edges.find((edge) => edge.kind === 'dynamic-import').specifier, null)
  })
  it('resolves among URLs as a browser would, under the scheme and host', () => {
    const map = sources({
      'https://cdn.example/src/a.js': "import './b.js'\nimport '../lib/c.js'\nimport '/lib/d.js'\nimport 'https://cdn.example/lib/c.js'",
      'https://cdn.example/src/b.js': '', 'https://cdn.example/lib/c.js': '', 'https://cdn.example/lib/d.js': '',
    })
    assert.deepEqual(shown(importEdges(map).edges), [
      'https://cdn.example/src/a.js -> https://cdn.example/lib/c.js [import]',
      'https://cdn.example/src/a.js -> https://cdn.example/lib/c.js [import]',
      'https://cdn.example/src/a.js -> https://cdn.example/lib/d.js [import]',
      'https://cdn.example/src/a.js -> https://cdn.example/src/b.js [import]',
    ])
  })

  it('takes a package\'s entry its package.json would name from where packages keep it, or its one file', () => {
    const map = sources({
      'src/a.js': "import 'm'\nimport 'b'\nimport 'debug'\nimport 'one'\nimport 'two'",
      'node_modules/m/lib/index.mjs': '', 'node_modules/m/lib/other.mjs': '',
      'node_modules/b/build/index.js': '',
      'node_modules/debug/src/browser.js': '', 'node_modules/debug/src/common.js': '',
      'node_modules/one/dist/one.umd.js': '',
      'node_modules/two/dist/x.js': '', 'node_modules/two/dist/y.js': '',
    })
    assert.deepEqual(shown(importEdges(map).edges), [
      'src/a.js -> (two, package two) [import]',
      'src/a.js -> node_modules/b/build/index.js [import]',
      'src/a.js -> node_modules/debug/src/browser.js [import]',
      'src/a.js -> node_modules/m/lib/index.mjs [import]',
      'src/a.js -> node_modules/one/dist/one.umd.js [import]',
    ])
  })

  it('takes a platform\'s file over the plain one, as Metro does, where the map holds both', () => {
    const map = sources({ 'src/a.js': "import './view'\nimport './view.js'", 'src/view.js': '', 'src/view.ios.js': '' })
    assert.deepEqual(shown(importEdges(map).edges), ['src/a.js -> src/view.ios.js [import]', 'src/a.js -> src/view.js [import]'])
  })

  it('takes the platform the map\'s files show, not another one\'s file it also holds', () => {
    const android = sources({ 'src/a.js': "import './view'", 'src/view.js': '', 'src/view.ios.js': '', 'src/view.android.js': '', 'src/list.android.js': '' })
    assert.deepEqual(shown(importEdges(android).edges), ['src/a.js -> src/view.android.js [import]'])
    // As many of one as of another: none taken over the plain file.
    const tied = sources({ 'src/a.js': "import './view'", 'src/view.js': '', 'src/view.android.js': '', 'src/view.ios.js': '' })
    assert.deepEqual(shown(importEdges(tied).edges), ['src/a.js -> src/view.js [import]'])
    // Never another platform's file, which Metro does not try.
    const elsewhere = sources({ 'src/a.js': "import './view'\nimport './list'", 'src/view.android.js': '', 'src/view.ios.js': '', 'src/list.ios.js': '', 'src/x.android.js': '', 'src/y.android.js': '' })
    assert.deepEqual(shown(importEdges(elsewhere).edges), ['src/a.js -> (./list, path src/list) [import]', 'src/a.js -> src/view.android.js [import]'])
    assert.deepEqual(shown(importEdges(sources({ 'src/a.js': "import './view'", 'src/view.android.js': '', 'src/view.ios.js': '' })).edges), ['src/a.js -> (./view, path src/view) [import]'])
    // With none of a platform's files, .native, then the plain one before a browser build.
    const web = sources({ 'lib/a.js': "import './encode'\nimport './view'", 'lib/encode.js': '', 'lib/encode.browser.js': '', 'lib/view.js': '', 'lib/view.native.js': '' })
    assert.deepEqual(shown(importEdges(web).edges), ['lib/a.js -> lib/encode.js [import]', 'lib/a.js -> lib/view.native.js [import]'])
  })

  it('takes a browser or Node build in place of the file a specifier writes', () => {
    const map = sources({ 'lib/index.js': "import './encode.js'\nimport './decode.js'", 'lib/encode.browser.js': '', 'lib/decode.node.js': '' })
    assert.deepEqual(shown(importEdges(map).edges), ['lib/index.js -> lib/decode.node.js [import]', 'lib/index.js -> lib/encode.browser.js [import]'])
  })

  it('takes a compiled package\'s sources where the map holds them in place of what it publishes', () => {
    const map = sources({ 'src/a.js': "import 'p/lib/x.js'\nimport 'p/dist/esm/y.js'\nimport 'q/build/z'", 'node_modules/p/src/x.ts': '', 'node_modules/p/y.ts': '', 'node_modules/q/src/z.tsx': '' })
    assert.deepEqual(shown(importEdges(map).edges), ['src/a.js -> node_modules/p/src/x.ts [import]', 'src/a.js -> node_modules/p/y.ts [import]', 'src/a.js -> node_modules/q/src/z.tsx [import]'])
  })

  it('takes a `//`-led specifier from a URL as a URL under its scheme', () => {
    const map = sources({ 'https://origin.example/src/a.js': "import '//cdn.example/lib/b.js'", 'https://cdn.example/lib/b.js': '' })
    assert.deepEqual(shown(importEdges(map).edges), ['https://origin.example/src/a.js -> https://cdn.example/lib/b.js [import]'])
  })

  it('takes a Windows path as Node on Windows does', () => {
    const map = sources({ 'C:/app/a.js': "require('.\\\\b')\nrequire('..\\\\lib\\\\c.js')\nrequire('C:\\\\app\\\\d.js')\nrequire('C:/app/e.js')", 'C:/app/b.js': '', 'C:/lib/c.js': '', 'C:/app/d.js': '', 'C:/app/e.js': '' })
    assert.deepEqual(shown(importEdges(map).edges), ['C:/app/a.js -> C:/app/b.js [require]', 'C:/app/a.js -> C:/app/d.js [require]', 'C:/app/a.js -> C:/app/e.js [require]', 'C:/app/a.js -> C:/lib/c.js [require]'])
  })

  it('takes a file:// specifier as the path the map\'s own sources are', () => {
    const map = sources({ '/app/a.js': "import 'file:///app/b.js'\nimport 'file://server/share/c.js'", '/app/b.js': '', 'file://server/share/c.js': '' })
    assert.deepEqual(shown(importEdges(map).edges), ['/app/a.js -> //server/share/c.js [import]', '/app/a.js -> /app/b.js [import]'])
  })

  it('reads a URL whose name has a fragment, by its extension', () => {
    const map = sources({ 'https://cdn.example/entry.js#v1': "import './b.js'", 'https://cdn.example/b.js': '' })
    assert.deepEqual(shown(importEdges(map).edges), ['https://cdn.example/entry.js#v1 -> https://cdn.example/b.js [import]'])
  })

  it('reads a file whose name a bundler gave a query, by its extension', () => {
    const map = readSourceMap({ version: 3, sources: ['webpack:///./src/a.js?1a2b', 'webpack:///./src/b.js'], sourcesContent: ["import './b.js'", ''], mappings: '' })
    assert.deepEqual(shown(importEdges(map).edges), ['src/a.js?1a2b -> src/b.js [import]'])
  })
})

describe('what counts as an import', () => {
  it('leaves out statements types erase, and keeps one that only lists a type', () => {
    const map = sources({
      'a.ts': "import type { T } from './t'\nexport type { U } from './u'\nexport type * from './v'\nimport { type W } from './w'\nexport {} from './x'\nimport y = require('./y')\nimport z = Z.z\nimport type q = require('./t')",
      't.ts': '', 'u.ts': '', 'v.ts': '', 'w.ts': '', 'x.ts': '', 'y.ts': '',
    })
    assert.deepEqual(shown(importEdges(map).edges), ['a.ts -> w.ts [import]', 'a.ts -> x.ts [export-from]', 'a.ts -> y.ts [require]'])
  })

  it('reads a call of a function the caller names as taking a module, as require does', () => {
    const map = sources({ 'lib/a.js': "const c = internalBinding('crypto')\nconst b = load('./b.js')", 'flow.js': "// @flow\nconst x: ?number = internalBinding('fs')", 'lib/b.js': '' })
    const { edges } = importEdges(map, { callees: ['internalBinding', 'load'] })
    assert.deepEqual(edges.map((edge) => `${shown([edge])} ${edge.callee}`).toSorted(), [
      'flow.js -> (fs, builtin) [require] internalBinding', 'lib/a.js -> (crypto, builtin) [require] internalBinding', 'lib/a.js -> lib/b.js [require] load',
    ])
    assert.deepEqual(importEdges(map).edges, [])
  })

  it('keeps a computed specifier apart from the one spelled null', () => {
    const map = sources({ 'a.js': "require(name)\nrequire('null')", 'node_modules/null/index.js': '' })
    assert.deepEqual(shown(importEdges(map).edges), ['a.js -> () [require]', 'a.js -> node_modules/null/index.js [require]'])
  })

  it('reads every kind once per file, a template literal with nothing in it too', () => {
    const map = sources({ 'a.js': "import './b.js'\nimport './b.js'\nexport { x } from './b.js'\nrequire(`./b.js`)\nconst f = () => import('./b.js')", 'b.js': '' })
    assert.deepEqual(shown(importEdges(map).edges), ['a.js -> b.js [dynamic-import]', 'a.js -> b.js [export-from]', 'a.js -> b.js [import]', 'a.js -> b.js [require]'])
  })

  it('reads JSX in a .js file, CommonJS\'s top-level return, and not a file importing itself', () => {
    const map = sources({ 'a.js': "import B from './b'\nexport default () => <B />", 'b.js': "if (x) return\nrequire('./b')\nmodule.exports = 1" })
    assert.deepEqual(shown(importEdges(map).edges), ['a.js -> b.js [import]'])
  })
})

describe('what is not read', () => {
  it('lists a file with no content, or no script, as unscanned, and skips JSON', () => {
    const map = readSourceMap({ version: 3, sources: ['a.js', 'b.vue', 'c.json', null, 'webpack/runtime/define property getters'], sourcesContent: [null, '<template/>', null, null, ''], mappings: '' })
    const result = importEdges(map)
    assert.deepEqual(result.unscanned.map((file) => file.source), ['a.js', 'b.vue', null, 'webpack/runtime/define property getters'])
    assert.deepEqual([result.edges, result.failed], [[], []])
  })

  it('reads a file named with no extension, a bin script, or with .es6, as JavaScript', () => {
    const map = sources({ 'bin/cli': "#!/usr/bin/env node\nrequire('../lib/a.es6')", 'lib/a.es6': "import './b'", 'lib/b.js': '' })
    assert.deepEqual(shown(importEdges(map).edges), ['bin/cli -> lib/a.es6 [require]', 'lib/a.es6 -> lib/b.js [import]'])
  })

  it('lists a file that does not parse with the parser\'s error, and reads its imports with no parser: Flow, here', () => {
    const map = sources({ 'flow.js': "// @flow\nimport type { T } from './t'\nconst ok = require('./ok.js')\nfunction f(x: ?T): %checks { return !!x }", 'ok.js': "import './flow.js'", 't.js': '' })
    const result = importEdges(map)
    assert.deepEqual(result.failed.map(({ file }) => file.path), ['flow.js'])
    assert.equal(typeof result.failed[0].error, 'string')
    assert.deepEqual(shown(result.edges), ['flow.js -> ok.js [require]', 'ok.js -> flow.js [import]'])
  })
})
