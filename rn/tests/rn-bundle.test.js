import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { SourceMap, createRequire } from 'node:module'
import { join, relative, sep } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { png, writeTree } from './fixtures.js'

const esbuild = createRequire(import.meta.url)('esbuild')
const BIN = fileURLToPath(new URL('../bin/rn-bundle.js', import.meta.url))

const APP = {
  'index.js': [
    '/** @jsx h */',
    "import { where } from './lib/where'",
    "import { greet } from '#lib/greet'",
    "import { typed } from './lib/typed'",
    "import { generic } from './lib/generic'",
    "import dual from 'dual'",
    "import { optional } from './lib/optional'",
    "import font from './fonts/Inter.ttf'",
    "import { getAssetByID } from 'react-native/Libraries/Image/AssetRegistry'",
    'const h = (type, props) => props.source',
    "const Image = 'Image'",
    "const logo = <Image source={require('./img/logo.png')} />",
    "const icon = require('./img/icon.png')",
    "const platform = typeof __PLATFORM__ === 'undefined' ? null : __PLATFORM__",
    "const babelEnv = typeof __BABEL_ENV__ === 'undefined' ? null : __BABEL_ENV__",
    "const nodeEnv = typeof __NODE_ENV__ === 'undefined' ? null : __NODE_ENV__",
    'console.log(JSON.stringify({ where, greet: greet(), typed, generic, dual, optional, platform, babelEnv, nodeEnv, dev: __DEV__, env: process.env.NODE_ENV, ids: [logo, icon, font], assets: [logo, icon, font].map(getAssetByID) }))',
    '',
  ].join('\n'),
  'lib/where.ios.js': "export const where = 'ios'\n",
  'lib/where.android.js': "export const where = 'android'\n",
  'lib/greet.js': "export const greet = () => 'hi'\n",
  // An optional dependency, as Metro takes one: a require in a try block, of what isn't installed.
  'lib/optional.js': "let flash = 'none'\ntry {\n  flash = require('@shopify/flash-list')\n} catch {}\nexport const optional = flash\n",
  // What Metro resolves nothing for, as a browser field redirects it to an absolute path, and esbuild would.
  'divergent/package.json': { name: 'divergent', browser: { dep: '/nowhere/dep.js' } },
  'divergent/index.js': "require('dep')\n",
  'node_modules/dep/index.js': '',
  'lib/typed.js': "// @flow\nimport type { T } from './types'\nexport const typed: string = 'flow'\n",
  'lib/types.js': '// @flow\nexport type T = string\n',
  // @flow in a string, not a leading comment: JS, not Flow.
  'mentions.js': "console.log(JSON.stringify(['@flow', 1 /* @flow */]))\n",
  // Valid JS too, as `(box < string) > 'generic'.value`.
  'lib/generic.js': "// @flow\nconst box = (value) => ({ value })\nexport class Box { value = 1; static { Box.ready = true } }\nexport const generic = box<string>('generic').value\nexport const syntax = typeof __SYNTAX__ === 'undefined' ? null : __SYNTAX__\n",
  'enum.js': "import { Mode } from './lib/mode'\nconsole.log(Mode)\n",
  'lib/mode.js': '// @flow\nexport enum Mode { A, B }\n',
  'broken.js': "import './lib/broken'\n",
  'lib/broken.js': 'const a = (b: ) => 1\n',
  'aliases.json': { '#lib': './lib' },
  'bad-aliases.json': { '^(': './lib' },
  'img/logo.png': png(20, 10),
  'img/logo@2x.png': png(40, 20),
  'img/logo@3x.png': png(60, 30),
  'img/icon.png': png(8, 8),
  'img/icon.android.png': png(9, 9),
  'fonts/Inter.ttf': 'font bytes',
  'node_modules/dual/package.json': { name: 'dual', main: 'node.js', 'react-native': 'rn.js' },
  'node_modules/dual/node.js': "module.exports = 'node'\n",
  'node_modules/dual/rn.js': "module.exports = 'rn'\n",
  'node_modules/react-native/package.json': { name: 'react-native', version: '0.81.0' },
  'node_modules/react-native/Libraries/Image/AssetRegistry.js': "export { registerAsset, getAssetByID } from '@react-native/assets-registry/registry'\n",
  'node_modules/@react-native/assets-registry/package.json': { name: '@react-native/assets-registry', version: '0.81.0' },
  'node_modules/@react-native/assets-registry/registry.js': 'const assets = []\nmodule.exports = { registerAsset: (asset) => assets.push(asset), getAssetByID: (id) => assets[id - 1] }\n',
}

// A module for --import, as if a package were installed nowhere.
const notInstalled = (name) => `data:text/javascript,${encodeURIComponent([
  "import Module from 'node:module'",
  'const resolve = Module._resolveFilename',
  `Module._resolveFilename = function (request, ...rest) { if (request === ${JSON.stringify(name)}) throw Object.assign(new Error(request), { code: 'MODULE_NOT_FOUND' }); return resolve.call(this, request, ...rest) }`,
].join('\n'))}`
const OPTIONS = ['--babel-aliases=aliases.json', '--define=__DEV__=false', '--define=process.env.NODE_ENV="production"']
const md5 = (...files) => {
  const hash = createHash('md5')
  for (const file of files) hash.update(APP[file])
  return hash.digest('hex')
}
const listFiles = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'))
  .toSorted()

