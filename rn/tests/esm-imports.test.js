import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { esModuleOf } from '../src/es-module.js'
import { unmatchedImports } from '../src/esm-imports.js'

const babel = createRequire(import.meta.url)('@babel/core')
const recordOf = (code, plugins = ['flow']) => esModuleOf(babel.parseSync(code, { babelrc: false, configFile: false, sourceType: 'module', parserOpts: { plugins } }).program)

describe('esModuleOf', () => {
  it('has the names a module imports of each module, none of a namespace import, and none of a type', () => {
    const code = ["import d, { a, b as c, 'd-e' as f } from './x'", "import * as ns from './y'", "import type { T } from './t'", "import { type U, v } from './u'", "import './side'"].join('\n')
    assert.deepEqual(recordOf(code).imports, [
      { specifier: './x', names: ['default', 'a', 'b', 'd-e'] },
      { specifier: './u', names: ['v'] },
    ])
  })

  it('has the names it exports, those it exports of another module as imports of it, and the modules it exports all of', () => {
    const code = [
      'export const [p, { q, r: s, ...t }] = f(), u = 1',
      'export function g() {}',
      'export class C {}',
      'export default 1',
      'const a = 1',
      'export { a as z }',
      "export { m as n, default as o } from './m'",
      "export * from './star'",
      "export * as all from './all'",
      'export type V = 1',
      'export opaque type W = 1',
    ].join('\n')
    assert.deepEqual(recordOf(code), { imports: [{ specifier: './m', names: ['m', 'default'] }], exports: ['p', 'q', 's', 't', 'u', 'g', 'C', 'default', 'z', 'n', 'o', 'all'], stars: ['./star'] })
  })

  it("has a TS module's values, not its types", () => {
    const code = ['export enum E { A }', 'export namespace N { export const x = 1 }', 'export declare const d: number', 'export interface I {}', 'export type T = 1', "export type { U } from './u'"].join('\n')
    assert.deepEqual(recordOf(code, ['typescript']), { imports: [], exports: ['E', 'N'], stars: [] })
  })

  it('is null of a file with no import or export of a value, or of a script', () => {
    assert.equal(recordOf("const x = require('./x')\nmodule.exports = x\n"), null)
    assert.equal(recordOf("import typeof * as T from './t'\nexport type U = T\nmodule.exports = {}\n"), null)
    // A script (sourceType unambiguous, as rn has Babel parse), whatever it has, as hermes-parser may make React Native's index.js.
    assert.equal(esModuleOf({ sourceType: 'script', body: [{ type: 'ImportDeclaration', importKind: 'value', source: { value: './a' }, specifiers: [] }] }), null)
  })
})

