import assert from 'node:assert/strict'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { printed, writeTree } from './fixtures.js'
import { APP, OPTIONS, linked, runBundle } from './rn-bundle-app.js'

// A plugin that adds `name` to each string 'MARKS', on the program's exit: of plugins in order, in order.
const marking = (name) => `module.exports = () => ({ name: ${JSON.stringify(name)}, visitor: { Program: { exit(path) { path.traverse({ StringLiteral(literal) { if (literal.node.value.startsWith('MARKS')) literal.node.value += ${JSON.stringify(name)} } }) } } } })\n`

describe("rn-bundle, of rn.config.json's babel: Babel plugins switched on and off", () => {
  const { root, cleanup } = writeTree({
    'package.json': { name: 'app' },
    'babel.config.js': "module.exports = { plugins: [['@babel/plugin-transform-react-jsx', { pragma: 'h' }], './plugins/async.js'] }\n",
    // Keyed as the plugin that lowers async functions, of no options: rn has esbuild lower them
    // before Babel and leaves it out, unless it is switched on. It tells how many it saw.
    'plugins/async.js': [
      'module.exports = ({ types: t }) => ({',
      "  name: 'transform-async-to-generator',",
      '  visitor: { Program: { exit(path) {',
      '    let seen = 0',
      '    path.traverse({ Function(fn) { if (fn.node.async) seen++ } })',
      "    path.unshiftContainer('body', t.expressionStatement(t.assignmentExpression('=', t.memberExpression(t.identifier('globalThis'), t.identifier('asyncSeen')), t.numericLiteral(seen))))",
      '  } } },',
      '})',
      '',
    ].join('\n'),
    'plugins/mark-a.js': marking('a'),
    'plugins/mark-b.js': marking('b'),
    'index.js': [
      "const h = (type) => 'h:' + type",
      "const React = { createElement: (type) => 'react:' + type }",
      'async function later() {}',
      "console.log(JSON.stringify({ jsx: <div />, asyncSeen: globalThis.asyncSeen ?? null, marks: 'MARKS', later: typeof later }))",
      '',
    ].join('\n'),
    'node_modules/@babel/core': linked('@babel/core'),
    'node_modules/@babel/plugin-transform-react-jsx': linked('@babel/plugin-transform-react-jsx'),
  })
  after(cleanup)
  // The output of index.js, of `config` as rn.config.json, else its error.
  const built = async (config, args = []) => {
    if (config === null) rmSync(join(root, 'rn.config.json'), { force: true })
    else writeFileSync(join(root, 'rn.config.json'), JSON.stringify(config))
    const r = await runBundle(['--platform=ios', ...args, '--output=out.js', 'index.js'], { cwd: root })
    return r.status === 0 ? JSON.parse(printed(join(root, 'out.js'))) : r.stderr
  }

  it("runs the Babel config as it is of none: async functions lowered by esbuild, its plugin of them left out", async () => {
    assert.deepEqual(await built(null), { jsx: 'h:div', asyncSeen: null, marks: 'MARKS', later: 'function' })
  })

  it("leaves a plugin switched off out of every file, by its key or its package: its syntax left to esbuild", async () => {
    for (const name of ['transform-react-jsx', '@babel/plugin-transform-react-jsx']) assert.equal((await built({ babel: { [name]: false } })).jsx, 'react:div')
  })

  it('adds a plugin switched on that the config lacks, after its plugins, in the order named', async () => {
    assert.equal((await built({ babel: { './plugins/mark-a.js': true, './plugins/mark-b.js': true } })).marks, 'MARKSab')
    assert.equal((await built({ babel: { './plugins/mark-b.js': true, './plugins/mark-a.js': true } })).marks, 'MARKSba')
  })

  it("runs a plugin of the config switched on that rn would leave out, on the syntax as it is, esbuild lowering none of it first", async () => {
    assert.equal((await built({ babel: { 'transform-async-to-generator': true } })).asyncSeen, 1)
  })

  it("switches a dev build's plugins and a release build's of their sections", async () => {
    const config = { development: { babel: { './plugins/mark-a.js': true } }, production: { babel: { './plugins/mark-b.js': true, 'transform-react-jsx': false } } }
    assert.deepEqual(await built(config, ['--dev']), { jsx: 'h:div', asyncSeen: null, marks: 'MARKSa', later: 'function' })
    assert.deepEqual(await built(config), { jsx: 'react:div', asyncSeen: null, marks: 'MARKSb', later: 'function' })
  })

  it('fails each file of a plugin switched on that neither the config has nor Babel finds', async () => {
    assert.match(await built({ babel: { 'transform-nothing': true } }), /rn\.config\.json's babel switches on transform-nothing: the Babel config has no plugin of that key for this file, and Babel finds no plugin of that name/u)
  })
})

describe("rn-bundle, of rn.config.json's babel switching block scoping off", () => {
  // Keyed as Babel's block-scoping plugin, which lowers let to var: it counts its runs, which rn makes
  // again where a plugin after it declares let; a plugin that does.
  const { root, cleanup } = writeTree({
    'package.json': { name: 'app' },
    'babel.config.js': "module.exports = { plugins: ['./plugins/block.js', './plugins/adds-let.js'] }\n",
    'plugins/block.js': "module.exports = ({ types: t }) => ({ name: 'transform-block-scoping', visitor: { VariableDeclaration(path) { path.node.kind = 'var' }, Program: { exit(path) { const runs = t.memberExpression(t.identifier('globalThis'), t.identifier('blockRuns')); path.unshiftContainer('body', t.expressionStatement(t.assignmentExpression('=', runs, t.binaryExpression('+', t.logicalExpression('||', t.cloneNode(runs), t.numericLiteral(0)), t.numericLiteral(1))))) } } } })\n",
    // After the traversal, which visits none of it: as Reanimated's worklets are made.
    'plugins/adds-let.js': "module.exports = ({ types: t }) => ({ name: 'adds-let', visitor: {}, post(file) { file.ast.program.body.push(t.variableDeclaration('let', [t.variableDeclarator(t.identifier('added'), t.numericLiteral(1))])) } })\n",
    'index.js': 'console.log(JSON.stringify(globalThis.blockRuns ?? 0))\n',
    'node_modules/@babel/core': linked('@babel/core'),
  })
  after(cleanup)
  const runs = async (config) => {
    writeFileSync(join(root, 'rn.config.json'), JSON.stringify(config))
    const r = await runBundle(['--platform=ios', '--output=out.js', 'index.js'], { cwd: root })
    assert.equal(r.status, 0, r.stderr)
    return JSON.parse(printed(join(root, 'out.js')))
  }

  it("runs it in neither pass: not again of the let a plugin after it declares", async () => {
    // Its own run, and again of the let adds-let declares.
    assert.equal(await runs({}), 2)
    assert.equal(await runs({ babel: { 'transform-block-scoping': false } }), 0)
  })
})

describe("rn-bundle, of rn.config.json's babel, of a project with no Babel config", () => {
  const { root, cleanup } = writeTree({ ...APP, 'rn.config.json': { babel: { 'transform-classes': false } } })
  after(cleanup)

  it('refuses it, as it has no plugins to switch', async () => {
    const r = await runBundle(['--platform=ios', ...OPTIONS, '--output=out.js', 'index.js'], { cwd: root })
    assert.deepEqual([r.status, r.stderr], [1, "rn-bundle: rn.config.json's babel switches the plugins of the project's Babel config, and it has none\n"])
  })
})
