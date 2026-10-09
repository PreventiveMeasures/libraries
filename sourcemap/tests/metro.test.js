import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { metroEdges } from '@preventive/sourcemap/edges.js'
import { bundle as fixture } from './fixtures.js'
import { handWritten as bundle } from './helpers.js'

// A Metro bundle keeps, minified or not, the dependency ids its resolver
// picked for each module; the map's sections say which file each module
// is. Together they are the import graph as Metro built it, exactly.

const show = (edge) => `${edge.from.path} -> ${edge.to.path}`.replaceAll('/app/', '')

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

describe('a Metro bundle\'s own dependency lists', () => {
  it('give every edge of a production bundle, minified, ids named by the map alone', () => {
    const { modules, edges } = metroEdges(...fixture('metro-prod'))
    assert.deepEqual(edges.map(show).toSorted(), PROJECT)
    assert.ok(edges.every((edge) => edge.kind === 'dependency'))
    assert.deepEqual(modules.map((m) => [m.id, m.name, m.file.path.replace('/app/', '')]).slice(0, 3), [[0, null, 'src/index.js'], [1, null, 'src/a.js'], [2, null, 'src/b.js']])
    assert.deepEqual(modules[0].dependencies, [1, 3, 4, 5, 7, 9])
  })

  it('and of a development bundle, with the names it spells', () => {
    const { modules, edges } = metroEdges(...fixture('metro-dev'))
    assert.deepEqual(edges.map(show).toSorted(), PROJECT)
    for (const module of modules) assert.equal(module.file.path, `/app/${module.name}`)
  })
})

// Below, bundles written out by hand, one module a line, with a flat map
// giving each line to the file named alongside.
describe('every shape Metro writes a define call in', () => {
  it('a list with an unresolved optional dependency, none, and the object a lazy import makes', () => {
    const [code, map] = bundle([
      [null, 'var __BUNDLE_START_TIME__=0;'],
      ['a.js', '__d(function(g,r,i,a,m,e,d){r(d[0]);r(d[1]);r(d[2])},0,[1,null,2]);'],
      ['b.js', '__d(function(g,r,i,a,m,e,d){},1);'],
      ['c.js', '__d(function(g,r,i,a,m,e,d){r(d[1])(d[0],d.paths)},2,{"0":3,"1":1,"paths":{"3":"/d.bundle"}});'],
      ['d.js', '__d(function(g,r,i,a,m,e,d){},3,null,"d.js");'],
      [null, '__r(0);'],
    ])
    const { modules, edges } = metroEdges(code, map)
    assert.deepEqual(modules.map((m) => [m.id, m.file.path, m.name, m.dependencies]), [
      [0, 'a.js', null, [1, null, 2]], [1, 'b.js', null, []], [2, 'c.js', null, [3, 1]], [3, 'd.js', 'd.js', []],
    ])
    assert.deepEqual(edges.map(show), ['a.js -> b.js', 'a.js -> c.js', 'c.js -> d.js', 'c.js -> b.js'])
  })

  it('ids inlined into the code, a global prefix, string ids, an arrow factory', () => {
    const [code, map] = bundle([
      ['a.js', 'p__d(function(g,req,def,all,m,e){req(1);def("b");all(1);req(x)},0,{"paths":{}});'],
      ['b.js', 'p__d((g,r)=>{},1);'],
      ['c.js', 'p__d(function(){},"b");'],
    ])
    const { modules, edges } = metroEdges(code, map)
    assert.deepEqual(modules.map((m) => [m.id, m.dependencies]), [[0, [1, 'b']], [1, []], ['b', []]])
    assert.deepEqual(edges.map(show), ['a.js -> b.js', 'a.js -> c.js'])
  })

  it('names a module by most of its factory where the map has no sections', () => {
    // The factory's first line maps to a helper's file; most of it, to m.js.
    const [code, map] = bundle([
      ['helper.js', '__d(function(g,r,i,a,m,e,d){'],
      ['m.js', 'r(d[0]);'],
      ['m.js', 'm.exports=1'],
      ['dep.js', '},0,[1]);'],
      ['dep.js', '__d(function(){},1);'],
    ])
    assert.deepEqual(metroEdges(code, map).modules.map((m) => m.file.path), ['m.js', 'dep.js'])
  })

  it('leaves no edge to an id the bundle does not define, or to a module with no file', () => {
    const [code, map] = bundle([['a.js', '__d(function(){},0,[1,2,0]);'], [null, '__d(function(){},1);']])
    const { modules, edges } = metroEdges(code, map)
    assert.deepEqual(modules.map((m) => [m.id, m.file?.path ?? null, m.dependencies]), [[0, 'a.js', [1, 2, 0]], [1, null, []]])
    assert.deepEqual(edges, [])
  })

  it('finds no module where no line starts one, and says which module it cannot read', () => {
    const [code, map] = bundle([['a.js', 'define(function(){},0,[1]);__d(function(){},1,[])']])
    assert.deepEqual(metroEdges(code, map), { modules: [], edges: [] })
    for (const broken of ['__d(function(){', '__d(function(){},x,[])', '__d(function(){},0,[1],"a",2)']) {
      assert.throws(() => metroEdges(`var a\n${broken}`, map), /metroEdges: the module at line 2 ends in no define params/u, broken)
    }
  })
})
