import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { memoized, printed, writeTree } from './fixtures.js'
import { BIN, linked } from './rn-bundle-app.js'

describe('rn-bundle, with Babel, with Babel\'s TS plugin in the config', () => {
  // As @react-native/babel-preset has the TS plugin, for .ts and .tsx, and
  // its codegen; __FIELDS__ is the number of class fields Babel gets.
  const config = (options) => [
    'module.exports = {',
    "  plugins: ['@react-native/babel-plugin-codegen', '@babel/plugin-transform-react-jsx', ({ types: t }) => ({ pre() { this.fields = 0 }, visitor: { ClassProperty() { this.fields++ }, Identifier(path) { if (path.node.name === '__FIELDS__') path.replaceWith(t.numericLiteral(this.fields)) } } })],",
    '  overrides: [',
    `    { test: /\\.ts$/, plugins: [['@babel/plugin-transform-typescript', ${JSON.stringify(options)}]] },`,
    `    { test: /\\.tsx$/, plugins: [['@babel/plugin-transform-typescript', ${JSON.stringify({ ...options, isTSX: true })}]] },`,
    '  ],',
    '}',
    '',
  ].join('\n')
  const { root, cleanup } = writeTree({
    'babel.config.js': config({}),
    'main.ts': [
      "import { type Effect } from './effect'",
      "import { Mark } from './mark'",
      "import { view } from './view'",
      "import { pragma } from './pragma'",
      "import { Child, fields } from './fields'",
      "import Button from './ButtonNativeComponent'",
      'const effects: Effect[] = (globalThis as any).effects ?? []',
      'const mark: Mark | null = null',
      'const button = { name: (Button as any).name, color: (Button as any).config.validAttributes.color }',
      'console.log(JSON.stringify({ effects, view: view(), pragma: pragma(), field: new Child().value ?? null, fields, button }))',
      '',
    ].join('\n'),
    // Has a side effect; imported only for its type.
    'effect.ts': ";((globalThis as any).effects ??= []).push('effect')\nexport type Effect = string\n",
    'mark.ts': ";((globalThis as any).effects ??= []).push('mark')\nexport type Mark = string\n",
    // React, which only JSX uses, for the classic runtime.
    'view.tsx': "import React from 'react'\nexport const view = () => <b>view</b>\n",
    // React, which only types use, in TSX with no JSX: dropped.
    'kind.ts': "import { kind } from './kind-of'\nconsole.log(JSON.stringify({ kind, react: (globalThis as any).react ?? false }))\n",
    'kind-of.tsx': "import React from 'react'\nexport type Element = React.ReactElement\nexport const kind = 'tsx'\n",
    // A JSX pragma, which esbuild would drop with the comment.
    'pragma.tsx': "/** @jsx p */\nimport { h as p } from './h'\nexport const pragma = () => <i>pragma</i>\n",
    'h.ts': 'export const h = (type: string, props: unknown, ...children: unknown[]) => ({ type, children })\n',
    'fields.ts': "class Base { value: string = 'base' }\nexport class Child extends Base { value: string }\nexport const fields = __FIELDS__\n",
    // The codegen makes a view config of the props it reads off the spec's types.
    'ButtonNativeComponent.ts': [
      "import type { ViewProps } from 'react-native'",
      "import codegenNativeComponent from 'react-native/Libraries/Utilities/codegenNativeComponent'",
      'interface NativeProps extends ViewProps {',
      '  color?: string',
      '}',
      "export default codegenNativeComponent<NativeProps>('Button')",
      '',
    ].join('\n'),
    'node_modules/react/package.json': { name: 'react', version: '19.0.0' },
    'node_modules/react/index.js': 'globalThis.react = true\nexports.createElement = (type, props, ...children) => ({ type, children })\n',
    'node_modules/react-native/package.json': { name: 'react-native', version: '0.81.0' },
    'node_modules/react-native/Libraries/Utilities/codegenNativeComponent.js': 'module.exports = (name) => name\n',
    'node_modules/react-native/Libraries/NativeComponent/NativeComponentRegistry.js': 'exports.get = (name, config) => ({ name, config: config() })\n',
    'node_modules/react-native/Libraries/NativeComponent/ViewConfigIgnore.js': 'exports.ConditionallyIgnoredEventHandlers = (handlers) => handlers\n',
    'node_modules/@babel/core': linked('@babel/core'),
    'node_modules/@babel/plugin-transform-react-jsx': linked('@babel/plugin-transform-react-jsx'),
    'node_modules/@babel/plugin-transform-typescript': linked('@babel/plugin-transform-typescript'),
    'node_modules/@react-native/babel-plugin-codegen': linked('@react-native/babel-plugin-codegen'),
  })
  after(cleanup)
  const build = memoized((options, entry = 'main.ts', ...args) => {
    writeFileSync(join(root, 'babel.config.js'), config(options))
    const r = spawnSync(process.execPath, [BIN, '--platform=ios', ...args, '--output=main.out.js', entry], { cwd: root, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    return JSON.parse(printed(join(root, 'main.out.js')))
  })

  it('makes TS JS by esbuild as the plugin would by default; a file with a JSX pragma or a native component spec, Babel takes as it is', () => {
    assert.deepEqual(build({}), { effects: [], view: { type: 'b', children: ['view'] }, pragma: { type: 'i', children: ['pragma'] }, field: 'base', fields: 0, button: { name: 'Button', color: true } })
    assert.deepEqual(build({}, 'kind.ts'), { kind: 'tsx', react: false })
  })

  it('leaves TS to Babel, where the plugin keeps imports or fields otherwise', () => {
    for (const args of [[], ['--esm']]) {
      assert.deepEqual(build({ onlyRemoveTypeImports: true }, 'main.ts', ...args).effects, ['effect', 'mark'])
      const { field, fields } = build({ allowDeclareFields: true }, 'main.ts', ...args)
      assert.deepEqual([field, fields], [null, 2])
    }
  })

  it('with --esm, loads TS as the JS Babel makes of it', () => {
    assert.deepEqual(build({}, 'main.ts', '--esm'), build({}))
  })
})

describe('rn-bundle, with Babel, with Babel plugins for what esbuild lowers before it', () => {
  // Under the keys of Babel's plugins, plugins that only record each file they run on.
  const KEYS = ['transform-arrow-functions', 'transform-async-to-generator', 'transform-async-generator-functions', 'transform-export-namespace-from', 'transform-numeric-separator', 'syntax-hermes-parser', 'transform-flow-strip-types', 'transform-typescript']
  const config = (options) => [
    "const ran = (name) => ({ template }) => ({ name, visitor: { Program: { exit(path) { path.pushContainer('body', template.statement.ast('(globalThis.ran ??= []).push(' + JSON.stringify(name) + ')')) } } } })",
    `module.exports = { plugins: [${KEYS.map((key) => `[ran(${JSON.stringify(key)}), ${JSON.stringify(options[key] ?? {})}]`).join(', ')}] }`,
    '',
  ].join('\n')
  const { root, cleanup } = writeTree({
    'main.js': [
      "import { ns } from './lib/reexport'",
      "import { load, twice } from './lib/work'",
      "import { typed } from './lib/typed'",
      "import { spec } from './lib/spec'",
      'load().then((out) => console.log(JSON.stringify({ out, one: ns.one, typed, spec, arrow: String(twice).includes("=>"), ran: globalThis.ran })))',
      '',
    ].join('\n'),
    'lib/reexport.js': "export * as ns from './ns'\n",
    'lib/ns.js': 'export const one = 1_000\n',
    'lib/work.js': 'export const twice = (x) => x * 2\nasync function* gen() { yield 1; yield 2 }\nexport async function load() { const out = []; for await (const x of gen()) out.push(twice(x)); return out }\n',
    'lib/typed.ts': 'export const typed: number = 1\n',
    // Taken by Babel as it is, with each plugin.
    'lib/spec.js': "export const spec = 'codegenNativeComponent'\n",
    'node_modules/@babel/core': linked('@babel/core'),
  })
  after(cleanup)
  const build = (options, args = []) => {
    writeFileSync(join(root, 'babel.config.js'), config(options))
    const r = spawnSync(process.execPath, [BIN, '--platform=ios', ...args, '--output=main.out.js', 'main.js'], { cwd: root, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    // In a process of its own: it prints once its async functions are done.
    const { ran, ...out } = JSON.parse(spawnSync(process.execPath, [join(root, 'main.out.js')], { encoding: 'utf8' }).stdout)
    return { ...out, ran: Object.fromEntries(KEYS.map((key) => [key, ran.filter((name) => name === key).length])), code: readFileSync(join(root, 'main.out.js'), 'utf8'), stderr: r.stderr }
  }
  const once = Object.fromEntries(KEYS.map((key) => [key, 1]))
  const js = { 'transform-flow-strip-types': 5, 'transform-typescript': 5 }

  it('lowers by esbuild what such a plugin with no options lowers, and leaves it out of Babel, with those that have nothing to do after esbuild', () => {
    const { code, stderr, ...out } = build({})
    assert.ok(!stderr.includes('Babel:'), 'no profile without --profile')
    // Flow's plugin, which drops fields with no value, and TS's stay for JS:
    // both are left out for TS alone. Arrows esbuild doesn't lower.
    assert.deepEqual(out, { out: [2, 4], one: 1000, typed: 1, spec: 'codegenNativeComponent', arrow: true, ran: { ...once, ...js, 'transform-arrow-functions': 6 } })
    assert.ok(code.includes('__asyncGenerator(') && code.includes('__forAwait('))
  })

  it('reports with --profile the files, visitor calls and time of each plugin', () => {
    const { stderr } = build({}, ['--profile'])
    assert.match(stderr, /^Babel: 6 files, \d+ ms, summed over its threads\n {6}ms {7}% {4}files {6}calls {2}plugin$/mu)
    assert.match(stderr, /^ +\d+ +[\d.]+ +\d+ +\d+ {2}internal\.blockHoist$/mu)
    assert.match(stderr, /^ {6}ms {7}% {4}files {6}calls {2}Babel, outside plugins\n(?: +\d+ +[\d.]+ +6 +\d+ {2}(?:config|parsing|scopes|printing)\n){4} +\d+ +[\d.]+ {22}traversal, and the rest$/mu)
    // Each plugin's one visitor runs once in each file it is in.
    const rows = Object.fromEntries([...stderr.matchAll(/^ +\d+ +[\d.]+ +(\d+) +(\d+) {2}(\S+)$/gmu)].map(([, files, calls, key]) => [key, [Number(files), Number(calls)]]))
    const counts = { ...once, ...js, 'transform-arrow-functions': 6 }
    assert.deepEqual(Object.fromEntries(KEYS.map((key) => [key, rows[key]])), Object.fromEntries(KEYS.map((key) => [key, [counts[key], counts[key]]])))
  })

  it('leaves to Babel what a plugin with options lowers', () => {
    const { code, ran } = build({ 'transform-async-to-generator': { module: 'bluebird', method: 'coroutine' } })
    assert.deepEqual(ran, { ...once, ...js, 'transform-arrow-functions': 6, 'transform-async-to-generator': 6 })
    assert.ok(/async function load\(/u.test(code) && code.includes('__asyncGenerator('))
  })
})

describe('rn-bundle, with Babel, with a Babel config that lowers let and const', () => {
  // As @react-native/babel-preset lowers them for Hermes, whose own don't
  // bind each iteration of a loop apart; a plugin of that key, which here
  // lowers nothing.
  const config = (plugins, rest = '') => `module.exports = { ${rest}plugins: [${plugins.join(', ')}] }\n`
  const { root, cleanup } = writeTree({
    // esbuild's __copyProps makes each of c.cjs's exports a getter, in a loop.
    'main.js': "import * as c from './c.cjs'\nconsole.log(JSON.stringify(Object.keys(c).map((key) => [key, c[key]])))\n",
    'c.cjs': 'exports.a = 1\nexports.b = 2\n',
    'left.js': 'let left = 1\nconsole.log(left)\n',
    'late.js': "console.log('early')\n",
    // The words alone, in strings: no let or const of Babel's output.
    'words.js': "console.log('let', 'const')\n",
    // A return outside a function, which the config's parser options take.
    'returns.js': "if (globalThis.skip) return\nconsole.log('const')\n",
    'node_modules/@babel/core': linked('@babel/core'),
  })
  after(cleanup)
  const build = (plugins, entry = 'main.js', rest = '') => {
    writeFileSync(join(root, 'babel.config.js'), config(plugins, rest))
    return spawnSync(process.execPath, [BIN, '--platform=ios', '--output=out.js', entry], { cwd: root, encoding: 'utf8' })
  }
  const blockScoping = "() => ({ name: 'transform-block-scoping', visitor: {} })"
  // As Reanimated's worklets: a const put in once block scoping has run.
  const late = "({ template }) => ({ post(file) { file.path.pushContainer('body', template.statements.ast('const late = 1; console.log(late)')) } })"
  const lowers = "() => ({ name: 'transform-block-scoping', visitor: { VariableDeclaration(path) { path.node.kind = 'var' } } })"

  it("adds no let or const after Babel: esbuild's helpers bind each key apart", () => {
    const r = build([blockScoping])
    assert.equal(r.status, 0, r.stderr)
    const code = readFileSync(join(root, 'out.js'), 'utf8')
    assert.ok(!/\b(?:let|const)\b/u.test(code), code)
    assert.deepEqual(JSON.parse(printed(join(root, 'out.js'))), [['default', { a: 1, b: 2 }], ['a', 1], ['b', 2]])
  })

  it("lowers again by the config's plugin what Babel's others leave of let and const after it", () => {
    const r = build([late, lowers], 'late.js')
    assert.equal(r.status, 0, r.stderr)
    const code = readFileSync(join(root, 'out.js'), 'utf8')
    assert.ok(!/\b(?:let|const)\b/u.test(code), code)
    assert.equal(printed(join(root, 'out.js')), 'early\n1\n')
  })

  it("parses Babel's output again as its config's parser options have it", () => {
    const r = build([late, lowers], 'returns.js', 'parserOpts: { allowReturnOutsideFunction: true }, ')
    assert.equal(r.status, 0, r.stderr)
    assert.equal(printed(join(root, 'out.js')), 'const\n1\n')
  })

  it('runs Babel again only over output that declares a let or const, not where the words are alone', () => {
    const log = join(root, 'passes.log')
    // The config's block scoping, which notes each file it runs in.
    const noting = `() => ({ name: 'transform-block-scoping', pre(file) { require('fs').appendFileSync(${JSON.stringify(log)}, require('path').basename(file.opts.filename) + '\\n') }, visitor: { VariableDeclaration(path) { path.node.kind = 'var' } } })`
    const passes = (plugins, entry) => {
      rmSync(log, { force: true })
      const r = build(plugins, entry)
      assert.equal(r.status, 0, r.stderr)
      return readFileSync(log, 'utf8')
    }
    assert.equal(passes([late, noting], 'late.js'), 'late.js\nlate.js\n')
    assert.equal(passes([noting], 'words.js'), 'words.js\n')
  })

  it('fails on a let or const Babel leaves', () => {
    const r = build([blockScoping], 'left.js')
    assert.equal(r.status, 1)
    assert.match(r.stderr, /Transforming let to the configured target environment/u)
  })

  it('leaves them to esbuild where the config keeps them', () => {
    const r = build([])
    assert.equal(r.status, 0, r.stderr)
    assert.match(readFileSync(join(root, 'out.js'), 'utf8'), /for \(let key of/u)
  })
})

describe('rn-bundle --esm, with a Babel config that makes modules CommonJS', () => {
  const { root, cleanup } = writeTree({
    'babel.config.js': "module.exports = { plugins: ['@babel/plugin-transform-modules-commonjs'] }\n",
    'index.js': [
      "import make, { named } from './lib/cjs'",
      "import { used } from './lib/named'",
      "import { area } from './lib/shapes'",
      "import { viaExports } from './lib/bound'",
      "import { partial } from './lib/partial'",
      "import cond from 'cond'",
      "import required from './lib/required'",
      "import { fromMjs } from './lib/node.mjs'",
      "const esm = require('./lib/esm')",
      'console.log(JSON.stringify({ made: make(), named, used, area: area(3), viaExports: viaExports(), partial, cond, required, esm: [esm.default, esm.value], fromMjs }))',
      '',
    ].join('\n'),
    'lib/cjs.js': "module.exports = () => 'made'\nmodule.exports.named = 'named'\n",
    // An .mjs file, taken as any other, as Metro does: its default import
    // of a compiled module, which says it is an ES module, its exports.default.
    'lib/node.mjs': "import compiled from './compiled'\nexport const fromMjs = compiled\n",
    'lib/compiled.js': "Object.defineProperty(exports, '__esModule', { value: true })\nexports.default = 'mjs'\n",
    'lib/named.js': "export const used = 'used'\nexport const unused = 'UNUSED-EXPORT'\n",
    'lib/esm.js': "export default 'default'\nexport const value = 'value'\n",
    // A type's export, as esbuild keeps it of TS it makes JS one file at a time.
    'lib/shapes.ts': "export { Shape, area } from './shape'\n",
    'lib/shape.ts': 'export type Shape = { side: number }\nexport const area = (side: number): number => side * side\n',
    // A module that names `exports`: Babel's CommonJS binds it to the module's.
    'lib/bound.js': "export const own = 'own'\nexport const viaExports = () => exports.own\n",
    // An import of what a module doesn't export, undefined in Metro's bundle.
    'lib/partial.js': "import { present, absent } from './present'\nexport const partial = [present, absent ?? null]\n",
    'lib/present.js': "export const present = 'present'\n",
    'lib/required.js': "module.exports = require('cond')\n",
    // As the package's exports have it, for an import and for a require call.
    'node_modules/cond/package.json': { name: 'cond', exports: { import: './esm.js', require: './cjs.js' } },
    'node_modules/cond/esm.js': "export default 'import'\n",
    'node_modules/cond/cjs.js': "module.exports = 'require'\n",
    // A name two modules declare, which esbuild renames in one, joining them.
    'names.js': "import { Button as A } from './lib/button-a'\nimport { Button as B } from './lib/button-b'\nconsole.log(JSON.stringify([A.name, B.name]))\n",
    'lib/button-a.js': 'export function Button() {}\n',
    'lib/button-b.js': 'export function Button() {}\n',
    'node_modules/@babel/core': linked('@babel/core'),
    'node_modules/@babel/plugin-transform-modules-commonjs': linked('@babel/plugin-transform-modules-commonjs'),
  })
  after(cleanup)
  const build = memoized((...args) => {
    const r = spawnSync(process.execPath, [BIN, '--platform=ios', ...args, '--output=out.js', 'index.js'], { cwd: root, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    const code = readFileSync(join(root, 'out.js'), 'utf8')
    return { code, stderr: r.stderr, out: JSON.parse(printed(join(root, 'out.js'))) }
  })
  const OUT = { made: 'made', named: 'named', used: 'used', area: 9, viaExports: 'own', partial: ['present', null], cond: 'import', required: 'require', esm: ['default', 'value'], fromMjs: 'mjs' }

  it('resolves an import Babel makes a require call as an ESM import, as Metro does', () => {
    const { out } = build()
    assert.deepEqual([out.cond, out.required], ['import', 'require'])
  })

  it('leaves import and export to esbuild, which links the modules and drops what is unused of them', () => {
    const commonjs = build('--sourcemap-output=out.map')
    assert.deepEqual(commonjs.out, OUT)
    const { sources } = JSON.parse(readFileSync(join(root, 'out.map'), 'utf8'))
    assert.ok(sources.some((source) => source.endsWith('lib/node.mjs')) && !sources.some((source) => source.includes('.rn.')), String(sources))
    assert.ok(/\brequire_named\b/u.test(commonjs.code) && commonjs.code.includes('UNUSED-EXPORT'))
    const esm = build('--esm')
    assert.deepEqual(esm.out, OUT)
    assert.ok(!/\brequire_(?:named|shapes|shape|index)\b/u.test(esm.code) && !esm.code.includes('UNUSED-EXPORT'))
    // CommonJS: a file that is, and a module that names `exports`, as Babel makes it.
    assert.ok(/\brequire_cjs\b/u.test(esm.code) && /\brequire_bound\b/u.test(esm.code))
  })

  it('leaves CommonJS a file in which esbuild finds an import of what a module does not export, warning of it', () => {
    const { code, stderr } = build('--esm')
    assert.ok(/\brequire_partial\b/u.test(code) && !/\brequire_present\b/u.test(code))
    assert.match(stderr, /▲ \[WARNING\] No matching export in "lib\/present\.js" for import "absent": left CommonJS, as Metro has it, the import undefined\n\n {4}lib\/partial\.js:1:18:/u)
  })

  it("keeps a function's name where esbuild renames it, as Babel's CommonJS keeps it, but where it minifies", () => {
    const names = (...args) => {
      const r = spawnSync(process.execPath, [BIN, '--platform=ios', ...args, '--output=out.js', 'names.js'], { cwd: root, encoding: 'utf8' })
      assert.equal(r.status, 0, r.stderr)
      return JSON.parse(printed(join(root, 'out.js')))
    }
    assert.deepEqual(names('--esm'), ['Button', 'Button'])
    assert.deepEqual(names(), ['Button', 'Button'])
    // Minified, of neither its name, as Metro's minifier has it.
    for (const minified of [names('--esm', '--minify'), names('--minify')]) assert.ok(!minified.includes('Button'), String(minified))
  })

})