describe('unmatchedImports', () => {
  const root = '/app'
  const at = (name) => join(root, name)
  // `modules` by name, and the files each import resolves to: { importer: { specifier: name } }.
  const check = (modules, resolved, sources = {}) => {
    const graph = new Map(Object.entries(resolved).map(([importer, specifiers]) => [at(importer), new Map(Object.entries(specifiers).map(([specifier, name]) => [specifier, name === null ? null : { type: 'sourceFile', filePath: at(name) }]))]))
    const warnings = unmatchedImports({ modules: new Map(Object.entries(modules).map(([name, module]) => [at(name), module])), graph, projectRoot: root, source: (path) => sources[path.slice(root.length + 1)] ?? null })
    return warnings.map(({ text, location }) => [text.replace(': the import is undefined, as in Metro', ''), location])
  }
  const esm = (exports = [], imports = [], stars = []) => ({ imports, exports, stars })

  it('warns of each name an ES module does not export, where the file first names it', () => {
    const modules = { 'index.js': esm([], [{ specifier: './a', names: ['default', 'there', 'nope'] }]), 'a.js': esm(['there']) }
    const source = "// first\nimport a, { there, nope } from './a'\n"
    assert.deepEqual(check(modules, { 'index.js': { './a': 'a.js' } }, { 'index.js': source }), [
      ['No matching export in "a.js" for import "default"', { file: 'index.js', line: 2, column: 31, length: 5, lineText: "import a, { there, nope } from './a'" }],
      ['No matching export in "a.js" for import "nope"', { file: 'index.js', line: 2, column: 31, length: 5, lineText: "import a, { there, nope } from './a'" }],
    ])
    // In the statement that imports it, not one importing a type alone of the module.
    const typed = "import type { T } from './a'\nimport { there,\n  nope } from './a'\n"
    assert.deepEqual(check(modules, { 'index.js': { './a': 'a.js' } }, { 'index.js': typed })[1][1], { file: 'index.js', line: 3, column: 14, length: 5, lineText: "  nope } from './a'" })
    // Located in the file alone where its text doesn't name it.
    assert.deepEqual(check(modules, { 'index.js': { './a': 'a.js' } })[1], ['No matching export in "a.js" for import "nope"', { file: 'index.js' }])
  })

  it("follows a module's `export *`s, but for `default`, through a cycle of them", () => {
    const modules = { 'index.js': esm([], [{ specifier: './a', names: ['b', 'c', 'default'] }]), 'a.js': esm([], [], ['./b']), 'b.js': esm(['b', 'default'], [], ['./c', './a']), 'c.js': esm(['c']) }
    assert.deepEqual(check(modules, { 'index.js': { './a': 'a.js' }, 'a.js': { './b': 'b.js' }, 'b.js': { './c': 'c.js', './a': 'a.js' } }), [['No matching export in "a.js" for import "default"', { file: 'index.js' }]])
  })

  it('has each module of a cycle of `export *`s export all of it, whichever is checked first', () => {
    // a.js exports all of b.js, then of c.js; b.js all of a.js.
    const modules = { 'index.js': esm([], [{ specifier: './a', names: ['x'] }, { specifier: './b', names: ['x'] }]), 'a.js': esm([], [], ['./b', './c']), 'b.js': esm([], [], ['./a']), 'c.js': esm(['x']) }
    assert.deepEqual(check(modules, { 'index.js': { './a': 'a.js', './b': 'b.js' }, 'a.js': { './b': 'b.js', './c': 'c.js' }, 'b.js': { './a': 'a.js' } }), [])
  })

  it('takes any name of a module whose exports are not known: CommonJS, or one exporting all of such a module', () => {
    const modules = { 'index.js': esm([], [{ specifier: './cjs', names: ['x'] }, { specifier: './both', names: ['y'] }, { specifier: './star', names: ['z'] }, { specifier: './gone', names: ['w'] }]), 'both.js': { ...esm([]), commonJs: true }, 'star.js': esm([], [], ['./cjs']) }
    assert.deepEqual(check(modules, { 'index.js': { './cjs': 'cjs.js', './both': 'both.js', './star': 'star.js', './gone': null }, 'star.js': { './cjs': 'cjs.js' } }), [])
  })

  it("takes any name in a TS file, where it may be a type's, as esbuild does", () => {
    for (const name of ['index.ts', 'index.tsx', 'index.mts', 'index.cts']) assert.deepEqual(check({ [name]: esm([], [{ specifier: './a', names: ['T'] }]), 'a.js': esm([]) }, { [name]: { './a': 'a.js' } }), [], name)
  })

  it('is in order of file, then line', () => {
    const modules = { 'b.js': esm([], [{ specifier: './x', names: ['p'] }, { specifier: './y', names: ['q'] }]), 'a.js': esm([], [{ specifier: './x', names: ['r'] }]), 'x.js': esm([]), 'y.js': esm([]) }
    const sources = { 'b.js': "import { q } from './y'\nimport { p } from './x'\n" }
    assert.deepEqual(check(modules, { 'b.js': { './x': 'x.js', './y': 'y.js' }, 'a.js': { './x': 'x.js' } }, sources).map(([text, { file, line }]) => [text, file, line]), [
      ['No matching export in "x.js" for import "r"', 'a.js', undefined],
      ['No matching export in "y.js" for import "q"', 'b.js', 1],
      ['No matching export in "x.js" for import "p"', 'b.js', 2],
    ])
  })
})
