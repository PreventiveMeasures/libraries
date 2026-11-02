import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { printed, writeTree } from './fixtures.js'
import { BIN, linked } from './rn-bundle-app.js'

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
  const run = (entry) => spawnSync(process.execPath, [BIN, '--platform=ios', '--output=out.js', entry], { cwd: root, encoding: 'utf8' })

  it('keeps module-resolver in Babel, before the plugins that read what it rewrote', () => {
    const r = run('index.js')
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(JSON.parse(printed(join(root, 'out.js'))), { name: 'a' })
  })

  it("reports Babel's error in the file it failed on, at its line where Babel says one", () => {
    const failing = run('failing.js')
    assert.equal(failing.status, 1)
    assert.match(failing.stderr, /Babel: fails here[\s\S]*\n {4}lib\/fails\.js:/u)
    assert.ok(!failing.stderr.includes(join(root, 'lib/fails.js')), 'no absolute path in the message')
    const broken = run('broken.js')
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
  })
  after(cleanup)
  // -> the files module-resolver runs in, of the bundle's five.
  const ran = (options) => {
    writeFileSync(join(root, 'babel.config.js'), `module.exports = { plugins: [['module-resolver', ${JSON.stringify(options)}]] }\n`)
    const r = spawnSync(process.execPath, [BIN, '--platform=ios', '--profile', '--output=out.js', 'index.js'], { cwd: root, encoding: 'utf8', timeout: 30_000 })
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(JSON.parse(printed(join(root, 'out.js'))), ['a', 'b', 'a', 'a'])
    return Number(/^ +\d+ +[\d.]+ +(\d+) +\d+ {2}module-resolver$/mu.exec(r.stderr)?.[1] ?? 0)
  }

  it('leaves it out of Babel in a file that names none of its aliases, though with escapes', () => {
    assert.equal(ran({ alias: { '#lib': './lib' } }), 3)
    assert.equal(ran({ alias: [{ '#nothing': './nothing' }, { '#lib': './lib' }] }), 3)
  })

  it("runs it where a string names an alias, as its RegExp has it, though the file's text names one where none does", () => {
    // `export`, in each file's text, of no string.
    assert.equal(ran({ alias: { '#lib': './lib', export: './nowhere' } }), 3)
    assert.equal(ran({ alias: { '^#lib/(.+)$': './lib/\\1' } }), 3)
  })

  it("leaves it out of Babel where no string names an alias, though the file's text names one: no hook of it runs there", () => {
    writeFileSync(join(root, 'babel.config.js'), "module.exports = { plugins: [['module-resolver', { alias: { '#lib': './lib', export: './nowhere', '^~(.+)$': './lib/\\\\1' } }]] }\n")
    const r = spawnSync(process.execPath, [BIN, '--platform=ios', '--profile', '--output=out.js', 'index.js'], { cwd: root, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    // In the three files with a string of #lib, its pre and post hooks and its traversal on enter.
    assert.deepEqual(/^ +\d+ +[\d.]+ +(\d+) +(\d+) {2}module-resolver$/mu.exec(r.stderr)?.slice(1).map(Number), [3, 3 * 2 + 3])
  })

  it('keeps it where a string an alias matches is spelled across lines, or matched by a RegExp of a backreference', () => {
    const build = (alias, entry) => {
      writeFileSync(join(root, 'babel.config.js'), `module.exports = { plugins: [['module-resolver', ${JSON.stringify({ alias })}]] }\n`)
      const r = spawnSync(process.execPath, [BIN, '--platform=ios', '--output=out.js', entry], { cwd: root, encoding: 'utf8' })
      assert.equal(r.status, 0, r.stderr)
      return JSON.parse(printed(join(root, 'out.js')))
    }
    assert.equal(build({ '#lib': './lib' }, 'continued.js'), 'a')
    // A group before its own: the second alias's \\1 is of its own group.
    assert.equal(build({ '^unused/(.+)$': './nowhere/\\1', '^([a-z]+)-\\1$': './\\1/a' }, 'backreference.js'), 'a')
    assert.equal(build({ "^foo'bar$": './lib/a' }, 'quoted.js'), 'a')
    assert.equal(build({ '^foo\\tbar$': './lib/a' }, 'tab.js'), 'a')
  })

  it("keeps it where an alias matches what Babel's plugins write: the JSX runtime's import, a helper's, a template's string", () => {
    const bundled = (alias, plugin, entry) => {
      writeFileSync(join(root, 'babel.config.js'), `module.exports = { plugins: [['module-resolver', ${JSON.stringify({ alias })}], ${JSON.stringify(plugin)}] }\n`)
      const r = spawnSync(process.execPath, [BIN, '--platform=ios', '--output=out.js', entry], { cwd: root, encoding: 'utf8' })
      assert.equal(r.status, 0, r.stderr)
      return JSON.parse(printed(join(root, 'out.js')))
    }
    const jsx = ['@babel/plugin-transform-react-jsx', { runtime: 'automatic' }]
    assert.equal(bundled({ '^react/jsx-runtime$': './lib/jsx-runtime' }, jsx, 'jsx.js'), 'b')
    assert.equal(bundled({ '^custom/jsx-runtime$': './lib/jsx-runtime' }, jsx, 'pragma.js'), 'b')
    assert.equal(bundled({ '^@babel/runtime/helpers/classCallCheck$': './lib/classCallCheck' }, './helper-plugin.js', 'helper.js'), 'classCallCheck')
    // Of core-js, @babel/runtime-corejs3's.
    const corejs = ['./helper-plugin.js', { corejs: 3, specifier: '@babel/runtime-corejs3/helpers/classCallCheck' }]
    assert.equal(bundled({ '^@babel/runtime-corejs3/helpers/classCallCheck$': './lib/classCallCheck' }, corejs, 'helper.js'), 'classCallCheck')
    assert.equal(bundled({ '^#lib/(.+)$': './lib/\\1' }, './template-plugin.js', 'template.js'), 'a')
  })

  it('builds each module alike with --self-test, which keeps it in each and lets it traverse', () => {
    writeFileSync(join(root, 'babel.config.js'), "module.exports = { plugins: [['module-resolver', { alias: { '#lib': './lib', export: './nowhere' } }]] }\n")
    const r = spawnSync(process.execPath, [BIN, '--platform=ios', '--self-test', 'index.js'], { cwd: root, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stderr, /--self-test: each of 5 modules is as Babel makes it/u)
  })

  it('keeps it where it may rewrite what names none: with a root', () => {
    assert.equal(ran({ alias: { '#lib': './lib' }, root: ['./lib'] }), 5)
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

  it('leaves modules and block scoping out of Babel in a file that gives them nothing to do', () => {
    const r = spawnSync(process.execPath, [BIN, '--platform=ios', '--profile', '--output=out.js', 'index.js'], { cwd: root, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(JSON.parse(printed(join(root, 'out.js'))), ['a', 'b', 'c'])
    const files = (key) => Number(new RegExp(`^ +\\d+ +[\\d.]+ +(\\d+) +\\d+ {2}${key}$`, 'mu').exec(r.stderr)?.[1] ?? 0)
    // Classes, in each file with `export default` or a class; modules, in
    // those with import or export, and the script whose strings name them;
    // block scoping, in the file with a class and the script.
    assert.deepEqual(['transform-classes', 'transform-modules-commonjs', 'transform-block-scoping'].map(files), [2, 4, 2])
  })

  it('keeps classes in Babel in a file of no class, where another plugin writes one', () => {
    const config = readFileSync(join(root, 'babel.config.js'), 'utf8')
    // Of classes' key, one that makes each class a string.
    writeFileSync(join(root, 'babel.config.js'), `module.exports = { plugins: ['./class-plugin.js', ${plugin('transform-classes', "Class(path) { path.replaceWith({ type: 'StringLiteral', value: 'lowered' }) }")}] }\n`)
    try {
      const r = spawnSync(process.execPath, [BIN, '--platform=ios', '--output=out.js', 'made.js'], { cwd: root, encoding: 'utf8' })
      assert.equal(r.status, 0, r.stderr)
      assert.equal(printed(join(root, 'out.js')), '"lowered"\n')
    } finally {
      writeFileSync(join(root, 'babel.config.js'), config)
    }
  })

  const selfTest = (...args) => spawnSync(process.execPath, [BIN, '--platform=ios', '--self-test', ...args, 'index.js'], { cwd: root, encoding: 'utf8' })

  it('with --self-test, builds again with each plugin, finds each module the same, and writes nothing without --output', () => {
    const r = selfTest()
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stderr, /rn-bundle: --self-test: each of 4 modules is as Babel makes it with each of the config's plugins\n$/u)
    assert.ok(!readdirSync(root).includes('rn-bundle.js'))
  })

  it('with --self-test, fails where Babel leaves out a plugin that has something to do', () => {
    // Of block scoping's key, one that marks each `export default`, in a module with no let, const or class too.
    const config = readFileSync(join(root, 'babel.config.js'), 'utf8')
    writeFileSync(join(root, 'babel.config.js'), config.replace("name: 'transform-block-scoping', visitor: { Program() {}", "name: 'transform-block-scoping', visitor: { Program() {}, ExportDefaultDeclaration(path) { path.insertAfter({ type: 'ExpressionStatement', expression: { type: 'StringLiteral', value: 'marked' } }) }"))
    try {
      const r = selfTest()
      assert.equal(r.status, 1)
      assert.match(r.stderr, /rn-bundle: --self-test: 1 of 4 modules differ from Babel's output with each of the config's plugins:\n {2}a\.js:\d+\n {4}- [^\n]*\n {4}\+ "marked";\n$/u)
    } finally {
      writeFileSync(join(root, 'babel.config.js'), config)
    }
  })

  it('takes --sourcemap-output with --output alone', () => {
    const map = selfTest('--sourcemap-output=out.map')
    assert.deepEqual([map.status, map.stderr], [1, 'rn-bundle: --sourcemap-output maps the bundle of --output: pass it\n'])
  })
})
