import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readSourceMap } from '@preventive/sourcemap'
import { bundleEdges, importEdges } from '@preventive/sourcemap/edges.js'
import { bundleEdges as liteEdges } from '@preventive/sourcemap/edges-lite.js'
import { bundle as fixture } from './fixtures.js'
import { handWritten as bundle, lineMap } from './helpers.js'

// A Metro bundle keeps, minified or not, the dependency ids its resolver
// picked for each module; the map says which file each module's code came
// from. Together they are the import graph as Metro built it, exactly, and
// both doors read it so: edges-lite.js with no parser.

const DOORS = [['edges.js', bundleEdges], ['edges-lite.js', liteEdges]]
const show = (edge) => `${edge.from.path} -> ${edge.to.path}`.replaceAll('/app/', '')
const shown = (read, map, code) => read(map, code).edges.map(show)

// A Metro map written by hand: each file's source, and the names its
// segments carry, a segment a line.
function metroMap(files) {
  const names = [...new Set(files.flatMap(([, , carried = []]) => carried))]
  const owners = files.flatMap(([, , carried = []], i) => (carried.length > 0 ? carried.map((name) => [i, names.indexOf(name)]) : [i]))
  return readSourceMap(lineMap(files.map(([path]) => path), owners, { sourcesContent: files.map(([, content]) => content), names }))
}

// The fixture project (see fixtures.js), every import of it, ext
// included: Metro bundles what it resolves and leaves nothing out.
const PROJECT = [
  'node_modules/cjsdep/index.js -> node_modules/cjsdep/inner.js',
  'node_modules/dep/index.js -> node_modules/dep/util.js',
  'src/a.js -> src/b.js',
  'src/index.js -> node_modules/cjsdep/index.js',
  'src/index.js -> node_modules/dep/index.js',
  'src/index.js -> node_modules/ext/index.js',
  'src/index.js -> src/a.js',
  'src/index.js -> src/dead.js',
  'src/index.js -> src/side.js',
]

