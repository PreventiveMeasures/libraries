import { createHash } from 'node:crypto'
import { readdirSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { rnBundle } from '../src/rn-bundle.js'
import { png } from './fixtures.js'

// The apps and helpers of rn-bundle's tests, which their files share.
export const esbuild = createRequire(import.meta.url)('esbuild')
export const BIN = fileURLToPath(new URL('../bin/rn-bundle.js', import.meta.url))

// The modules this process has loaded: of a run's project (its configs, its
// plugins), and @babel/core's, which keeps each config it has loaded.
const modules = createRequire(import.meta.url).cache
const BABEL_CORE = /[\\/]@babel[\\/]core[\\/]/u

// rn-bundle of `args`, in `cwd`, as its bin runs it (rnBundle()), but in
// this process, not one of its own each, which loads Node, Babel and
// esbuild anew: those modules of the project's and @babel/core's loaded
// anew, as a process would, a test having changed a file of them; in `env`
// where given, NODE_ENV as rn-bundle sets it; then cwd and the environment
// as they were. -> { status, stderr }, as spawnSync's. A test of what Node
// itself is given (--import) spawns the bin still.
export async function runBundle(args, { cwd, env = null }) {
  for (const path of Object.keys(modules)) if (path.startsWith(`${cwd}${sep}`) || BABEL_CORE.test(path)) delete modules[path]
  const saved = { ...process.env }
  if (env !== null) {
    for (const name of Object.keys(process.env)) if (!Object.hasOwn(env, name)) delete process.env[name]
    Object.assign(process.env, env)
  }
  const was = process.cwd()
  process.chdir(cwd)
  let stderr = ''
  const write = (text) => {
    stderr += text
    return true
  }
  try {
    return { status: await rnBundle(args, { cwd, stderr: { write } }), stderr }
  } finally {
    process.chdir(was)
    for (const name of Object.keys(process.env)) if (!Object.hasOwn(saved, name)) delete process.env[name]
    Object.assign(process.env, saved)
  }
}

export const APP = {
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
    "const configEnv = typeof __CONFIG_ENV__ === 'undefined' ? null : __CONFIG_ENV__",
    'console.log(JSON.stringify({ where, greet: greet(), typed, generic, dual, optional, platform, babelEnv, nodeEnv, configEnv, dev: __DEV__, env: process.env.NODE_ENV, ids: [logo, icon, font], assets: [logo, icon, font].map(getAssetByID) }))',
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
export const notInstalled = (name) => `data:text/javascript,${encodeURIComponent([
  "import Module from 'node:module'",
  'const resolve = Module._resolveFilename',
  `Module._resolveFilename = function (request, ...rest) { if (request === ${JSON.stringify(name)}) throw Object.assign(new Error(request), { code: 'MODULE_NOT_FOUND' }); return resolve.call(this, request, ...rest) }`,
].join('\n'))}`
export const OPTIONS = ['--babel-aliases=aliases.json', '--define=__DEV__=false', '--define=process.env.NODE_ENV="production"']
export const md5 = (...files) => {
  const hash = createHash('md5')
  for (const file of files) hash.update(APP[file])
  return hash.digest('hex')
}
export const listFiles = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'))
  .toSorted()

// The project's own Babel, as an app installs it: the workspace's copies linked in.
export const linked = (name) => ({ link: realpathSync(fileURLToPath(new URL(`../node_modules/${name}`, import.meta.url))) })
// __SYNTAX__ is the class syntax and decorators a file still has when Babel
// gets it; the decorators are then taken off.
export const babelConfig = (plugins) => [
  'module.exports = (api) => {',
  '  const inline = (name, value) => ({ types: t }) => ({ visitor: { Identifier(path) { if (path.node.name === name) path.replaceWith(t.stringLiteral(value)) } } })',
  "  const platformOf = inline('__PLATFORM__', api.caller((caller) => caller && caller.platform))",
  "  const callerOf = inline('__CALLER__', api.caller((caller) => caller && JSON.stringify([caller.inlinePlatform, caller.unstable_transformProfile])))",
  '  // NODE_ENV and BABEL_ENV as the config reads them, as it loads.',
  "  const configEnv = [process.env.NODE_ENV, process.env.BABEL_ENV].join(' ')",
  '  // NODE_ENV as a plugin reads it, as it transforms.',
  "  const nodeEnvOf = ({ types: t }) => ({ visitor: { Identifier(path) { if (path.node.name === '__NODE_ENV__') path.replaceWith(t.stringLiteral(String(process.env.NODE_ENV))) } } })",
  '  const syntaxOf = ({ types: t }) => ({',
  '    pre() { this.seen = new Set() },',
  '    visitor: {',
  "      'ClassProperty|ClassPrivateProperty|ClassPrivateMethod|StaticBlock|Decorator'(path) { this.seen.add(path.type); if (path.isDecorator()) path.remove() },",
  "      Identifier(path) { if (path.node.name === '__SYNTAX__') path.replaceWith(t.valueToNode([...this.seen].toSorted())) },",
  '    },',
  '  })',
  `  return { parserOpts: { plugins: ['decorators-legacy'] }, plugins: [${plugins.map((plugin) => JSON.stringify(plugin)).join(', ')}, platformOf, callerOf, inline('__BABEL_ENV__', api.env()), inline('__CONFIG_ENV__', configEnv), nodeEnvOf, syntaxOf] }`,
  '}',
  '',
].join('\n')
export const BABEL_APP = {
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

export const MODERN = {
  counter: [4, 1, true, true, false],
  generic: 'generic',
  card: ['base', 'card', { type: 'Text', renders: 1, children: ['hi'] }, 2],
  syntax: { counter: [], flow: ['ClassProperty'], ready: [], decorated: ['ClassProperty', 'Decorator'], card: [], note: ['ClassProperty', 'Decorator'] },
}
// Whether esbuild finds nothing in a bundle left to lower.
export const lowered = (code) => esbuild.transformSync(code, { supported: { 'class-field': false, 'class-private-field': false, 'class-private-method': false, 'class-static-blocks': false, 'class-static-field': false, using: false } }).code === esbuild.transformSync(code).code

// As Metro's transformer finds a project's Babel config: a .babelrc it
// extends, else @react-native/babel-preset.
export const PLATFORM_PLUGIN = 'module.exports = ({ types: t }) => ({ visitor: { Identifier(path, state) { if (path.node.name === "__PLATFORM__") path.replaceWith(t.stringLiteral(state.opts.tag ?? path.hub.file.opts.caller.platform)) } } })\n'

export const templateConfig = (custom) => `const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config')\nconst defaultConfig = getDefaultConfig(__dirname)\nmodule.exports = mergeConfig(defaultConfig, ${custom})\n`

// An app of a react-native from 0.87 on (`modern`), or before, as
// @react-native/metro-config configures Metro for it, its polyfills those of
// the @react-native/js-polyfills it depends on.
export const REGISTRY = 'const assets = []\nexports.registerAsset = (asset) => assets.push(asset)\nexports.getAssetByID = (id) => assets[id - 1]\n'
export const POLYFILLS = 'node_modules/@react-native/metro-config/node_modules/@react-native/js-polyfills'
export const reactNativeApp = (modern) => ({
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
export const PRELUDE = (dev) => `var __BUNDLE_START_TIME__=globalThis.nativePerformanceNow?nativePerformanceNow():Date.now(),__DEV__=${dev},process=globalThis.process||{},__METRO_GLOBAL_PREFIX__='';process.env=process.env||{};process.env.NODE_ENV=process.env.NODE_ENV||"${dev ? 'development' : 'production'}";`