describe('rn-bundle', () => {
  const { root, cleanup } = writeTree(APP)
  after(cleanup)
  const run = (args) => spawnSync(process.execPath, [BIN, ...args], { cwd: root, encoding: 'utf8' })
  const output = (file) => JSON.parse(spawnSync(process.execPath, [join(root, file)], { encoding: 'utf8' }).stdout)

  it('minifies with --minify, to a bundle that does the same', () => {
    for (const [file, args] of [['plain.js', []], ['min.js', ['--minify']]]) {
      const r = run(['--platform=ios', ...OPTIONS, ...args, `--output=${file}`, 'index.js'])
      assert.equal(r.status, 0, r.stderr)
    }
    assert.deepEqual(output('min.js'), output('plain.js'))
    const [plain, min] = ['plain.js', 'min.js'].map((file) => readFileSync(join(root, file), 'utf8'))
    assert.ok(min.length < plain.length * 0.6, `${min.length} of ${plain.length}`)
    assert.ok(min.split('\n').length < plain.split('\n').length / 10, `${min.split('\n').length} lines of ${plain.split('\n').length}`)
  })

  it('bundles for iOS: its files, the aliases, Flow, the defines, and each asset as Metro builds it', () => {
    const r = run(['--platform=ios', ...OPTIONS, '--assets-dest=ios-assets', '--output=ios.js', 'index.js'])
    assert.equal(r.status, 0, r.stderr)
    const out = output('ios.js')
    assert.deepEqual([out.where, out.greet, out.typed, out.generic, out.dual, out.optional, out.dev, out.env], ['ios', 'hi', 'flow', 'generic', 'rn', 'none', false, 'production'])
    assert.deepEqual(out.ids.toSorted(), [1, 2, 3])
    const [logo, icon, font] = out.assets
    assert.deepEqual(logo, { __packager_asset: true, httpServerLocation: '/assets/img', width: 20, height: 10, scales: [1, 2, 3], hash: md5('img/logo.png', 'img/logo@2x.png', 'img/logo@3x.png'), name: 'logo', type: 'png' })
    assert.deepEqual([icon.width, icon.hash], [8, md5('img/icon.png')])
    assert.deepEqual(font, { __packager_asset: true, httpServerLocation: '/assets/fonts', scales: [1], hash: md5('fonts/Inter.ttf'), name: 'Inter', type: 'ttf' })
    assert.deepEqual(listFiles(join(root, 'ios-assets')), ['assets/fonts/Inter.ttf', 'assets/img/icon.png', 'assets/img/logo.png', 'assets/img/logo@2x.png', 'assets/img/logo@3x.png'])
    assert.deepEqual(readFileSync(join(root, 'ios-assets/assets/img/logo@3x.png')), APP['img/logo@3x.png'])
  })

  it('bundles for Android: its files and its assets, into res/', () => {
    const r = run(['--platform=android', ...OPTIONS, '--assets-dest=res', '--output=android.js', 'index.js'])
    assert.equal(r.status, 0, r.stderr)
    const out = output('android.js')
    assert.equal(out.where, 'android')
    assert.deepEqual([out.assets[1].width, out.assets[1].hash], [9, md5('img/icon.android.png')])
    assert.deepEqual(listFiles(join(root, 'res')), ['drawable-mdpi/img_icon.png', 'drawable-mdpi/img_logo.png', 'drawable-xhdpi/img_logo.png', 'drawable-xxhdpi/img_logo.png', 'raw/fonts_inter.ttf', 'raw/keep.xml'])
  })

  it("puts iOS's png and jpg assets in an asset catalog with --asset-catalog-dest, each an image set, the rest in --assets-dest", () => {
    // What a build before left, its image sets removed.
    mkdirSync(join(root, 'stage/RNAssets.xcassets/stale.imageset'), { recursive: true })
    writeFileSync(join(root, 'stage/RNAssets.xcassets/stale.imageset/Contents.json'), '{}')
    writeFileSync(join(root, 'stage/RNAssets.xcassets/Contents.json'), '{}')
    const r = run(['--platform=ios', ...OPTIONS, '--assets-dest=catalog-assets', '--asset-catalog-dest=stage', '--output=catalog.js', 'index.js'])
    assert.equal(r.status, 0, r.stderr)
    assert.equal(output('catalog.js').assets[0].name, 'logo')
    assert.deepEqual(listFiles(join(root, 'stage')), [
      'RNAssets.xcassets/Contents.json',
      'RNAssets.xcassets/img_icon.imageset/Contents.json',
      'RNAssets.xcassets/img_icon.imageset/img_icon.png',
      'RNAssets.xcassets/img_logo.imageset/Contents.json',
      'RNAssets.xcassets/img_logo.imageset/img_logo.png',
      'RNAssets.xcassets/img_logo.imageset/img_logo@2x.png',
      'RNAssets.xcassets/img_logo.imageset/img_logo@3x.png',
    ])
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'stage/RNAssets.xcassets/img_logo.imageset/Contents.json'), 'utf8')), {
      images: [1, 2, 3].map((scale) => ({ filename: `img_logo${scale === 1 ? '' : `@${scale}x`}.png`, idiom: 'universal', scale: `${scale}x` })),
      info: { author: 'xcode', version: 1 },
    })
    assert.deepEqual(readFileSync(join(root, 'stage/RNAssets.xcassets/img_logo.imageset/img_logo@3x.png')), APP['img/logo@3x.png'])
    assert.deepEqual(listFiles(join(root, 'catalog-assets')), ['assets/fonts/Inter.ttf'])
  })

  it('takes --asset-catalog-dest for iOS alone, and the options of a source map with --sourcemap-output alone', () => {
    for (const [args, message] of [
      [['--platform=android', '--asset-catalog-dest=stage'], /--asset-catalog-dest is for iOS/u],
      [['--platform=ios', '--sourcemap-sources-root=.'], /shape the map of --sourcemap-output: pass it/u],
      [['--platform=ios', '--sourcemap-use-absolute-path'], /shape the map of --sourcemap-output: pass it/u],
    ]) {
      const r = run([...args, '--output=refused.js', 'index.js'])
      assert.equal(r.status, 1)
      assert.match(r.stderr, message)
    }
  })

  it('takes a file for Flow by @flow in its leading comments alone', () => {
    const r = spawnSync(process.execPath, ['--import', notInstalled('flow-remove-types'), BIN, '--platform=ios', '--output=mentions.out.js', 'mentions.js'], { cwd: root, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(output('mentions.out.js'), ['@flow', 1])
  })

  it('fails on what it cannot resolve, parse or strip', () => {
    const noAliases = run(['--platform=ios', '--output=out.js', 'index.js'])
    assert.equal(noAliases.status, 1)
    assert.match(noAliases.stderr, /Could not resolve "#lib\/greet"[\s\S]*index\.js/u)
    const divergent = run(['--platform=ios', '--output=out.js', 'divergent/index.js'])
    assert.equal(divergent.status, 1)
    assert.match(divergent.stderr, /esbuild resolved node_modules\/dep\/index\.js where Metro resolves nothing/u)
    const noFlow = spawnSync(process.execPath, ['--import', notInstalled('flow-remove-types'), BIN, '--platform=ios', '--babel-aliases=aliases.json', '--output=out.js', 'index.js'], { cwd: root, encoding: 'utf8' })
    assert.equal(noFlow.status, 1)
    assert.match(noFlow.stderr, /Can't strip Flow types from lib\/typed\.js: it needs flow-remove-types/u)
    const enumFlow = run(['--platform=ios', '--output=out.js', 'enum.js'])
    assert.equal(enumFlow.status, 1)
    assert.match(enumFlow.stderr, /Flow syntax flow-remove-types doesn't strip: Unexpected "enum"[\s\S]*lib\/mode\.js:2:7/u)
    const broken = run(['--platform=ios', '--output=out.js', 'broken.js'])
    assert.equal(broken.status, 1)
    assert.match(broken.stderr, /Can't strip Flow types from lib\/broken\.js: Unexpected token[\s\S]*lib\/broken\.js:1:14:/u)
    for (const [file, message] of [['none.json', "can't read none.json as JSON"], ['bad-aliases.json', 'bad-aliases.json: "^(" is not a valid regular expression']]) {
      const r = run(['--platform=ios', `--babel-aliases=${file}`, '--output=out.js', 'index.js'])
      assert.deepEqual([r.status, r.stderr], [1, `rn-bundle: --babel-aliases: ${message}\n`])
    }
    const noPlatform = run(['--output=out.js', 'index.js'])
    assert.equal(noPlatform.status, 1)
    assert.match(noPlatform.stderr, /--platform is required/u)
  })

  it('builds for release unless --dev, as Metro does, a --define overriding either', () => {
    const build = (...args) => {
      const r = run(['--platform=ios', '--babel-aliases=aliases.json', ...args, '--output=env.js', 'index.js'])
      assert.equal(r.status, 0, r.stderr)
      const { dev, env } = output('env.js')
      return [dev, env]
    }
    assert.deepEqual(build(), [false, 'production'])
    assert.deepEqual(build('--dev'), [true, 'development'])
    assert.deepEqual(build('--dev', '--define=__DEV__=false'), [false, 'development'])
  })
})

// The project's own Babel, as an app installs it: the workspace's copies linked in.
const linked = (name) => ({ link: realpathSync(fileURLToPath(new URL(`../node_modules/${name}`, import.meta.url))) })
// __SYNTAX__ is the class syntax and decorators a file still has when Babel
// gets it; the decorators are then taken off.
const babelConfig = (plugins) => [
  'module.exports = (api) => {',
  '  const inline = (name, value) => ({ types: t }) => ({ visitor: { Identifier(path) { if (path.node.name === name) path.replaceWith(t.stringLiteral(value)) } } })',
  "  const platformOf = inline('__PLATFORM__', api.caller((caller) => caller && caller.platform))",
  "  const callerOf = inline('__CALLER__', api.caller((caller) => caller && JSON.stringify([caller.inlinePlatform, caller.unstable_transformProfile])))",
  '  // NODE_ENV as a plugin reads it, as it transforms.',
  "  const nodeEnvOf = ({ types: t }) => ({ visitor: { Identifier(path) { if (path.node.name === '__NODE_ENV__') path.replaceWith(t.stringLiteral(String(process.env.NODE_ENV))) } } })",
  '  const syntaxOf = ({ types: t }) => ({',
  '    pre() { this.seen = new Set() },',
  '    visitor: {',
  "      'ClassProperty|ClassPrivateProperty|ClassPrivateMethod|StaticBlock|Decorator'(path) { this.seen.add(path.type); if (path.isDecorator()) path.remove() },",
  "      Identifier(path) { if (path.node.name === '__SYNTAX__') path.replaceWith(t.valueToNode([...this.seen].toSorted())) },",
  '    },',
  '  })',
  `  return { parserOpts: { plugins: ['decorators-legacy'] }, plugins: [${plugins.map((plugin) => JSON.stringify(plugin)).join(', ')}, platformOf, callerOf, inline('__BABEL_ENV__', api.env()), nodeEnvOf, syntaxOf] }`,
  '}',
  '',
].join('\n')
const BABEL_APP = {
  ...APP,
  'babel.config.js': babelConfig([['module-resolver', { alias: { '#lib': './lib' } }], '@babel/plugin-transform-flow-strip-types', '@babel/plugin-transform-react-jsx']),
  'modern.js': [
    "import { Counter, syntax as counter } from './lib/counter'",
    "import { generic, syntax as flow } from './lib/generic'",
    "import { syntax as ready } from './lib/ready'",
    "import { syntax as decorated } from './lib/decorated'",
    "import { Card, syntax as card } from './lib/card'",
    "import { syntax as note } from './lib/note'",
    'const c = Counter.make().bump().bump()',
    "const k = new Card({ title: 'hi' })",
    'console.log(JSON.stringify({ counter: [c.count, Counter.made, Counter.ready, Counter.owns(c), Counter.owns({})], generic, card: [k.context, Card.kind, k.render(), k.render().renders], syntax: { counter, flow, ready, decorated, card, note } }))',
    '',
  ].join('\n'),
  // @flow with no call with type arguments: lowered before Babel, which
  // @react-native/babel-preset needs of a static block.
  'lib/ready.js': '// @flow\nexport class Ready { static { Ready.ready = true } }\nexport const syntax = __SYNTAX__\n',
  'lib/counter.js': [
    'export class Counter {',
    '  static #made = 0',
    '  static { Counter.ready = true }',
    '  #count = 0',
    '  step = 2',
    '  static make() { Counter.#made++; return new Counter() }',
    '  #bump() { this.#count += this.step; return this }',
    '  bump() { return this.#bump() }',
    '  get count() { return this.#count }',
    '  static owns(value) { return #count in value }',
    '  static get made() { return Counter.#made }',
    '}',
    'export const syntax = __SYNTAX__',
    '',
  ].join('\n'),
  // React is used only by JSX, which Babel's classic runtime needs it for;
  // `context` has no value, so Metro drops it and the base class's stays.
  'lib/card.tsx': [
    "import React, { Component } from 'react'",
    "import { Shape } from './shape'",
    'export class Card extends Component<{ title: string }> {',
    '  declare shape: Shape',
    '  context!: string',
    "  static kind = 'card'",
    '  #renders = 0',
    '  render() {',
    '    this.#renders++',
    '    return <Text renders={this.#renders}>{this.props.title as string}</Text>',
    '  }',
    '}',
    "const Text = 'Text'",
    'export const syntax = __SYNTAX__',
    '',
  ].join('\n'),
  'lib/shape.ts': 'export type Shape = { width: number }\n',
  'bad-ts.js': "import './lib/bad'\n",
  'lib/bad.ts': 'const a: = 1\n',
  'caller.js': 'console.log(__CALLER__)\n',
  // Sloppy, as a script may be.
  'sloppy.js': "console.log(JSON.stringify(require('./lib/sloppy')))\n",
  'lib/sloppy.js': "var scope = { value: 'with' }\nwith (scope) {\n  module.exports = value\n}\n",
  'lib/note.ts': "const field = (name: string) => () => {}\nexport class Note {\n  static table = 'notes'\n  @field('body') body!: string\n}\nexport const syntax = __SYNTAX__\n",
  'node_modules/react/package.json': { name: 'react', version: '19.0.0' },
  'node_modules/react/index.js': "class Component { constructor(props) { this.props = props; this.context = 'base' } }\nmodule.exports = { Component, createElement: (type, props, ...children) => ({ type, ...props, children }) }\n",
  // A decorated field, as in WatermelonDB models.
  'lib/decorated.js': "const field = () => () => {}\nexport class Post {\n  static table = 'posts'\n  @field('title') title\n}\nexport const syntax = __SYNTAX__\n",
  'node_modules/@babel/core': linked('@babel/core'),
  'node_modules/@babel/plugin-transform-flow-strip-types': linked('@babel/plugin-transform-flow-strip-types'),
  'node_modules/@babel/plugin-transform-react-jsx': linked('@babel/plugin-transform-react-jsx'),
  'node_modules/babel-plugin-module-resolver': linked('babel-plugin-module-resolver'),
}

const MODERN = {
  counter: [4, 1, true, true, false],
  generic: 'generic',
  card: ['base', 'card', { type: 'Text', renders: 1, children: ['hi'] }, 2],
  syntax: { counter: [], flow: ['ClassProperty'], ready: [], decorated: ['ClassProperty', 'Decorator'], card: [], note: ['ClassProperty', 'Decorator'] },
}
// Whether esbuild finds nothing in a bundle left to lower.
const lowered = (code) => esbuild.transformSync(code, { supported: { 'class-field': false, 'class-private-field': false, 'class-private-method': false, 'class-static-blocks': false, 'class-static-field': false, using: false } }).code === esbuild.transformSync(code).code

describe('rn-bundle --babel', () => {
  const { root, cleanup } = writeTree(BABEL_APP)
  after(cleanup)
  // Without the shell's BABEL_ENV and NODE_ENV, which Babel would read: only those a test sets.
  const ENV = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'BABEL_ENV' && name !== 'NODE_ENV'))
  const run = (args, env = {}) => spawnSync(process.execPath, [BIN, ...args], { cwd: root, encoding: 'utf8', env: { ...ENV, ...env } })

  it('builds each file as the project\'s Babel config makes it, for the platform', () => {
    const r = run(['--platform=ios', '--babel', '--define=__DEV__=false', '--define=process.env.NODE_ENV="production"', '--output=ios.js', 'index.js'])
    assert.equal(r.status, 0, r.stderr)
    const out = JSON.parse(spawnSync(process.execPath, [join(root, 'ios.js')], { encoding: 'utf8' }).stdout)
    assert.deepEqual([out.where, out.greet, out.typed, out.generic, out.dual, out.optional, out.platform, out.dev, out.env], ['ios', 'hi', 'flow', 'generic', 'rn', 'none', 'ios', false, 'production'])
    assert.equal(out.assets[0].hash, md5('img/logo.png', 'img/logo@2x.png', 'img/logo@3x.png'))
  })

  it("gives Babel's plugins what of the build Metro's transformer gives them: Platform inlined, the transform profile, default where not given", () => {
    const caller = (...args) => {
      const r = run(['--platform=ios', '--babel', ...args, '--output=caller.out.js', 'caller.js'])
      assert.equal(r.status, 0, r.stderr)
      return spawnSync(process.execPath, [join(root, 'caller.out.js')], { encoding: 'utf8' }).stdout
    }
    assert.equal(caller(), '[true,"default"]\n')
    assert.equal(caller('--unstable-transform-profile=hermes-stable'), '[true,"hermes-stable"]\n')
    const unknown = run(['--platform=ios', '--babel', '--unstable-transform-profile=hermes', '--output=caller.out.js', 'caller.js'])
    assert.deepEqual([unknown.status, unknown.stderr], [1, 'rn-bundle: --unstable-transform-profile is one of default, hermes-stable, hermes-canary\n'])
    const alone = run(['--platform=ios', '--unstable-transform-profile=hermes-stable', '--output=caller.out.js', 'caller.js'])
    assert.equal(alone.status, 1)
  })

  it('runs Babel in the env Metro\'s transformer names: production, else BABEL_ENV, unless --dev', () => {
    const babelEnv = (args, env) => {
      const r = run(['--platform=ios', ...args, '--babel', '--output=env.js', 'index.js'], env)
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
      const r = run(['--platform=ios', ...args, '--babel', '--output=env.js', 'index.js'], env)
      assert.equal(r.status, 0, r.stderr)
      return JSON.parse(spawnSync(process.execPath, [join(root, 'env.js')], { encoding: 'utf8' }).stdout).nodeEnv
    }
    assert.equal(nodeEnv([]), 'production')
    assert.equal(nodeEnv([], { NODE_ENV: 'development' }), 'production')
    assert.equal(nodeEnv(['--dev'], { NODE_ENV: 'production' }), 'development')
  })

  it('makes each TS file JS by esbuild before Babel, lowering the rest after it', () => {
    const r = run(['--platform=ios', '--babel', '--output=modern.out.js', 'modern.js'])
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(JSON.parse(spawnSync(process.execPath, [join(root, 'modern.out.js')], { encoding: 'utf8' }).stdout), MODERN)
    assert.ok(lowered(readFileSync(join(root, 'modern.out.js'), 'utf8')))
  })

  it('leaves Flow to Babel without flow-remove-types: a @flow file that may have type arguments as it is', () => {
    const r = spawnSync(process.execPath, ['--import', notInstalled('flow-remove-types'), BIN, '--platform=ios', '--babel', '--output=modern.out.js', 'modern.js'], { cwd: root, encoding: 'utf8', env: ENV })
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(JSON.parse(spawnSync(process.execPath, [join(root, 'modern.out.js')], { encoding: 'utf8' }).stdout), { ...MODERN, syntax: { ...MODERN.syntax, flow: ['ClassProperty', 'StaticBlock'] } })
  })

  it('takes a file with no import or export for a script, as Metro does: sloppy', () => {
    const r = run(['--platform=ios', '--babel', '--output=sloppy.out.js', 'sloppy.js'])
    assert.equal(r.status, 0, r.stderr)
    assert.equal(spawnSync(process.execPath, [join(root, 'sloppy.out.js')], { encoding: 'utf8' }).stdout, '"with"\n')
  })

  it('fails on a TS file esbuild cannot parse', () => {
    const r = run(['--platform=ios', '--babel', '--output=out.js', 'bad-ts.js'])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /Unexpected "="[\s\S]*lib\/bad\.ts:1:9/u)
  })

  it('takes no --babel-aliases with it', () => {
    const r = run(['--platform=ios', '--babel', '--babel-aliases=aliases.json', '--output=out.js', 'index.js'])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /pass one/u)
  })
})

