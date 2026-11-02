import assert from 'node:assert/strict'
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { printed, writeTree } from './fixtures.js'
import { linked, runBundle } from './rn-bundle-app.js'

describe('rn-bundle, with Babel, with plugins after babel-plugin-module-resolver', () => {
  // As a project's plugin that inlines a *.plugin.json it reads at the path
  // module-resolver rewrote the import to; one that fails on a file.
  const { root, cleanup } = writeTree({
    'babel.config.js': "module.exports = { plugins: [['module-resolver', { alias: { '#lib': './lib' } }], './inline-json.js', './fail.js'] }\n",
    'inline-json.js': [
      "const { readFileSync } = require('node:fs')",
      "const { dirname, resolve } = require('node:path')",
      'module.exports = ({ types: t }) => ({',
      '  visitor: {',
      '    ImportDeclaration(path, state) {',
      '      const source = path.node.source.value',
      "      if (!source.endsWith('.plugin.json')) return",
      "      const json = JSON.parse(readFileSync(resolve(dirname(state.filename), source), 'utf8'))",
      "      path.replaceWith(t.variableDeclaration('var', [t.variableDeclarator(path.node.specifiers[0].local, t.valueToNode(json))]))",
      '    },',
      '  },',
      '})',
      '',
    ].join('\n'),
    'fail.js': "module.exports = () => ({ visitor: { Program(path, state) { if (state.file.code.includes('FAIL')) throw new Error('fails here') } } })\n",
    'index.js': "import config from '#lib/a.plugin.json'\nconsole.log(JSON.stringify(config))\n",
    'lib/a.plugin.json': '{ "name": "a" }\n',
    'failing.js': "import './lib/fails'\n",
    'lib/fails.js': "export const x = 'FAIL'\n",
    'broken.js': "import './lib/pragma'\n",
    // Taken by Babel as it is (a JSX pragma), so its line is the file's.
    'lib/pragma.js': '/** @jsx h */\nconst a = 1\nconst b = (c: ) => 1\n',
    'node_modules/@babel/core': linked('@babel/core'),
    'node_modules/babel-plugin-module-resolver': linked('babel-plugin-module-resolver'),
  })
  after(cleanup)
  const run = (entry) => runBundle(['--platform=ios', '--output=out.js', entry], { cwd: root })

  it('keeps module-resolver in Babel, before the plugins that read what it rewrote', async () => {
    const r = await run('index.js')
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(JSON.parse(printed(join(root, 'out.js'))), { name: 'a' })
  })

  it("reports Babel's error in the file it failed on, at its line where Babel says one", async () => {
    const failing = await run('failing.js')
    assert.equal(failing.status, 1)
    assert.match(failing.stderr, /Babel: fails here[\s\S]*\n {4}lib\/fails\.js:/u)
    assert.ok(!failing.stderr.includes(join(root, 'lib/fails.js')), 'no absolute path in the message')
    const broken = await run('broken.js')
    assert.equal(broken.status, 1)
    assert.match(broken.stderr, /\n {4}lib\/pragma\.js:3:\d+:\n {6}3 │ const b = \(c: \) => 1/u)
  })
})

