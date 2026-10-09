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
    // Metro's own prelude has no source to read.
    assert.deepEqual(result.unscanned.map((file) => file.source), ['__prelude__'])
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

  it('reads a file whose name a bundler gave a query, by its extension', () => {
    const map = readSourceMap({ version: 3, sources: ['webpack:///./src/a.js?1a2b', 'webpack:///./src/b.js'], sourcesContent: ["import './b.js'", ''], mappings: '' })
    assert.deepEqual(shown(importEdges(map).edges), ['src/a.js?1a2b -> src/b.js [import]'])
  })
})

describe('what counts as an import', () => {
  it('leaves out statements types erase, and keeps one that only lists a type', () => {
    const map = sources({
      'a.ts': "import type { T } from './t'\nexport type { U } from './u'\nexport type * from './v'\nimport { type W } from './w'\nexport {} from './x'\nimport y = require('./y')\nimport z = Z.z",
      't.ts': '', 'u.ts': '', 'v.ts': '', 'w.ts': '', 'x.ts': '', 'y.ts': '',
    })
    assert.deepEqual(shown(importEdges(map).edges), ['a.ts -> w.ts [import]', 'a.ts -> x.ts [export-from]', 'a.ts -> y.ts [require]'])
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
    const map = readSourceMap({ version: 3, sources: ['a.js', 'b.vue', 'c.json', null, 'webpack/bootstrap'], sourcesContent: [null, '<template/>', null, null, ''], mappings: '' })
    const result = importEdges(map)
    assert.deepEqual(result.unscanned.map((file) => file.source), ['a.js', 'b.vue', null, 'webpack/bootstrap'])
    assert.deepEqual([result.edges, result.failed], [[], []])
  })

  it('lists a file that does not parse with the parser\'s error: Flow, here', () => {
    const map = sources({ 'flow.js': "// @flow\nimport type { T } from './t'\nfunction f(x: ?T): %checks { return !!x }", 'ok.js': "import './flow.js'" })
    const result = importEdges(map)
    assert.deepEqual(result.failed.map(({ file }) => file.path), ['flow.js'])
    assert.equal(typeof result.failed[0].error, 'string')
    assert.deepEqual(shown(result.edges), ['ok.js -> flow.js [import]'])
  })
})