describe('rn-bundle --babel, with a Babel config that takes no Flow', () => {
  const { root, cleanup } = writeTree({ ...BABEL_APP, 'babel.config.js': babelConfig([['module-resolver', { alias: { '#lib': './lib' } }], '@babel/plugin-transform-react-jsx']) })
  after(cleanup)
  const run = (args) => spawnSync(process.execPath, [BIN, ...args], { cwd: root, encoding: 'utf8' })
  const output = (file) => JSON.parse(spawnSync(process.execPath, [join(root, file)], { encoding: 'utf8' }).stdout)

  it('strips the Flow types of each file that has them before Babel', () => {
    const r = run(['--platform=ios', '--babel', '--output=ios.js', 'index.js'])
    assert.equal(r.status, 0, r.stderr)
    const out = output('ios.js')
    assert.deepEqual([out.where, out.greet, out.typed, out.generic, out.platform], ['ios', 'hi', 'flow', 'generic', 'ios'])
  })

  it('lowers a static block before Babel once Flow types are stripped', () => {
    const r = run(['--platform=ios', '--babel', '--output=modern.out.js', 'modern.js'])
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(output('modern.out.js'), MODERN)
  })
})

describe('rn-bundle --babel, with Babel\'s TS plugin in the config', () => {
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
  const build = (options, entry = 'main.ts', ...args) => {
    writeFileSync(join(root, 'babel.config.js'), config(options))
    const r = spawnSync(process.execPath, [BIN, '--platform=ios', '--babel', ...args, '--output=main.out.js', entry], { cwd: root, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    return JSON.parse(spawnSync(process.execPath, [join(root, 'main.out.js')], { encoding: 'utf8' }).stdout)
  }

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

describe('rn-bundle --babel, with Babel plugins for what esbuild lowers before it', () => {
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
    const r = spawnSync(process.execPath, [BIN, '--platform=ios', '--babel', ...args, '--output=main.out.js', 'main.js'], { cwd: root, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
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
    assert.match(stderr, /^Babel: 6 files, \d+ ms, summed over its workers\n {6}ms {7}% {4}files {6}calls {2}plugin$/mu)
    assert.match(stderr, /^ +\d+ +[\d.]+ +\d+ +\d+ {2}internal\.blockHoist$/mu)
    assert.match(stderr, /^ {6}ms {7}% {4}files {6}calls {2}Babel, outside plugins\n(?: +\d+ +[\d.]+ +6 +\d+ {2}(?:config|parsing|scopes|printing)\n){4} +\d+ +[\d.]+ {22}traversal, and the rest$/mu)
    // Each plugin's one visitor runs once in each file it is in.
    const rows = Object.fromEntries([...stderr.matchAll(/^ +\d+ +[\d.]+ +(\d+) +(\d+) {2}(\S+)$/gmu)].map(([, files, calls, key]) => [key, [Number(files), Number(calls)]]))
    const counts = { ...once, ...js, 'transform-arrow-functions': 6 }
    assert.deepEqual(Object.fromEntries(KEYS.map((key) => [key, rows[key]])), Object.fromEntries(KEYS.map((key) => [key, [counts[key], counts[key]]])))
  })

  it('takes --profile only with --babel', () => {
    const r = spawnSync(process.execPath, [BIN, '--platform=ios', '--profile', '--output=out.js', 'main.js'], { cwd: root, encoding: 'utf8' })
    assert.deepEqual([r.status, r.stderr], [1, 'rn-bundle: --profile times the plugins of --babel: pass it\n'])
  })

  it('leaves to Babel what a plugin with options lowers', () => {
    const { code, ran } = build({ 'transform-async-to-generator': { module: 'bluebird', method: 'coroutine' } })
    assert.deepEqual(ran, { ...once, ...js, 'transform-arrow-functions': 6, 'transform-async-to-generator': 6 })
    assert.ok(/async function load\(/u.test(code) && code.includes('__asyncGenerator('))
  })
})

describe('rn-bundle --babel, with a Babel config that lowers let and const', () => {
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
    // A return outside a function, which the config's parser options take.
    'returns.js': "if (globalThis.skip) return\nconsole.log('const')\n",
    'node_modules/@babel/core': linked('@babel/core'),
  })
  after(cleanup)
  const build = (plugins, entry = 'main.js', rest = '') => {
    writeFileSync(join(root, 'babel.config.js'), config(plugins, rest))
    return spawnSync(process.execPath, [BIN, '--platform=ios', '--babel', '--output=out.js', entry], { cwd: root, encoding: 'utf8' })
  }
  const blockScoping = "() => ({ name: 'transform-block-scoping', visitor: {} })"

  it("adds no let or const after Babel: esbuild's helpers bind each key apart", () => {
    const r = build([blockScoping])
    assert.equal(r.status, 0, r.stderr)
    const code = readFileSync(join(root, 'out.js'), 'utf8')
    assert.ok(!/\b(?:let|const)\b/u.test(code), code)
    assert.deepEqual(JSON.parse(spawnSync(process.execPath, [join(root, 'out.js')], { encoding: 'utf8' }).stdout), [['default', { a: 1, b: 2 }], ['a', 1], ['b', 2]])
  })

  it("lowers again by the config's plugin what Babel's others leave of let and const after it", () => {
    // As Reanimated's worklets: a const put in once block scoping has run.
    const late = "({ template }) => ({ post(file) { file.path.pushContainer('body', template.statements.ast('const late = 1; console.log(late)')) } })"
    const lowers = "() => ({ name: 'transform-block-scoping', visitor: { VariableDeclaration(path) { path.node.kind = 'var' } } })"
    const r = build([late, lowers], 'late.js')
    assert.equal(r.status, 0, r.stderr)
    const code = readFileSync(join(root, 'out.js'), 'utf8')
    assert.ok(!/\b(?:let|const)\b/u.test(code), code)
    assert.equal(spawnSync(process.execPath, [join(root, 'out.js')], { encoding: 'utf8' }).stdout, 'early\n1\n')
  })

  it("parses Babel's output again as its config's parser options have it", () => {
    const r = build([blockScoping], 'returns.js', 'parserOpts: { allowReturnOutsideFunction: true }, ')
    assert.equal(r.status, 0, r.stderr)
    assert.equal(spawnSync(process.execPath, [join(root, 'out.js')], { encoding: 'utf8' }).stdout, 'const\n')
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

describe('rn-bundle --babel --esm, with a Babel config that makes modules CommonJS', () => {
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
      "const esm = require('./lib/esm')",
      'console.log(JSON.stringify({ made: make(), named, used, area: area(3), viaExports: viaExports(), partial, cond, required, esm: [esm.default, esm.value] }))',
      '',
    ].join('\n'),
    'lib/cjs.js': "module.exports = () => 'made'\nmodule.exports.named = 'named'\n",
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
    'node_modules/@babel/core': linked('@babel/core'),
    'node_modules/@babel/plugin-transform-modules-commonjs': linked('@babel/plugin-transform-modules-commonjs'),
  })
  after(cleanup)
  const build = (...args) => {
    const r = spawnSync(process.execPath, [BIN, '--platform=ios', '--babel', ...args, '--output=out.js', 'index.js'], { cwd: root, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    const code = readFileSync(join(root, 'out.js'), 'utf8')
    return { code, stderr: r.stderr, out: JSON.parse(spawnSync(process.execPath, [join(root, 'out.js')], { encoding: 'utf8' }).stdout) }
  }
  const OUT = { made: 'made', named: 'named', used: 'used', area: 9, viaExports: 'own', partial: ['present', null], cond: 'import', required: 'require', esm: ['default', 'value'] }

  it('resolves an import Babel makes a require call as an ESM import, as Metro does', () => {
    const { out } = build()
    assert.deepEqual([out.cond, out.required], ['import', 'require'])
  })

  it('leaves import and export to esbuild, which links the modules and drops what is unused of them', () => {
    const commonjs = build()
    assert.deepEqual(commonjs.out, OUT)
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

  it('takes --esm only with --babel', () => {
    const r = spawnSync(process.execPath, [BIN, '--platform=ios', '--esm', '--output=out.js', 'index.js'], { cwd: root, encoding: 'utf8' })
    assert.deepEqual([r.status, r.stderr], [1, 'rn-bundle: --esm keeps ES modules through --babel: pass it\n'])
  })
})

describe('rn-bundle --babel, with plugins after babel-plugin-module-resolver', () => {
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
  const run = (entry) => spawnSync(process.execPath, [BIN, '--platform=ios', '--babel', '--output=out.js', entry], { cwd: root, encoding: 'utf8' })

  it('keeps module-resolver in Babel, before the plugins that read what it rewrote', () => {
    const r = run('index.js')
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(JSON.parse(spawnSync(process.execPath, [join(root, 'out.js')], { encoding: 'utf8' }).stdout), { name: 'a' })
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

describe("rn-bundle --babel, with babel-plugin-module-resolver's aliases", () => {
  const { root, cleanup } = writeTree({
    'index.js': "import { a } from '#lib/a'\nimport { b } from './b'\nimport { e } from './escaped'\nimport { i } from './identity'\nconsole.log(JSON.stringify([a, b, e, i]))\n",
    'lib/a.js': "export const a = 'a'\n",
    'b.js': "export const b = 'b'\n",
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
    const r = spawnSync(process.execPath, [BIN, '--platform=ios', '--babel', '--profile', '--output=out.js', 'index.js'], { cwd: root, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(JSON.parse(spawnSync(process.execPath, [join(root, 'out.js')], { encoding: 'utf8' }).stdout), ['a', 'b', 'a', 'a'])
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
    const r = spawnSync(process.execPath, [BIN, '--platform=ios', '--babel', '--profile', '--output=out.js', 'index.js'], { cwd: root, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    // In the three files with a string of #lib, its pre and post hooks and its traversal on enter.
    assert.deepEqual(/^ +\d+ +[\d.]+ +(\d+) +(\d+) {2}module-resolver$/mu.exec(r.stderr)?.slice(1).map(Number), [3, 3 * 2 + 3])
  })

  it('keeps it where a string an alias matches is spelled across lines, or matched by a RegExp of a backreference', () => {
    const build = (alias, entry) => {
      writeFileSync(join(root, 'babel.config.js'), `module.exports = { plugins: [['module-resolver', ${JSON.stringify({ alias })}]] }\n`)
      const r = spawnSync(process.execPath, [BIN, '--platform=ios', '--babel', '--output=out.js', entry], { cwd: root, encoding: 'utf8' })
      assert.equal(r.status, 0, r.stderr)
      return JSON.parse(spawnSync(process.execPath, [join(root, 'out.js')], { encoding: 'utf8' }).stdout)
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
      const r = spawnSync(process.execPath, [BIN, '--platform=ios', '--babel', '--output=out.js', entry], { cwd: root, encoding: 'utf8' })
      assert.equal(r.status, 0, r.stderr)
      return JSON.parse(spawnSync(process.execPath, [join(root, 'out.js')], { encoding: 'utf8' }).stdout)
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

  it('keeps it where it may rewrite what names none: with a root', () => {
    assert.equal(ran({ alias: { '#lib': './lib' }, root: ['./lib'] }), 5)
  })
})

describe("rn-bundle --babel, with Babel's plugins of classes, modules and block scoping", () => {
  // Each as Babel's visits nodes: of classes, `export default`, for a class's.
  const plugin = (name, visitor) => `() => ({ name: '${name}', visitor: { ${visitor} } })`
  const { root, cleanup } = writeTree({
    'babel.config.js': `module.exports = { plugins: [${plugin('transform-classes', 'ExportDefaultDeclaration() {}, Class() {}')}, ${plugin('transform-modules-commonjs', 'Program() {}')}, ${plugin('transform-block-scoping', 'Program() {}')}] }\n`,
    'index.js': "import a from './a'\nimport B from './b'\nconsole.log(JSON.stringify([a, new B().b, require('./c')]))\n",
    'a.js': "export default 'a'\n",
    'b.js': "export default class { b = 'b' }\n",
    // A script, which names `import` and `export` in strings alone.
    'c.js': "module.exports = ['import', 'export'].join() && 'c'\n",
    'node_modules/@babel/core': linked('@babel/core'),
  })
  after(cleanup)

  it('leaves each out of Babel in a file that gives it nothing to do', () => {
    const r = spawnSync(process.execPath, [BIN, '--platform=ios', '--babel', '--profile', '--output=out.js', 'index.js'], { cwd: root, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(JSON.parse(spawnSync(process.execPath, [join(root, 'out.js')], { encoding: 'utf8' }).stdout), ['a', 'b', 'c'])
    const files = (key) => Number(new RegExp(`^ +\\d+ +[\\d.]+ +(\\d+) +\\d+ {2}${key}$`, 'mu').exec(r.stderr)?.[1] ?? 0)
    // Classes, in the file with one; modules, in those with import or
    // export, and the script whose strings name them; block scoping, in the
    // file with a class and the script.
    assert.deepEqual(['transform-classes', 'transform-modules-commonjs', 'transform-block-scoping'].map(files), [1, 4, 2])
  })
})

describe('rn-bundle --babel, with no Babel config', () => {
  const { root, cleanup } = writeTree(APP)
  after(cleanup)

  it('fails', () => {
    const r = spawnSync(process.execPath, [BIN, '--platform=ios', '--babel', '--output=out.js', 'index.js'], { cwd: root, encoding: 'utf8' })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /--babel needs a babel\.config/u)
  })
})

describe('rn-bundle with the project\'s own esbuild', () => {
  const { root, cleanup } = writeTree({ ...BABEL_APP, 'node_modules/esbuild': linked('esbuild-0.25') })
  after(cleanup)

  it('builds with it, from 0.25 on', () => {
    const r = spawnSync(process.execPath, [BIN, '--platform=ios', ...OPTIONS, '--output=ios.js', 'index.js'], { cwd: root, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stderr, /\(esbuild 0\.25\.\d+\)/u)
    const out = JSON.parse(spawnSync(process.execPath, [join(root, 'ios.js')], { encoding: 'utf8' }).stdout)
    assert.deepEqual([out.where, out.greet, out.typed, out.dual], ['ios', 'hi', 'flow', 'rn'])
    assert.equal(out.assets[0].hash, md5('img/logo.png', 'img/logo@2x.png', 'img/logo@3x.png'))
  })

  it('lowers with it before Babel, from 0.25 on', () => {
    const r = spawnSync(process.execPath, [BIN, '--platform=ios', '--babel', '--output=modern.out.js', 'modern.js'], { cwd: root, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stderr, /\(esbuild 0\.25\.\d+\)/u)
    assert.deepEqual(JSON.parse(spawnSync(process.execPath, [join(root, 'modern.out.js')], { encoding: 'utf8' }).stdout), MODERN)
  })
})

describe('rn-bundle with the assetExts metro.config.js adds', () => {
  const RIVE = {
    ...APP,
    'metro.config.js': [
      "const { getDefaultConfig } = require('@react-native/metro-config')",
      'const defaultConfig = getDefaultConfig(__dirname)',
      'const config = {',
      '  resolver: {',
      "    assetExts: [...defaultConfig.resolver.assetExts, 'riv'],",
      '  },',
      '}',
      "config.resolver.assetExts.push('lottie')",
      'module.exports = config',
      '',
    ].join('\n'),
    'node_modules/@react-native/metro-config/index.js': "exports.getDefaultConfig = () => { throw new Error('never run') }\n",
    'anim.js': "import { getAssetByID } from 'react-native/Libraries/Image/AssetRegistry'\nconsole.log(JSON.stringify([require('./anim/spin.riv'), require('./anim/wave.lottie')].map(getAssetByID)))\n",
    'anim/spin.riv': 'RIVE',
    'anim/spin@2x.riv': 'RIVE@2x',
    'anim/wave.lottie': 'PK',
    'config/.keep': '',
  }
  const { root, cleanup } = writeTree(RIVE)
  after(cleanup)
  const hash = (...contents) => contents.reduce((md5sum, content) => md5sum.update(content), createHash('md5')).digest('hex')

  it('builds them as assets, read off the config, never run', () => {
    const r = spawnSync(process.execPath, [BIN, '--platform=android', '--assets-dest=res', '--output=anim.js', 'anim.js'], { cwd: root, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    const [spin, wave] = JSON.parse(spawnSync(process.execPath, [join(root, 'anim.js')], { encoding: 'utf8' }).stdout)
    assert.deepEqual(spin, { __packager_asset: true, httpServerLocation: '/assets/anim', scales: [1, 2], hash: hash('RIVE', 'RIVE@2x'), name: 'spin', type: 'riv' })
    assert.deepEqual([wave.name, wave.type, wave.hash], ['wave', 'lottie', hash('PK')])
    assert.deepEqual(listFiles(join(root, 'res')), ['raw/anim_spin.riv', 'raw/anim_wave.lottie', 'raw/keep.xml'])
  })

  it('reads them off --metro-config where given, refusing one not there', () => {
    const bundleWith = (config, entry) => spawnSync(process.execPath, [BIN, '--platform=ios', `--metro-config=${config}`, '--output=config-out.js', entry], { cwd: root, encoding: 'utf8' })
    const r = bundleWith('metro.json', 'anim.js')
    assert.equal(r.status, 1)
    assert.match(r.stderr, /no such Metro config: metro\.json/u)
    writeFileSync(join(root, 'config/other.config.js'), "module.exports = { resolver: { assetExts: ['glow'] } }\n", { flag: 'w' })
    writeFileSync(join(root, 'anim/halo.glow'), 'GLOW')
    writeFileSync(join(root, 'glow.js'), "import { getAssetByID } from 'react-native/Libraries/Image/AssetRegistry'\nconsole.log(JSON.stringify(getAssetByID(require('./anim/halo.glow')).type))\n")
    const other = bundleWith('config/other.config.js', 'glow.js')
    assert.equal(other.status, 0, other.stderr)
    assert.equal(JSON.parse(spawnSync(process.execPath, [join(root, 'config-out.js')], { encoding: 'utf8' }).stdout), 'glow')
  })

  const withoutOxc = () => spawnSync(process.execPath, ['--import', notInstalled('oxc-parser'), BIN, '--platform=ios', '--output=anim.js', 'anim.js'], { cwd: root, encoding: 'utf8' })

  it('without oxc-parser, refuses a config only a parser reads', () => {
    const r = withoutOxc()
    assert.equal(r.status, 1)
    assert.match(r.stderr, /assetExts of metro\.config\.js needs oxc-parser/u)
  })

  it('without oxc-parser, reads the spread form', () => {
    writeFileSync(join(root, 'metro.config.js'), RIVE['metro.config.js'].replace("config.resolver.assetExts.push('lottie')\n", '').replace("'riv'", "'riv', 'lottie'"))
    const r = withoutOxc()
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(JSON.parse(spawnSync(process.execPath, [join(root, 'anim.js')], { encoding: 'utf8' }).stdout).map(({ type }) => type), ['riv', 'lottie'])
  })
})

// An app of a react-native from 0.87 on (`modern`), or before, as
// @react-native/metro-config configures Metro for it, its polyfills those of
// the @react-native/js-polyfills it depends on.
const REGISTRY = 'const assets = []\nexports.registerAsset = (asset) => assets.push(asset)\nexports.getAssetByID = (id) => assets[id - 1]\n'
const POLYFILLS = 'node_modules/@react-native/metro-config/node_modules/@react-native/js-polyfills'
const reactNativeApp = (modern) => ({
  'index.js': [
    `import { getAssetByID } from '${modern ? 'react-native/asset-registry' : 'react-native/Libraries/Image/AssetRegistry'}'`,
    "const logo = require('./img/logo.png')",
    'console.log(JSON.stringify({ order: globalThis.order, logo: getAssetByID(logo).name, prefix: __METRO_GLOBAL_PREFIX__, started: typeof __BUNDLE_START_TIME__ }))',
    '',
  ].join('\n'),
  'img/logo.png': png(20, 10),
  ...(modern
    ? {
        'node_modules/react-native/package.json': { name: 'react-native', version: '0.88.1', exports: { './asset-registry': './src/asset-registry.js', './setup-env': './src/setup-env.js', './Libraries/*': './Libraries/*' } },
        'node_modules/react-native/src/asset-registry.js': REGISTRY,
        'node_modules/react-native/src/setup-env.js': "(globalThis.order ??= []).push('setup-env')\n",
        // Kept, delegating, but no longer what runs before the entry.
        'node_modules/react-native/Libraries/Core/InitializeCore.js': "require('../../src/setup-env')\n;(globalThis.order ??= []).push('InitializeCore')\n",
      }
    : {
        'node_modules/react-native/package.json': { name: 'react-native', version: '0.86.0' },
        'node_modules/react-native/Libraries/Image/AssetRegistry.js': REGISTRY,
        'node_modules/react-native/Libraries/Core/InitializeCore.js': "(globalThis.order ??= []).push('InitializeCore')\n",
      }),
  'node_modules/@react-native/metro-config/package.json': { name: '@react-native/metro-config', main: 'index.js' },
  'node_modules/@react-native/metro-config/index.js': "throw new Error('never run')\n",
  [`${POLYFILLS}/package.json`]: { name: '@react-native/js-polyfills', main: 'index.js' },
  [`${POLYFILLS}/index.js`]: "module.exports = () => [require.resolve('./console.js'), require.resolve('./error-guard.js')]\n",
  [`${POLYFILLS}/console.js`]: "'use strict'\n;(global.order ??= []).push('console')\n",
  [`${POLYFILLS}/error-guard.js`]: "/**\n * @flow strict\n */\n'use strict'\nconst name: string = 'error-guard'\n;(global.order ??= []).push(name)\n",
})
const PRELUDE = (dev) => `var __BUNDLE_START_TIME__=globalThis.nativePerformanceNow?nativePerformanceNow():Date.now(),__DEV__=${dev},process=globalThis.process||{},__METRO_GLOBAL_PREFIX__='';process.env=process.env||{};process.env.NODE_ENV=process.env.NODE_ENV||"${dev ? 'development' : 'production'}";`

describe('rn-bundle, as @react-native/metro-config configures Metro', () => {
  const modern = writeTree(reactNativeApp(true))
  const older = writeTree(reactNativeApp(false))
  const babel = writeTree({
    ...reactNativeApp(true),
    'babel.config.js': "module.exports = { plugins: ['@babel/plugin-transform-flow-strip-types'] }\n",
    'node_modules/@babel/core': linked('@babel/core'),
    'node_modules/@babel/plugin-transform-flow-strip-types': linked('@babel/plugin-transform-flow-strip-types'),
  })
  after(() => {
    for (const tree of [modern, older, babel]) tree.cleanup()
  })
  const build = (root, args = [], node = []) => {
    const r = spawnSync(process.execPath, [...node, BIN, '--platform=ios', ...args, '--output=out.js', 'index.js'], { cwd: root, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    return { code: readFileSync(join(root, 'out.js'), 'utf8'), out: JSON.parse(spawnSync(process.execPath, [join(root, 'out.js')], { encoding: 'utf8' }).stdout) }
  }

  it("from react-native 0.87 on: Metro's prelude, the polyfills, react-native/setup-env, then the entry; assets registered with react-native/asset-registry", () => {
    const { code, out } = build(modern.root)
    assert.ok(code.startsWith(`${PRELUDE(false)}\n`))
    assert.deepEqual(out, { order: ['console', 'error-guard', 'setup-env'], logo: 'logo', prefix: '', started: 'number' })
    assert.ok(build(modern.root, ['--dev']).code.startsWith(`${PRELUDE(true)}\n`))
    assert.ok(build(modern.root, ['--define=__DEV__=false', '--dev']).code.startsWith('var __BUNDLE_START_TIME__=globalThis.nativePerformanceNow?nativePerformanceNow():Date.now(),__DEV__=false,'))
  })

  it("names the main module, the polyfills and the assets by their paths in the project, as esbuild names files: the bundle doesn't depend on where the project is", () => {
    const { code } = build(modern.root)
    assert.ok(!code.includes(modern.root), 'no absolute path')
    for (const namespace of ['metro-main', 'metro-polyfill', 'metro-asset']) assert.match(code, new RegExp(`// ${namespace}:[\\w@]`, 'u'))
  })

  it('before react-native 0.87: InitializeCore, and Libraries/Image/AssetRegistry', () => {
    assert.deepEqual(build(older.root).out, { order: ['console', 'error-guard', 'InitializeCore'], logo: 'logo', prefix: '', started: 'number' })
  })

  it('makes the polyfills as it makes any file: through the Babel config, minified', () => {
    assert.deepEqual(build(babel.root, ['--babel', '--minify'], ['--import', notInstalled('flow-remove-types')]).out.order, ['console', 'error-guard', 'setup-env'])
  })
})

describe('rn-bundle --sourcemap-output', () => {
  const plain = writeTree(reactNativeApp(true))
  const babel = writeTree({
    ...reactNativeApp(true),
    'babel.config.js': "module.exports = { plugins: ['@babel/plugin-transform-flow-strip-types'] }\n",
    'node_modules/@babel/core': linked('@babel/core'),
    'node_modules/@babel/plugin-transform-flow-strip-types': linked('@babel/plugin-transform-flow-strip-types'),
  })
  after(() => {
    plain.cleanup()
    babel.cleanup()
  })
  const build = (root, args = []) => {
    const r = spawnSync(process.execPath, [BIN, '--platform=ios', '--sourcemap-output=maps/main.jsbundle.map', ...args, '--output=build/main.jsbundle', 'index.js'], { cwd: root, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    return { code: readFileSync(join(root, 'build/main.jsbundle'), 'utf8'), map: JSON.parse(readFileSync(join(root, 'maps/main.jsbundle.map'), 'utf8')) }
  }
  // Where the first `text` of the bundle is from: [source, line, column], line from 1.
  const origin = ({ code, map }, text) => {
    const lines = code.split('\n')
    const line = lines.findIndex((each) => each.includes(text))
    const { originalSource, originalLine, originalColumn } = new SourceMap(map).findEntry(line, lines[line].indexOf(text))
    return [originalSource, originalLine + 1, originalColumn]
  }

  it("writes the bundle's map there, as Metro does: each source absolute, those in node_modules on the ignore list; the bundle's sourceMappingURL its name", () => {
    const { root } = plain
    const bundle = build(root)
    assert.ok(bundle.code.endsWith('\n//# sourceMappingURL=main.jsbundle.map\n'))
    assert.deepEqual(listFiles(join(root, 'build')), ['main.jsbundle'])
    const { map } = bundle
    assert.equal(map.version, 3)
    assert.deepEqual(map.sources.filter((source) => !source.startsWith(`${root}${sep}`)), ['metro-main:index.js'])
    for (const file of ['index.js', `${POLYFILLS}/console.js`, 'node_modules/react-native/src/setup-env.js', 'img/logo.png']) assert.ok(map.sources.includes(join(root, file)), file)
    assert.deepEqual(map.x_google_ignoreList, map.sources.flatMap((source, i) => (source.includes(`${sep}node_modules${sep}`) ? [i] : [])))
    assert.equal(map.sourcesContent[map.sources.indexOf(join(root, 'index.js'))], reactNativeApp(true)['index.js'])
    assert.deepEqual(origin(bundle, 'order: globalThis.order'), [join(root, 'index.js'), 3, 29])
    assert.deepEqual(spawnSync(process.execPath, [join(root, 'build/main.jsbundle')], { encoding: 'utf8' }).stdout, `${JSON.stringify({ order: ['console', 'error-guard', 'setup-env'], logo: 'logo', prefix: '', started: 'number' })}\n`)
  })

  it('makes each source from --sourcemap-sources-root, and with --sourcemap-use-absolute-path the URL the map\'s path', () => {
    const { root } = plain
    const { code, map } = build(root, ['--sourcemap-sources-root=.', '--sourcemap-use-absolute-path'])
    assert.ok(code.endsWith(`\n//# sourceMappingURL=${join(root, 'maps/main.jsbundle.map')}\n`))
    assert.ok(map.sources.includes('index.js') && map.sources.includes(join(POLYFILLS, 'console.js')), String(map.sources))
    assert.ok(map.sources.includes('metro-main:index.js'))
  })

  it('maps through Babel, a polyfill too, and esbuild\'s minifying', () => {
    const { root } = babel
    const bundle = build(root, ['--babel', '--minify'])
    assert.deepEqual(origin(bundle, '"error-guard"'), [join(root, POLYFILLS, 'error-guard.js'), 5, 21])
    assert.deepEqual(origin(bundle, 'JSON.stringify'), [join(root, 'index.js'), 3, 12])
  })
})

describe('rn-bundle --babel, with Flow that is code', () => {
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
    const r = spawnSync(process.execPath, [BIN, '--platform=ios', '--babel', '--output=out.js', 'index.js'], { cwd: root, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(JSON.parse(spawnSync(process.execPath, [join(root, 'out.js')], { encoding: 'utf8' }).stdout), ['hello world', 'typed'])
  })
})