describe("rn-bundle, with babel-plugin-module-resolver's aliases", () => {
  const { root, cleanup } = writeTree({
    'index.js': "import { a } from '#lib/a'\nimport { b } from './b'\nimport { e } from './escaped'\nimport { i } from './identity'\nconsole.log(JSON.stringify([a, b, e, i]))\n",
    'lib/a.js': "export const a = 'a'\n",
    // A template of line continuations, CRLF, then a substitution: not a string, found so in linear time.
    'b.js': `export const b = 'b'\nexport const t = \`${'\\\r\n'.repeat(64)}\${b}\`\n`,
    // An alias spelled with escapes: of a code point, and of a character that is itself.
    'escaped.js': "export { a as e } from '\\u0023lib/a'\n",
    'identity.js': "export { a as i } from '\\#lib/a'\n",
    // A string spelled across lines, by a line continuation.
    'continued.js': "import { a } from '#lib/\\\na'\nconsole.log(JSON.stringify(a))\n",
    'backreference.js': "import { a } from 'lib-lib'\nconsole.log(JSON.stringify(a))\n",
    'quoted.js': "import { a } from 'foo\\'bar'\nconsole.log(JSON.stringify(a))\n",
    // JSX, whose runtime Babel's plugin imports, of no string of the file.
    'jsx.js': 'console.log(JSON.stringify(<b />))\n',
    'lib/jsx-runtime.js': 'export const jsx = (type) => type\n',
    // JSX of an import source of its own.
    'pragma.js': '/** @jsxImportSource custom */\nconsole.log(JSON.stringify(<b />))\n',
    // As transform-runtime imports a helper, as Babel traverses the file.
    'helper.js': 'console.log(JSON.stringify(__HELPER__))\n',
    'helper-plugin.js': "module.exports = ({ types: t }, { specifier = '@babel/runtime/helpers/classCallCheck' }) => ({ name: 'transform-runtime', visitor: { Identifier(path) { if (path.node.name === '__HELPER__') path.replaceWith(t.callExpression(t.identifier('require'), [t.stringLiteral(specifier)])) } } })\n",
    // A string of an escape of a control character.
    'tab.js': "import { a } from 'foo\\tbar'\nconsole.log(JSON.stringify(a))\n",
    'lib/classCallCheck.js': "module.exports = 'classCallCheck'\n",
    // A template of no substitution, as transform-template-literals makes it a string.
    'template.js': 'const { a } = require(`#lib/a`)\nconsole.log(JSON.stringify(a))\n',
    'template-plugin.js': "module.exports = ({ types: t }) => ({ name: 'transform-template-literals', visitor: { TemplateLiteral(path) { if (path.node.expressions.length === 0) path.replaceWith(t.stringLiteral(path.node.quasis[0].value.cooked)) } } })\n",
    'node_modules/@babel/plugin-transform-react-jsx': linked('@babel/plugin-transform-react-jsx'),
    'node_modules/@babel/core': linked('@babel/core'),
    'node_modules/babel-plugin-module-resolver': linked('babel-plugin-module-resolver'),
    // A plugin rn knows not, which may read a specifier, so keeps module-resolver in Babel.
    'noop-plugin.js': "module.exports = () => ({ name: 'noop', visitor: {} })\n",
    // A package an alias maps '#lib' to.
    'node_modules/lib-package/a.js': "export const a = 'a'\n",
  })
  after(cleanup)
  // -> the files module-resolver runs in, of the bundle's five, of these
  // options and the config's other plugins; the bundle as it is written.
  const ran = async (options, plugins = [], args = []) => {
    writeFileSync(join(root, 'babel.config.js'), `module.exports = { plugins: [['module-resolver', ${JSON.stringify(options)}], ${plugins.map((plugin) => JSON.stringify(plugin)).join(', ')}] }\n`)
    const r = await runBundle(['--platform=ios', '--profile', '--output=out.js', ...args, 'index.js'], { cwd: root })
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(JSON.parse(printed(join(root, 'out.js'))), ['a', 'b', 'a', 'a'])
    return Number(/^ +\d+ +[\d.]+ +(\d+) +\d+ {2}module-resolver$/mu.exec(r.stderr)?.[1] ?? 0)
  }

  it("leaves it out of Babel, its aliases mapped as the bundle resolves each import, but in a file of an escape of a code point (`\\u0023`)", async () => {
    assert.equal(await ran({ alias: { '#lib': './lib' } }), 1)
    // `export`, in each file's text, of no string.
    assert.equal(await ran({ alias: { '#lib': './lib', export: './nowhere' } }), 1)
    assert.equal(await ran({ alias: { '^#lib/(.+)$': './lib/\\1' } }), 1)
  })

  it('makes the bundle module-resolver in Babel makes, as a plugin of the config it knows not keeps it', async () => {
    for (const args of [[], ['--esm']]) {
      assert.equal(await ran({ alias: { '#lib': './lib' } }, [], args), 1)
      const mapped = readFileSync(join(root, 'out.js'), 'utf8')
      assert.equal(await ran({ alias: { '#lib': './lib' } }, ['./noop-plugin.js'], args), 3)
      assert.equal(readFileSync(join(root, 'out.js'), 'utf8'), mapped)
    }
  })

  it('keeps it in Babel where an alias is of more than one object, or maps to a package, or the file calls jest.mock', async () => {
    assert.equal(await ran({ alias: [{ '#nothing': './nothing' }, { '#lib': './lib' }] }), 3)
    assert.equal(await ran({ alias: { '#lib': 'lib-package' } }), 3)
    writeFileSync(join(root, 'mocked.js'), "if (typeof jest !== 'undefined') jest.mock('#lib/a')\nexport { a as m } from '#lib/a'\n")
    try {
      writeFileSync(join(root, 'babel.config.js'), "module.exports = { plugins: [['module-resolver', { alias: { '#lib': './lib' } }]] }\n")
      const r = await runBundle(['--platform=ios', '--profile', '--output=out.js', 'mocked.js'], { cwd: root })
      assert.equal(r.status, 0, r.stderr)
      assert.equal(/^ +\d+ +[\d.]+ +(\d+) +\d+ {2}module-resolver$/mu.exec(r.stderr)?.[1], '1')
    } finally {
      rmSync(join(root, 'mocked.js'))
    }
  })

  it('keeps it where a string an alias matches is spelled across lines, or matched by a RegExp of a backreference', async () => {
    const build = async (alias, entry) => {
      writeFileSync(join(root, 'babel.config.js'), `module.exports = { plugins: [['module-resolver', ${JSON.stringify({ alias })}]] }\n`)
      const r = await runBundle(['--platform=ios', '--output=out.js', entry], { cwd: root })
      assert.equal(r.status, 0, r.stderr)
      return JSON.parse(printed(join(root, 'out.js')))
    }
    assert.equal(await build({ '#lib': './lib' }, 'continued.js'), 'a')
    // A group before its own: the second alias's \\1 is of its own group.
    assert.equal(await build({ '^unused/(.+)$': './nowhere/\\1', '^([a-z]+)-\\1$': './\\1/a' }, 'backreference.js'), 'a')
    assert.equal(await build({ "^foo'bar$": './lib/a' }, 'quoted.js'), 'a')
    assert.equal(await build({ '^foo\\tbar$': './lib/a' }, 'tab.js'), 'a')
  })

  it("keeps it where an alias matches what Babel's plugins write: the JSX runtime's import, a helper's, a template's string", async () => {
    const bundled = async (alias, plugin, entry) => {
      writeFileSync(join(root, 'babel.config.js'), `module.exports = { plugins: [['module-resolver', ${JSON.stringify({ alias })}], ${JSON.stringify(plugin)}] }\n`)
      const r = await runBundle(['--platform=ios', '--output=out.js', entry], { cwd: root })
      assert.equal(r.status, 0, r.stderr)
      return JSON.parse(printed(join(root, 'out.js')))
    }
    const jsx = ['@babel/plugin-transform-react-jsx', { runtime: 'automatic' }]
    assert.equal(await bundled({ '^react/jsx-runtime$': './lib/jsx-runtime' }, jsx, 'jsx.js'), 'b')
    assert.equal(await bundled({ '^custom/jsx-runtime$': './lib/jsx-runtime' }, jsx, 'pragma.js'), 'b')
    assert.equal(await bundled({ '^@babel/runtime/helpers/classCallCheck$': './lib/classCallCheck' }, './helper-plugin.js', 'helper.js'), 'classCallCheck')
    // Of core-js, @babel/runtime-corejs3's.
    const corejs = ['./helper-plugin.js', { corejs: 3, specifier: '@babel/runtime-corejs3/helpers/classCallCheck' }]
    assert.equal(await bundled({ '^@babel/runtime-corejs3/helpers/classCallCheck$': './lib/classCallCheck' }, corejs, 'helper.js'), 'classCallCheck')
    assert.equal(await bundled({ '^#lib/(.+)$': './lib/\\1' }, './template-plugin.js', 'template.js'), 'a')
  })

  it('builds each module alike with --self-test, which keeps it in each and lets it traverse', async () => {
    writeFileSync(join(root, 'babel.config.js'), "module.exports = { plugins: [['module-resolver', { alias: { '#lib': './lib', export: './nowhere' } }]] }\n")
    const r = await runBundle(['--platform=ios', '--self-test', 'index.js'], { cwd: root })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stderr, /--self-test: each of 5 modules is as Babel makes it/u)
  })

  it('keeps it where it may rewrite what names none: with a root', async () => {
    assert.equal(await ran({ alias: { '#lib': './lib' }, root: ['./lib'] }), 5)
  })
})

