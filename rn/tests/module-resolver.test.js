import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { resolverOf } from '../src/module-resolver.js'

// rn's own, of @babel/core, whose helpers transform-runtime may write.
const root = fileURLToPath(new URL('..', import.meta.url))
const file = join(root, 'src/app.js')
const alias = { '#lib': './lib' }
const source = "import a from '#lib/a'\n"
// Of module-resolver of these options, and the file's other plugins.
const of = (options, contents, plugins = []) => resolverOf(options, contents, new Map([['module-resolver', options], ...plugins]), file, root)

describe('resolverOf, of babel-plugin-module-resolver', () => {
  it('maps its aliases as the bundle resolves each import, Babel without it, of aliases alone, each to a relative path', () => {
    assert.deepEqual(of({ alias }, source), { alias, cwd: process.cwd() })
    assert.deepEqual(of({ alias, cwd: '/p' }, "export * from '#lib/a'\nrequire('#lib/b')\nimport('#lib/c')\n"), { alias, cwd: '/p' })
    // Of no string of its aliases: nothing to do.
    assert.equal(of({ alias }, "import a from './a'\n"), null)
    // Of none in the config.
    assert.equal(resolverOf(undefined, source, new Map(), file, root), 'babel')
  })

  it('keeps it in Babel where it maps what the bundle would not, or as it would not', () => {
    for (const options of [{ alias: [alias] }, { alias: { '#lib': ['./lib'] } }, { alias, root: ['./src'] }, { alias, cwd: 'packagejson' }, { alias, resolvePath: () => null }, { alias: { '#lib': 'lib' } }]) {
      assert.equal(of(options, source), 'babel', JSON.stringify(options))
    }
    // Of a call of whose argument it maps a string, but require's.
    const calls = [
      ...["require.resolve('#lib/a')", "jest.mock('#lib/a')", "jest . doMock('#lib/a')", "System.import('#lib/a')", "custom('#lib/a')", "custom.of('#lib/a')"],
      // Of comments between its tokens, a member of a string in brackets, in parentheses, as Babel matches the callee.
      ...["jest.mock /* c */ ('#lib/a')", "jest./* c */mock('#lib/a')", "jest\n  // c\n  .mock('#lib/a')", "jest['mock']('#lib/a')", 'jest[ "mock" ] (\'#lib/a\')', "(jest.mock)('#lib/a')", "(jest).mock('#lib/a')"],
      // Of TS's type arguments.
      ...["jest.mock<typeof import('#lib/a')>('#lib/a')", "custom<string>('#lib/a')", "jest.mock /* c */ <T>('#lib/a')"],
      // Of a member in brackets, of any string: of a member of what it is of.
      ...["jest[('mock')]('#lib/a')", 'jest[`mock`](\'#lib/a\')', "(jest) /* c */ ['mock']('#lib/a')", "custom[('of')]('#lib/a')"],
    ]
    for (const call of calls) {
      assert.equal(of({ alias, transformFunctions: ['custom', 'custom.of'] }, `${call}\n${source}`), 'babel', call)
    }
    for (const call of ["notjest.mock('x')", "x.jest.mock('x')", "jest.mocks('x')", "jest.mock.call('x')"]) assert.notEqual(of({ alias }, `${call}\n${source}`), 'babel', call)
    // Of a require of the file's own, whose calls esbuild resolves not.
    for (const bound of ['export function load(require) { return require(\'#lib/a\') }', "const f = (require) => require('#lib/a')", "const require = make()\nrequire('#lib/a')", 'function require(name) {}', 'function* require() {}', "import { require } from 'x'", 'const { require } = x', 'catch (require) {}']) {
      assert.equal(of({ alias }, `${bound}\n${source}`), 'babel', bound)
    }
    for (const unbound of ["const b = require('#lib/b')", "require  ('#lib/b')", "require\n  .resolve", 'x.require = 1', 'it is required']) assert.notEqual(of({ alias }, `${unbound}\n${source}`), 'babel', unbound)
    // Of types, as Babel's input has them erased (esbuild's), or not, which Babel erases itself.
    for (const [ts, erased] of [["jest.mock!('#lib/a')", "jest.mock('#lib/a');"], ["(jest as any).mock('#lib/a')", "jest.mock('#lib/a');"]]) {
      assert.equal(resolverOf({ alias }, `${ts}\n${source}`, new Map([['module-resolver', { alias }]]), file, root, `${erased}\nimport a from "#lib/a";\n`), 'babel', ts)
    }
    assert.equal(resolverOf({ alias }, source, new Map([['module-resolver', { alias }]]), file, root, source), 'babel')
    assert.notEqual(resolverOf({ alias }, source, new Map([['module-resolver', { alias }]]), file, root, 'import a from "#lib/a";\n'), 'babel')
    // Of an escape of a code point, which it may map.
    assert.equal(of({ alias }, "import a from '\\u0023lib/a'\n"), 'babel')
    // Where an alias matches a helper transform-runtime may write.
    assert.equal(of({ alias: { '^@babel/runtime/(.+)$': './runtime/\\1' } }, source, [['transform-runtime', {}]]), 'babel')
  })

  it('keeps it in Babel where a plugin of the file may read a specifier unlike of its alias and of where it maps it', () => {
    assert.equal(of({ alias }, source, [['noop', {}]]), 'babel')
    assert.notEqual(of({ alias }, source, [['/p/node_modules/@react-native/babel-preset/src/index.js.overrides[5]$1', {}], ['transform-classes', {}], ['worklets', {}], ['inline-requires', { ignoredRequires: ['react'] }]]), 'babel')
    // Reanimated's of bundle mode, which takes a relative import for one of a package.
    assert.equal(of({ alias }, source, [['worklets', { bundleMode: true }]]), 'babel')
    // CommonJS, of lazy imports and interop by the source.
    for (const options of [{ lazy: true }, { lazy: ['#lib/a'] }, { lazy: (from) => from.startsWith('#') }, { importInterop: (from) => (from.startsWith('#') ? 'none' : 'babel') }, { importInterop: (from, by) => (by === file && from.startsWith('#') ? 'none' : 'babel') }, { instances: [{}, { lazy: true }] }]) {
      assert.equal(of({ alias }, source, [['transform-modules-commonjs', options]]), 'babel', String(options.lazy ?? options.importInterop))
    }
    assert.notEqual(of({ alias }, source, [['transform-modules-commonjs', { lazy: (from) => from === 'other' }]]), 'babel')
    // Metro's inlining, by the names it leaves.
    assert.equal(of({ alias }, source, [['inline-requires', { ignoredRequires: ['#lib/a'] }]]), 'babel')
    assert.equal(of({ alias }, source, [['inline-requires', { nonMemoizedModules: ['#lib/a'] }]]), 'babel')
    // And @babel/runtime's, which it inlines not, of no transform-runtime that writes them.
    assert.equal(of({ alias: { '@babel/runtime': './runtime' } }, "var h = require('@babel/runtime/helpers/custom')\n", [['inline-requires', {}]]), 'babel')
    assert.notEqual(of({ alias: { '@babel/runtime': './runtime' } }, "var h = require('@babel/runtime/helpers/custom')\n"), 'babel')
    // react-native's deep imports, warned of by their specifier.
    assert.equal(of({ alias: { 'react-native': './shim' } }, "import 'react-native/Libraries/x'\n", [['warn-on-deep-imports', {}]]), 'babel')
  })
})
