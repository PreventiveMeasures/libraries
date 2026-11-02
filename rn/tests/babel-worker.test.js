import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { babelWorkers, newProfile, profileReport } from '../src/babel-worker.js'
import { writeTree } from './fixtures.js'

const CORE = fileURLToPath(import.meta.resolve('@babel/core'))
const core = createRequire(import.meta.url)('@babel/core')
const MODULES_COMMONJS = fileURLToPath(import.meta.resolve('@babel/plugin-transform-modules-commonjs'))
const FLOW_STRIP_TYPES = fileURLToPath(import.meta.resolve('@babel/plugin-transform-flow-strip-types'))
const OXC = fileURLToPath(import.meta.resolve('oxc-parser'))

describe('babelWorkers', () => {
  const { root, cleanup } = writeTree({
    'broken.cjs': "throw new Error('broken core')\n",
    // A pre hook, run in each file, and a visitor of classes, in a file with one.
    'classy.cjs': "module.exports = () => ({ name: 'classy', pre() {}, visitor: { ClassDeclaration() {} } })\n",
    // module-resolver, as the project installs it: its module's own resolvePath maps its specifiers.
    'node_modules/babel-plugin-module-resolver': { link: realpathSync(fileURLToPath(import.meta.resolve('babel-plugin-module-resolver')).replace(/[\\/]lib[\\/]index\.js$/u, '')) },
    // A require of an alias, put in as Babel traverses the file.
    'inject.cjs': "module.exports = ({ types: t }) => ({ name: 'inject', visitor: { Identifier(path) { if (path.node.name === '__DEP__') path.replaceWith(t.callExpression(t.identifier('require'), [t.stringLiteral('#lib/b')])) } } })\n",
    'mark.cjs': "module.exports = ({ types: t }) => ({ name: 'mark', visitor: { Program: { exit(path) { path.pushContainer('body', t.expressionStatement(t.stringLiteral('marked'))) } } } })\n",
    // Which parser made the AST: Babel's nodes are its Node's, oxc-babel.js's plain objects.
    'parsed.cjs': "module.exports = ({ types: t }) => ({ name: 'parsed', visitor: { Program: { exit(path) { path.pushContainer('body', t.expressionStatement(t.stringLiteral(path.node.constructor === Object ? 'oxc' : 'babel'))) } } } })\n",
    // A plugin that parses, as Babel's own parser does.
    'parser.cjs': "module.exports = () => ({ name: 'parser', parserOverride: (code, options, parse) => parse(code, options) })\n",
    // A config with its own visitor wrapper, which marks after mark's visitor.
    'wrap.config.cjs': "module.exports = { plugins: ['./mark.cjs'], wrapPluginVisitorMethod: (key, phase, fn) => function (path, ...rest) { fn.call(this, path, ...rest); if (key === 'mark') path.pushContainer('body', { type: 'ExpressionStatement', expression: { type: 'StringLiteral', value: 'wrapped' } }) } }\n",
  })
  after(cleanup)

  it('transforms in a worker, by the @babel/core given, failing with its errors', async () => {
    const transform = babelWorkers(CORE, { babelrc: false, configFile: false, compact: false })
    const files = await Promise.all(['a', 'b', 'c'].map((name) => transform(`const ${name} = 1 ?? 2`, join(root, `${name}.js`))))
    assert.deepEqual(files, ['a', 'b', 'c'].map((name) => ({ code: `const ${name} = 1 ?? 2;`, imports: [] })))
    await assert.rejects(transform('const a = (b: ) => 1', join(root, 'bad.js')), /bad\.js: Unexpected token/u)
  })

  it("leaves out the config's plugins of the keys it is given", async () => {
    const transform = babelWorkers(CORE, { babelrc: false, configFile: false, compact: false, plugins: [join(root, 'mark.cjs')] })
    assert.equal((await transform('a()', join(root, 'a.js'))).code, 'a();\n"marked";')
    assert.equal((await transform('a()', join(root, 'a.js'), ['mark'])).code, 'a();')
    assert.equal((await transform('a()', join(root, 'a.js'), ['other'])).code, 'a();\n"marked";')
  })

  it('adds to a profile the time of each transform, and of each plugin: the files its visitors ran in, and their calls', async () => {
    const profile = newProfile()
    const transform = babelWorkers(CORE, { babelrc: false, configFile: false, compact: false, plugins: [join(root, 'mark.cjs'), join(root, 'classy.cjs')] }, profile)
    assert.equal((await transform('a()', join(root, 'a.js'))).code, 'a();\n"marked";')
    assert.equal((await transform('class B {}', join(root, 'b.js'), ['mark'])).code, 'class B {}')
    assert.equal(profile.files, 2)
    const { files, calls, ms } = profile.plugins.get('mark')
    assert.deepEqual([files, calls], [1, 1])
    // In both files, its visitor run in one: its pre hook's calls count, not their files.
    assert.deepEqual([profile.plugins.get('classy').files, profile.plugins.get('classy').calls], [1, 3])
    assert.ok(ms > 0 && profile.ms > ms)
    // Babel's own, in each file: its config loaded, parsed, its scope crawled, printed.
    assert.deepEqual([...profile.own].map(([name, own]) => [name, own.files, own.calls >= 1, own.ms > 0]).toSorted(), ['config', 'parsing', 'printing', 'scopes'].map((name) => [name, 2, true, true]))
  })

  it("profiles through the config's own visitor wrapper", async () => {
    const options = { babelrc: false, configFile: join(root, 'wrap.config.cjs'), compact: false }
    for (const profile of [null, newProfile()]) assert.equal((await babelWorkers(CORE, options, profile)('a()', join(root, 'a.js'))).code, 'a();\n"marked";\n"wrapped";')
  })

  it("gives the specifiers of the file's import and export-from declarations, as Metro's transformer records them, though Babel makes each a require call", async () => {
    const transform = babelWorkers(CORE, { babelrc: false, configFile: false, compact: false, plugins: [MODULES_COMMONJS, join(root, 'mark.cjs')] })
    const source = "import a from 'a'\nexport { b } from 'b'\nexport * from 'c'\nexport const d = require('d')\n"
    const { code, imports } = await transform(source, join(root, 'imports.js'))
    assert.deepEqual([...code.matchAll(/require\(["'](\w)["']\)/gu)].map(([, specifier]) => specifier).toSorted(), ['a', 'b', 'c', 'd'])
    assert.deepEqual(imports, ['a', 'b', 'c'])
  })

  it("runs module-resolver's traversals where a string names one of its aliases, as Babel has the file when each starts", async () => {
    const profile = newProfile()
    const plugins = [[fileURLToPath(import.meta.resolve('babel-plugin-module-resolver')), { cwd: root, alias: { '#lib': './lib', '^~(.+)$': './lib/\\1' } }], join(root, 'inject.cjs')]
    const transform = babelWorkers(CORE, { babelrc: false, configFile: false, cwd: root, compact: false, plugins }, profile)
    const code = async (source) => (await transform(source, join(root, 'a.js'))).code
    assert.equal(await code("const a = require('#lib/a')"), 'const a = require("./lib/a");')
    assert.equal(await code("const a = require('~a')"), 'const a = require("./lib/a");')
    assert.equal(await code('const b = __DEP__'), 'const b = require("./lib/b");')
    assert.equal(await code("// #lib\nconst c = require('c')"), "// #lib\nconst c = require('c');")
    // Its enter, of the first two, which leaves no alias to its exit; its
    // exit, of the third. Its pre and post hooks, of each.
    const { files, calls } = profile.plugins.get('module-resolver')
    assert.deepEqual([files, calls], [3, 3 + 4 * 2])
  })

  it('maps the specifiers module-resolver maps, as its traversals map them', async () => {
    const plugins = [[fileURLToPath(import.meta.resolve('babel-plugin-module-resolver')), { cwd: root, alias: { '#lib': './lib', '^~(.+)$': './lib/\\1' } }]]
    const options = { babelrc: false, configFile: false, cwd: root, compact: false, plugins }
    const source = [
      "import a from '#lib/a'",
      "export { b } from '~b'",
      "export * from './c'",
      "import * as d from 'd'",
      "const e = require('#lib/e')",
      "require.resolve('#lib/f')",
      "jest.mock('#lib/g', () => ({}))",
      "import('#lib/h')",
      "other('#lib/i')",
      "const j = require(/* j */ '#lib/j')",
      'const k = require(`#lib/k`)',
      '',
    ].join('\n')
    const filename = join(root, 'src/all.js')
    assert.equal((await babelWorkers(CORE, options)(source, filename)).code, (await core.transformAsync(source, { ...options, filename })).code)
  })

  it("checks each module-resolver's aliases, where the config has more than one", async () => {
    const resolver = fileURLToPath(import.meta.resolve('babel-plugin-module-resolver'))
    const plugins = [[resolver, { cwd: root, alias: { '#first': './first' } }, 'first'], [resolver, { cwd: root, alias: { '#second': './second' } }, 'second']]
    const transform = babelWorkers(CORE, { babelrc: false, configFile: false, cwd: root, compact: false, plugins })
    assert.equal((await transform("require('#first/a')", join(root, 'a.js'))).code, 'require("./first/a");')
    assert.equal((await transform("require('#second/b')", join(root, 'b.js'))).code, 'require("./second/b");')
  })

  it("parses each lowered source by oxc-parser, where given, to the AST Babel's parser makes, else by Babel's", async () => {
    const options = { babelrc: false, configFile: false, compact: false, sourceType: 'unambiguous', parserOpts: { plugins: ['jsx'] } }
    const source = '"use strict";\nconst a = /* @__PURE__ */ (/* b */ c(), d);\nfunction e() {\n  return (\n    // f\n    g\n  );\n}\nconst h = <I j="k">{l}</I>;\n'
    const expected = (await babelWorkers(CORE, { ...options, plugins: [join(root, 'parsed.cjs')] })(source, join(root, 'a.js'), [], true)).code
    assert.match(expected, /"babel";$/u)
    const plugins = [join(root, 'parsed.cjs')]
    const transform = babelWorkers(CORE, { ...options, plugins, oxc: OXC })
    assert.equal((await transform(source, join(root, 'a.js'), [], true)).code, expected.replace(/"babel";$/u, '"oxc";'))
    // Not lowered: as esbuild didn't print it, Babel parses it.
    assert.equal((await transform(source, join(root, 'a.js'))).code, expected)
    // Where Babel's flow plugin reads `f<T>(x)` as a call, the file saying @flow.
    const flow = babelWorkers(CORE, { ...options, plugins: [FLOW_STRIP_TYPES, ...plugins], oxc: OXC })
    assert.match((await flow('// @flow\nf<T>(x);', join(root, 'flow.js'), [], true)).code, /^f\(x\);\n"babel";$/u)
    assert.match((await flow('f < T > (x);', join(root, 'not-flow.js'), [], true)).code, /"oxc";$/u)
    // What oxc-parser fails on, Babel parses (Flow types), or fails on, with its error.
    assert.match((await flow('const a: number = 1;', join(root, 'typed.js'), [], true)).code, /^const a = 1;\n"babel";$/u)
    await assert.rejects(transform('const a = (b: ) => 1', join(root, 'bad.js'), [], true), /bad\.js: Unexpected token/u)
    // Another plugin's parser: Babel takes no two.
    const parser = babelWorkers(CORE, { ...options, plugins: [join(root, 'parser.cjs'), ...plugins], oxc: OXC })
    assert.match((await parser(source, join(root, 'a.js'), [], true)).code, /"babel";$/u)
    assert.match((await parser(source, join(root, 'a.js'), ['parser'], true)).code, /"oxc";$/u)
  })

  it("profiles oxc-parser's parsing as Babel's, of no plugin", async () => {
    const profile = newProfile()
    const transform = babelWorkers(CORE, { babelrc: false, configFile: false, compact: false, plugins: [join(root, 'parsed.cjs')], oxc: OXC }, profile)
    assert.match((await transform('a()', join(root, 'a.js'), [], true)).code, /"oxc";$/u)
    assert.equal(profile.plugins.has('rn-bundle-oxc-parser'), false)
    const parsing = profile.own.get('parsing')
    assert.deepEqual([parsing.files, parsing.calls, parsing.ms > 0], [1, 1, true])
  })

  it('reports a profile, most time first, with that outside the plugins', () => {
    const plugins = new Map([['/app/node_modules/preset/index.js$0', { files: 1, calls: 1, ms: 1 }], ['transform-x', { files: 2, calls: 30, ms: 6 }]])
    const own = new Map([['parsing', { files: 2, calls: 2, ms: 2 }], ['config', { files: 2, calls: 2, ms: 0.5 }]])
    assert.equal(
      profileReport({ files: 2, ms: 10, plugins, own }, '/app'),
      [
        'Babel: 2 files, 10 ms, summed over its workers',
        '      ms       %    files      calls  plugin',
        '       6    60.0        2         30  transform-x',
        '       1    10.0        1          1  node_modules/preset/index.js$0',
        '      ms       %    files      calls  Babel, outside plugins',
        '       1     5.0        2          2  config',
        '       2    20.0        2          2  parsing',
        '       0     0.0        0          0  scopes',
        '       0     0.0        0          0  printing',
        '       1     5.0                      traversal, and the rest',
        '',
      ].join('\n'),
    )
  })

  it('fails each transform of a worker that dies, none left waiting', { timeout: 10_000 }, async () => {
    const transform = babelWorkers(join(root, 'broken.cjs'), {})
    for (const name of ['a', 'b', 'c']) await assert.rejects(transform('x', join(root, `${name}.js`)), /broken core/u)
  })
})