describe("rn-bundle, with Babel's plugins of classes, modules and block scoping", () => {
  // Each as Babel's visits nodes: of classes, `export default`, for a class's.
  const plugin = (name, visitor) => `() => ({ name: '${name}', visitor: { ${visitor} } })`
  const { root, cleanup } = writeTree({
    'babel.config.js': `module.exports = { plugins: [${plugin('transform-classes', 'ExportDefaultDeclaration() {}, Class() {}')}, ${plugin('transform-modules-commonjs', 'Program() {}')}, ${plugin('transform-block-scoping', 'Program() {}')}] }\n`,
    'index.js': "import a from './a'\nimport B from './b'\nconsole.log(JSON.stringify([a, new B().b, require('./c')]))\n",
    'a.js': "export default 'a'\n",
    'b.js': "export default class { b = 'b' }\n",
    // A script, which names `import` and `export` in strings alone.
    'c.js': "module.exports = ['import', 'export'].join() && 'c'\n",
    // A file of no class, which another plugin writes one into.
    'made.js': 'console.log(JSON.stringify(__CLASS__))\n',
    'class-plugin.js': "module.exports = ({ types: t }) => ({ name: 'writes-a-class', visitor: { Identifier(path) { if (path.node.name === '__CLASS__') path.replaceWith(t.classExpression(null, null, t.classBody([]), [])) } } })\n",
    'node_modules/@babel/core': linked('@babel/core'),
  })
  after(cleanup)

  it('leaves modules and block scoping out of Babel in a file that gives them nothing to do', async () => {
    const r = await runBundle(['--platform=ios', '--profile', '--output=out.js', 'index.js'], { cwd: root })
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(JSON.parse(printed(join(root, 'out.js'))), ['a', 'b', 'c'])
    const files = (key) => Number(new RegExp(`^ +\\d+ +[\\d.]+ +(\\d+) +\\d+ {2}${key}$`, 'mu').exec(r.stderr)?.[1] ?? 0)
    // Classes, in each file with `export default` or a class; modules, in
    // those with import or export, and the script whose strings name them;
    // block scoping, in the file with a class and the script.
    assert.deepEqual(['transform-classes', 'transform-modules-commonjs', 'transform-block-scoping'].map(files), [2, 4, 2])
  })

  it('keeps classes in Babel in a file of no class, where another plugin writes one', async () => {
    const config = readFileSync(join(root, 'babel.config.js'), 'utf8')
    // Of classes' key, one that makes each class a string.
    writeFileSync(join(root, 'babel.config.js'), `module.exports = { plugins: ['./class-plugin.js', ${plugin('transform-classes', "Class(path) { path.replaceWith({ type: 'StringLiteral', value: 'lowered' }) }")}] }\n`)
    try {
      const r = await runBundle(['--platform=ios', '--output=out.js', 'made.js'], { cwd: root })
      assert.equal(r.status, 0, r.stderr)
      assert.equal(printed(join(root, 'out.js')), '"lowered"\n')
    } finally {
      writeFileSync(join(root, 'babel.config.js'), config)
    }
  })

  const selfTest = (...args) => runBundle(['--platform=ios', '--self-test', ...args, 'index.js'], { cwd: root })

  it('with --self-test, builds again with each plugin, finds each module the same, and writes nothing without --output', async () => {
    const r = await selfTest()
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stderr, /rn-bundle: --self-test: each of 4 modules is as Babel makes it with each of the config's plugins\n$/u)
    assert.ok(!readdirSync(root).includes('rn-bundle.js'))
  })

  it('with --self-test, fails where Babel leaves out a plugin that has something to do', async () => {
    // Of block scoping's key, one that marks each `export default`, in a module with no let, const or class too.
    const config = readFileSync(join(root, 'babel.config.js'), 'utf8')
    writeFileSync(join(root, 'babel.config.js'), config.replace("name: 'transform-block-scoping', visitor: { Program() {}", "name: 'transform-block-scoping', visitor: { Program() {}, ExportDefaultDeclaration(path) { path.insertAfter({ type: 'ExpressionStatement', expression: { type: 'StringLiteral', value: 'marked' } }) }"))
    try {
      const r = await selfTest()
      assert.equal(r.status, 1)
      assert.match(r.stderr, /rn-bundle: --self-test: 1 of 4 modules differ from Babel's output with each of the config's plugins:\n {2}a\.js:\d+\n {4}- [^\n]*\n {4}\+ "marked";\n$/u)
    } finally {
      writeFileSync(join(root, 'babel.config.js'), config)
    }
  })

  it('takes --sourcemap-output with --output alone', async () => {
    const map = await selfTest('--sourcemap-output=out.map')
    assert.deepEqual([map.status, map.stderr], [1, 'rn-bundle: --sourcemap-output maps the bundle of --output: pass it\n'])
  })
})
