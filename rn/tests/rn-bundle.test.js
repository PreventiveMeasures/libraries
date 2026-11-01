import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
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
    'console.log(JSON.stringify({ where, greet: greet(), typed, generic, dual, optional, platform, babelEnv, dev: __DEV__, env: process.env.NODE_ENV, ids: [logo, icon, font], assets: [logo, icon, font].map(getAssetByID) }))',
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
const OPTIONS = ['--jsx', '--babel-aliases=aliases.json', '--define=__DEV__=false', '--define=process.env.NODE_ENV="production"']
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

  it('fails on what it cannot resolve, parse or strip', () => {
    const noAliases = run(['--platform=ios', '--jsx', '--output=out.js', 'index.js'])
    assert.equal(noAliases.status, 1)
    assert.match(noAliases.stderr, /Could not resolve "#lib\/greet"[\s\S]*index\.js/u)
    const divergent = run(['--platform=ios', '--output=out.js', 'divergent/index.js'])
    assert.equal(divergent.status, 1)
    assert.match(divergent.stderr, /esbuild resolved node_modules\/dep\/index\.js where Metro resolves nothing/u)
    const noFlow = spawnSync(process.execPath, ['--import', notInstalled('flow-remove-types'), BIN, '--platform=ios', '--jsx', '--babel-aliases=aliases.json', '--output=out.js', 'index.js'], { cwd: root, encoding: 'utf8' })
    assert.equal(noFlow.status, 1)
    assert.match(noFlow.stderr, /Can't strip Flow types from lib\/typed\.js: it needs flow-remove-types/u)
    const enumFlow = run(['--platform=ios', '--output=out.js', 'enum.js'])
    assert.equal(enumFlow.status, 1)
    assert.match(enumFlow.stderr, /Flow syntax flow-remove-types doesn't strip: Unexpected "enum"[\s\S]*lib\/mode\.js:2:7/u)
    const broken = run(['--platform=ios', '--output=out.js', 'broken.js'])
    assert.equal(broken.status, 1)
    assert.match(broken.stderr, /Can't strip Flow types from lib\/broken\.js: Unexpected token/u)
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
      const r = run(['--platform=ios', '--jsx', '--babel-aliases=aliases.json', ...args, '--output=env.js', 'index.js'])
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
  '  const syntaxOf = ({ types: t }) => ({',
  '    pre() { this.seen = new Set() },',
  '    visitor: {',
  "      'ClassProperty|ClassPrivateProperty|ClassPrivateMethod|StaticBlock|Decorator'(path) { this.seen.add(path.type); if (path.isDecorator()) path.remove() },",
  "      Identifier(path) { if (path.node.name === '__SYNTAX__') path.replaceWith(t.valueToNode([...this.seen].toSorted())) },",
  '    },',
  '  })',
  `  return { parserOpts: { plugins: ['decorators-legacy'] }, plugins: [${plugins.map((plugin) => JSON.stringify(plugin)).join(', ')}, platformOf, inline('__BABEL_ENV__', api.env()), syntaxOf] }`,
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
      "import { view } from './view'",
      "import { pragma } from './pragma'",
      "import { Child, fields } from './fields'",
      "import Button from './ButtonNativeComponent'",
      'const effects: Effect[] = (globalThis as any).effects ?? []',
      'const button = { name: (Button as any).name, color: (Button as any).config.validAttributes.color }',
      'console.log(JSON.stringify({ effects, view: view(), pragma: pragma(), field: new Child().value ?? null, fields, button }))',
      '',
    ].join('\n'),
    // Has a side effect; imported only for its type.
    'effect.ts': ";((globalThis as any).effects ??= []).push('effect')\nexport type Effect = string\n",
    // React, which only JSX uses, for the classic runtime.
    'view.tsx': "import React from 'react'\nexport const view = () => <b>view</b>\n",
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
    'node_modules/react/index.js': 'exports.createElement = (type, props, ...children) => ({ type, children })\n',
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
  const build = (options) => {
    writeFileSync(join(root, 'babel.config.js'), config(options))
    const r = spawnSync(process.execPath, [BIN, '--platform=ios', '--babel', '--output=main.out.js', 'main.ts'], { cwd: root, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    return JSON.parse(spawnSync(process.execPath, [join(root, 'main.out.js')], { encoding: 'utf8' }).stdout)
  }

  it('makes TS JS by esbuild as the plugin would by default; a file with a JSX pragma or a native component spec, Babel takes as it is', () => {
    assert.deepEqual(build({}), { effects: [], view: { type: 'b', children: ['view'] }, pragma: { type: 'i', children: ['pragma'] }, field: 'base', fields: 0, button: { name: 'Button', color: true } })
  })

  it('leaves TS to Babel, where the plugin keeps imports or fields otherwise', () => {
    assert.deepEqual(build({ onlyRemoveTypeImports: true }).effects, ['effect'])
    const { field, fields } = build({ allowDeclareFields: true })
    assert.deepEqual([field, fields], [null, 2])
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
