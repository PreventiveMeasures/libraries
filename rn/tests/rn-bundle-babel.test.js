import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { writeTree } from './fixtures.js'
import { BABEL_APP, BIN, MODERN, babelConfig, linked, lowered, md5, notInstalled } from './rn-bundle-app.js'

describe('rn-bundle, with a Babel config', () => {
  const { root, cleanup } = writeTree(BABEL_APP)
  after(cleanup)
  // Without the shell's BABEL_ENV and NODE_ENV, which Babel would read: only those a test sets.
  const ENV = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'BABEL_ENV' && name !== 'NODE_ENV'))
  const run = (args, env = {}) => spawnSync(process.execPath, [BIN, ...args], { cwd: root, encoding: 'utf8', env: { ...ENV, ...env } })

  it('builds each file as the project\'s Babel config makes it, for the platform', () => {
    const r = run(['--platform=ios', '--define=__DEV__=false', '--define=process.env.NODE_ENV="production"', '--output=ios.js', 'index.js'])
    assert.equal(r.status, 0, r.stderr)
    const out = JSON.parse(spawnSync(process.execPath, [join(root, 'ios.js')], { encoding: 'utf8' }).stdout)
    assert.deepEqual([out.where, out.greet, out.typed, out.generic, out.dual, out.optional, out.platform, out.dev, out.env], ['ios', 'hi', 'flow', 'generic', 'rn', 'none', 'ios', false, 'production'])
    assert.equal(out.assets[0].hash, md5('img/logo.png', 'img/logo@2x.png', 'img/logo@3x.png'))
  })

  it("gives Babel's plugins what of the build Metro's transformer gives them: Platform inlined, the transform profile, default where not given", () => {
    const caller = (...args) => {
      const r = run(['--platform=ios', ...args, '--output=caller.out.js', 'caller.js'])
      assert.equal(r.status, 0, r.stderr)
      return spawnSync(process.execPath, [join(root, 'caller.out.js')], { encoding: 'utf8' }).stdout
    }
    assert.equal(caller(), '[true,"default"]\n')
    assert.equal(caller('--unstable-transform-profile=hermes-stable'), '[true,"hermes-stable"]\n')
    assert.equal(caller('--max-workers=1'), '[true,"default"]\n')
    const workers = run(['--platform=ios', '--max-workers=many', '--output=caller.out.js', 'caller.js'])
    assert.deepEqual([workers.status, workers.stderr], [1, 'rn-bundle: --max-workers takes a number of workers, not many\n'])
    const unknown = run(['--platform=ios', '--unstable-transform-profile=hermes', '--output=caller.out.js', 'caller.js'])
    assert.deepEqual([unknown.status, unknown.stderr], [1, 'rn-bundle: --unstable-transform-profile is one of default, hermes-stable, hermes-canary\n'])
  })

  it('runs Babel in the env Metro\'s transformer names: production, else BABEL_ENV, unless --dev', () => {
    const babelEnv = (args, env) => {
      const r = run(['--platform=ios', ...args, '--output=env.js', 'index.js'], env)
      assert.equal(r.status, 0, r.stderr)
      return JSON.parse(spawnSync(process.execPath, [join(root, 'env.js')], { encoding: 'utf8' }).stdout).babelEnv
    }
    assert.equal(babelEnv([]), 'production')
    assert.equal(babelEnv([], { NODE_ENV: 'development' }), 'production')
    assert.equal(babelEnv([], { BABEL_ENV: 'staging' }), 'staging')
    assert.equal(babelEnv(['--dev']), 'development')
    assert.equal(babelEnv(['--dev'], { BABEL_ENV: 'production' }), 'development')
  })

  it('sets NODE_ENV for Babel\'s plugins as `react-native bundle` does: production, unless --dev', () => {
    const nodeEnv = (args, env) => {
      const r = run(['--platform=ios', ...args, '--output=env.js', 'index.js'], env)
      assert.equal(r.status, 0, r.stderr)
      return JSON.parse(spawnSync(process.execPath, [join(root, 'env.js')], { encoding: 'utf8' }).stdout).nodeEnv
    }
    assert.equal(nodeEnv([]), 'production')
    assert.equal(nodeEnv([], { NODE_ENV: 'development' }), 'production')
    assert.equal(nodeEnv(['--dev'], { NODE_ENV: 'production' }), 'development')
  })

  it('makes each TS file JS by esbuild before Babel, lowering the rest after it', () => {
    const r = run(['--platform=ios', '--output=modern.out.js', 'modern.js'])
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(JSON.parse(spawnSync(process.execPath, [join(root, 'modern.out.js')], { encoding: 'utf8' }).stdout), MODERN)
    assert.ok(lowered(readFileSync(join(root, 'modern.out.js'), 'utf8')))
  })

  it('leaves Flow to Babel without flow-remove-types: a @flow file that may have type arguments as it is', () => {
    const r = spawnSync(process.execPath, ['--import', notInstalled('flow-remove-types'), BIN, '--platform=ios', '--output=modern.out.js', 'modern.js'], { cwd: root, encoding: 'utf8', env: ENV })
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(JSON.parse(spawnSync(process.execPath, [join(root, 'modern.out.js')], { encoding: 'utf8' }).stdout), { ...MODERN, syntax: { ...MODERN.syntax, flow: ['ClassProperty', 'StaticBlock'] } })
  })

  it('takes a file with no import or export for a script, as Metro does: sloppy', () => {
    const r = run(['--platform=ios', '--output=sloppy.out.js', 'sloppy.js'])
    assert.equal(r.status, 0, r.stderr)
    assert.equal(spawnSync(process.execPath, [join(root, 'sloppy.out.js')], { encoding: 'utf8' }).stdout, '"with"\n')
  })

  it('fails on a TS file esbuild cannot parse', () => {
    const r = run(['--platform=ios', '--output=out.js', 'bad-ts.js'])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /Unexpected "="[\s\S]*lib\/bad\.ts:1:9/u)
  })

  it('takes no --babel-aliases where Babel runs', () => {
    const r = run(['--platform=ios', '--babel-aliases=aliases.json', '--output=out.js', 'index.js'])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /--babel-aliases maps the imports where no Babel runs/u)
  })
})