for (const [door, read] of DOORS) {
  describe(`${door}: a Metro bundle's own dependency lists`, () => {
    it('give every edge of a production bundle, minified, and of a development one', () => {
      for (const name of ['metro-prod', 'metro-dev']) {
        const { edges } = read(...fixture(name))
        assert.deepEqual(edges.map(show).toSorted(), PROJECT, name)
        assert.ok(edges.every((edge) => edge.kind === 'dependency'))
      }
    })
  })

  // Bundles written out by hand, one module a line, with a flat map giving
  // each line to the file named alongside.
  describe(`${door}: every shape Metro writes a define call in`, () => {
    it('a list with an unresolved optional dependency, none, and the object a lazy import makes', () => {
      const [map, code] = bundle([
        [null, 'var __BUNDLE_START_TIME__=0;'],
        ['a.js', '__d(function(g,r,i,a,m,e,d){r(d[0]);r(d[1]);r(d[2])},0,[1,null,2]);'],
        ['b.js', '__d(function(g,r,i,a,m,e,d){},1);'],
        ['c.js', '__d(function(g,r,i,a,m,e,d){r(d[1])(d[0],d.paths)},2,{"0":3,"1":1,"paths":{"3":"/d.bundle"}});'],
        ['d.js', '__d(function(g,r,i,a,m,e,d){},3,null,"d.js");'],
        [null, '__r(0);'],
      ])
      assert.deepEqual(shown(read, map, code), ['a.js -> b.js', 'a.js -> c.js', 'c.js -> d.js', 'c.js -> b.js'])
    })

    it('ids inlined into the code, a global prefix, string ids, an arrow factory', () => {
      const [map, code] = bundle([
        ['a.js', 'p__d(function(g,req,def,all,m,e){req(1);def("b");all(1);req(x);x={...req(2)};x.req(3);this.#req(3)},0,{"paths":{}});'],
        ['b.js', 'p__d((g,r)=>{},1);'],
        ['c.js', 'p__d(function(){},"b");'],
        ['d.js', 'p__d(function(){},2);'],
        ['e.js', 'p__d(function(){},3);'],
      ])
      assert.deepEqual(shown(read, map, code), ['a.js -> b.js', 'a.js -> c.js', 'a.js -> d.js'])
    })

    it('names a module by the file most of its code maps to, in a flat map too', () => {
      // The factory's first line maps to a helper's file; most of it, to m.js.
      const [map, code] = bundle([
        ['helper.js', '__d(function(g,r,i,a,m,e,d){'],
        ['m.js', 'r(d[0]);'],
        ['m.js', 'm.exports=1'],
        ['dep.js', '},0,[1]);'],
        ['dep.js', '__d(function(){},1);'],
      ])
      assert.deepEqual(shown(read, map, code), ['m.js -> dep.js'])
    })

    it('names a module with no code mapped, JSON or a bare re-export, by the file its map lists between its neighbours\'', () => {
      const map = readSourceMap(lineMap(['a.js', 'b.json', 'c.js'], [0, null, 2]))
      const code = ['__d(function(g,r,i,a,m,e,d){r(d[0]);r(d[1])},0,[1,2]);', '__d(function(g,r,i,a,m,e,d){m.exports={}},1);', '__d(function(g,r,i,a,m,e,d){r(d[0])},2,[1]);']
      assert.deepEqual(shown(read, map, code.join('\n')), ['a.js -> b.json', 'a.js -> c.js', 'c.js -> b.json'])
      // An entry with none, ahead of the first module that has: by the
      // prelude's place before it.
      const entry = readSourceMap(lineMap(['__prelude__', 'index.json', 'a.js'], [0, null, 2]))
      const bundled = ['var __BUNDLE_START_TIME__=0;', '__d(function(g,r,i,a,m,e,d){m.exports={}},0,[1]);', '__d(function(g,r,i,a,m,e,d){r(d[0])},1,[0]);']
      assert.deepEqual(shown(read, entry, bundled.join('\n')), ['index.json -> a.js', 'a.js -> index.json'])
    })

    it('leaves no edge to an id the bundle does not define, or to a module with no file', () => {
      const [map, code] = bundle([['a.js', '__d(function(){},0,[1,3,0]);'], [null, '__d(function(){},1);'], ['b.js', '__d(function(){},2,[1]);']])
      assert.deepEqual(shown(read, map, code), [])
    })

    it('says which module it cannot read', () => {
      const [map] = bundle([['a.js', '']])
      for (const broken of ['__d(function(){', '__d(function(){},x,[])', '__d(function(){},0,[1],"a",2)']) {
        assert.throws(() => read(map, `var a\n${broken}`), /bundleEdges: the Metro module at line 2 ends in no define params/u, broken)
      }
    })
  })

  // With no bundle: each file's own imports, read with no parser, and what
  // Babel adds by the names Metro mapped; the files' order, the walk Metro
  // made, places what no file says.
  describe(`${door}: a Metro map alone`, () => {
    it('gives the fixture project\'s every edge, minified or not', () => {
      for (const name of ['metro-prod', 'metro-dev']) assert.deepEqual(shown(read, fixture(name)[0]).toSorted(), PROJECT, name)
    })

    it('knows the prelude beneath a sourceRoot', () => {
      const map = readSourceMap({ version: 3, sourceRoot: '/app/', sources: ['__prelude__', 'a.js', 'b.js'], sourcesContent: ['', "require('./b')", ''], mappings: '' })
      assert.deepEqual(shown(read, map), ['a.js -> b.js'])
    })

    it('Babel\'s helpers and JSX runtime by name, an asset\'s registry and a package\'s entry by order, an import()\'s asyncRequire', () => {
      const map = metroMap([
        ['__prelude__', ''],
        ['/app/index.js', "import App from './App'\nimport('./lazy')", ['_interopRequireDefault', '_jsxRuntime']],
        ['/app/App.js', "import { View } from 'pkg'\nconst logo = require('./logo.png')", ['_classCallCheck2']],
        ['/app/node_modules/@babel/runtime/helpers/interopRequireDefault.js', ''],
        ['/app/node_modules/react/jsx-runtime.js', ''],
        ['/app/node_modules/pkg/lib/module/index.js', "export * from './View'"],
        ['/app/node_modules/pkg/lib/module/View.js', ''],
        ['/app/logo.png', ''],
        ['/app/node_modules/react-native/Libraries/Image/AssetRegistry.js', ''],
        ['/app/node_modules/@babel/runtime/helpers/classCallCheck.js', ''],
        ['/app/node_modules/metro-runtime/src/modules/asyncRequire.js', ''],
        ['/app/lazy.js', ''],
        // A prebuilt file's own helper, not Babel's import of one.
        ['/app/node_modules/prebuilt/index.js', 'function _interopRequireDefault(o) { return o }', ['_interopRequireDefault']],
        ['/app/node_modules/prebuilt/class.js', 'function _classCallCheck2(a, b) {}', ['_classCallCheck2']],
      ])
      assert.deepEqual(shown(read, map).toSorted(), [
        'App.js -> logo.png',
        'App.js -> node_modules/@babel/runtime/helpers/classCallCheck.js',
        'App.js -> node_modules/@babel/runtime/helpers/interopRequireDefault.js',
        'App.js -> node_modules/pkg/lib/module/index.js',
        'index.js -> App.js',
        'index.js -> lazy.js',
        'index.js -> node_modules/@babel/runtime/helpers/interopRequireDefault.js',
        'index.js -> node_modules/metro-runtime/src/modules/asyncRequire.js',
        'index.js -> node_modules/react/jsx-runtime.js',
        'logo.png -> node_modules/react-native/Libraries/Image/AssetRegistry.js',
        'node_modules/pkg/lib/module/index.js -> node_modules/pkg/lib/module/View.js',
      ])
    })
  })
}

describe('edges-lite.js reads Metro\'s output alone', () => {
  it('and throws for any other, which edges.js reads', () => {
    for (const name of ['esbuild', 'esbuild-min', 'rollup']) {
      assert.throws(() => liteEdges(...fixture(name)), /bundleEdges: not a Metro bundle/u, name)
      assert.ok(bundleEdges(...fixture(name)).edges.length > 0, name)
    }
    const [map, code] = bundle([['a.js', 'define(function(){},0,[1]);__d(function(){},1,[])']])
    assert.throws(() => liteEdges(map, code), /not a Metro bundle/u)
    assert.deepEqual(bundleEdges(map, code), { edges: [] })
  })
})

describe('a map alone, with no Metro prelude, is no Metro map', () => {
  it('edges.js reads its sources, as importEdges does; edges-lite.js has nothing to read', () => {
    for (const name of ['esbuild', 'webpack-production']) {
      const [map] = fixture(name)
      assert.deepEqual(bundleEdges(map), { edges: importEdges(map).edges }, name)
      assert.throws(() => liteEdges(map), /bundleEdges: not a Metro map/u, name)
    }
  })
})