describe('rn-bundle, with Babel, with a Babel config that takes no Flow', () => {
  const { root, cleanup } = writeTree({ ...BABEL_APP, 'babel.config.js': babelConfig([['module-resolver', { alias: { '#lib': './lib' } }], '@babel/plugin-transform-react-jsx']) })
  after(cleanup)
  const run = (args) => spawnSync(process.execPath, [BIN, ...args], { cwd: root, encoding: 'utf8' })
  const output = (file) => JSON.parse(spawnSync(process.execPath, [join(root, file)], { encoding: 'utf8' }).stdout)

  it('strips the Flow types of each file that has them before Babel', () => {
    const r = run(['--platform=ios', '--output=ios.js', 'index.js'])
    assert.equal(r.status, 0, r.stderr)
    const out = output('ios.js')
    assert.deepEqual([out.where, out.greet, out.typed, out.generic, out.platform], ['ios', 'hi', 'flow', 'generic', 'ios'])
  })

  it('lowers a static block before Babel once Flow types are stripped', () => {
    const r = run(['--platform=ios', '--output=modern.out.js', 'modern.js'])
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(output('modern.out.js'), MODERN)
  })
})

describe('rn-bundle, with Babel, with Flow that is code', () => {
  // As @react-native/babel-preset's Flow parser (flow-parser/babel-plugin,
  // parseLangTypes: 'flow') reads a file that says @flow alone: one that
  // reads `component`, as a function.
  const { root, cleanup } = writeTree({
    'babel.config.js': "module.exports = { plugins: ['./flow-components.js', '@babel/plugin-transform-flow-strip-types'] }\n",
    'flow-components.js': [
      'module.exports = () => ({',
      '  parserOverride(code, options, parse) {',
      '    if (!/@flow/.test(code)) return undefined',
      "    return parse(code.replace(/\\bcomponent (\\w+)\\(/g, 'function $1('), options)",
      '  },',
      '})',
      '',
    ].join('\n'),
    'index.js': "import Greeting from './greeting'\nimport { typed } from './typed'\nconsole.log(JSON.stringify([Greeting('world'), typed]))\n",
    'greeting.js': '/**\n * @flow strict-local\n */\ntype Name = string\nexport default component Greeting(name: Name) {\n  return `hello ${name}`\n}\n',
    'typed.js': "// @flow\nexport const typed: string = 'typed'\n",
    'node_modules/@babel/core': linked('@babel/core'),
    'node_modules/@babel/plugin-transform-flow-strip-types': linked('@babel/plugin-transform-flow-strip-types'),
  })
  after(cleanup)

  it("leaves a file with Flow flow-remove-types doesn't strip to Babel as it is, its @flow pragma kept", () => {
    const r = spawnSync(process.execPath, [BIN, '--platform=ios', '--output=out.js', 'index.js'], { cwd: root, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(JSON.parse(spawnSync(process.execPath, [join(root, 'out.js')], { encoding: 'utf8' }).stdout), ['hello world', 'typed'])
  })
})

describe('rn-bundle, with Babel, of a file with a source map of its own', () => {
  // The config's plugin, which has the output say whether Babel read the
  // file's map, by its sourceMappingURL comment: for the map of its output,
  // of no use where the bundle has none.
  const { root, cleanup } = writeTree({
    'babel.config.js': "module.exports = { plugins: [({ types: t }) => ({ visitor: { Program(path, state) { path.unshiftContainer('body', t.expressionStatement(t.callExpression(t.identifier('print'), [t.booleanLiteral(state.file.inputMap != null)]))) } } })] }\n",
    // A JSX pragma, which leaves the file to Babel as it is, its comments too.
    'index.js': '/** @jsx h */\nfunction print(read) {\n  console.log(read)\n}\n//# sourceMappingURL=index.js.map\n',
    'index.js.map': { version: 3, sources: ['index.ts'], names: [], mappings: 'AAAA' },
    'node_modules/@babel/core': linked('@babel/core'),
  })
  after(cleanup)
  const read = (...args) => {
    const r = spawnSync(process.execPath, [BIN, '--platform=ios', '--output=out.js', ...args, 'index.js'], { cwd: root, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    return spawnSync(process.execPath, [join(root, 'out.js')], { encoding: 'utf8' }).stdout
  }

  it('reads it only where the bundle has a source map', () => {
    assert.equal(read(), 'false\n')
    assert.equal(read('--sourcemap-output=out.map'), 'true\n')
  })
})

describe('rn-bundle, with Babel, with a .babelrc of a directory of its own', () => {
  // Each directory read once for a .babelrc: the one beneath, in the files
  // beneath it, as Babel finds it, and none above it.
  const { root, cleanup } = writeTree({
    'babel.config.js': 'module.exports = {}\n',
    'index.js': "import { inner } from './sub/deep/inner'\nconsole.log(JSON.stringify([inner, typeof __BABELRC__ === 'undefined' ? null : __BABELRC__]))\n",
    'sub/.babelrc': { plugins: ['../babelrc-plugin.js'] },
    'sub/deep/inner.js': 'export const inner = __BABELRC__\n',
    'babelrc-plugin.js': "module.exports = ({ types: t }) => ({ visitor: { Identifier(path) { if (path.node.name === '__BABELRC__') path.replaceWith(t.stringLiteral('sub')) } } })\n",
    'node_modules/@babel/core': linked('@babel/core'),
  })
  after(cleanup)

  it('takes it for the files beneath it alone', () => {
    const r = spawnSync(process.execPath, [BIN, '--platform=ios', '--output=out.js', 'index.js'], { cwd: root, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(JSON.parse(spawnSync(process.execPath, [join(root, 'out.js')], { encoding: 'utf8' }).stdout), ['sub', null])
  })
})

describe("rn-bundle, with Babel, with Reanimated's plugin", () => {
  // As Reanimated 4's (react-native-worklets'), which has each file it runs
  // in say so.
  const { root, cleanup } = writeTree({
    'babel.config.js': "module.exports = { plugins: ['react-native-worklets/plugin'] }\n",
    'node_modules/react-native-worklets/plugin/index.js': "module.exports = ({ types: t }) => ({ name: 'worklets', visitor: { Program: { exit(path, state) { path.pushContainer('body', t.expressionStatement(t.callExpression(t.identifier('ran'), [t.stringLiteral(require('path').basename(state.filename))]))) } } } })\n",
    'index.js': "globalThis.ran = (name) => (globalThis.files ??= []).push(name)\nrequire('./animated')\nrequire('./plain')\nconsole.log(JSON.stringify(globalThis.files))\n",
    'animated.js': "const useAnimatedStyle = (style) => style\nmodule.exports = useAnimatedStyle(() => ({ opacity: 1 }))\n",
    'plain.js': 'module.exports = 1\n',
    'node_modules/@babel/core': linked('@babel/core'),
  })
  after(cleanup)
  const run = (args) => spawnSync(process.execPath, [BIN, '--platform=ios', ...args, 'index.js'], { cwd: root, encoding: 'utf8' })

  it('runs it in the files that name what it acts on alone; --self-test, which builds again with it in each, finds where that changes one', () => {
    const r = run(['--output=out.js'])
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(JSON.parse(spawnSync(process.execPath, [join(root, 'out.js')], { encoding: 'utf8' }).stdout), ['animated.js'])
    const selfTest = run(['--self-test'])
    assert.equal(selfTest.status, 1)
    assert.match(selfTest.stderr, /index\.js|plain\.js/u)
  })
})
