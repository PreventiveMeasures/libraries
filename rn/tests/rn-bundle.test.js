import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { png, writeTree } from './fixtures.js'

const BIN = fileURLToPath(new URL('../bin/rn-bundle.js', import.meta.url))

const APP = {
  'index.js': [
    '/** @jsx h */',
    "import { where } from './lib/where'",
    "import { greet } from '#lib/greet'",
    "import { typed } from './lib/typed'",
    "import dual from 'dual'",
    "import { optional } from './lib/optional'",
    "import font from './fonts/Inter.ttf'",
    "import { getAssetByID } from 'react-native/Libraries/Image/AssetRegistry'",
    'const h = (type, props) => props.source',
    "const Image = 'Image'",
    "const logo = <Image source={require('./img/logo.png')} />",
    "const icon = require('./img/icon.png')",
    "const platform = typeof __PLATFORM__ === 'undefined' ? null : __PLATFORM__",
    'console.log(JSON.stringify({ where, greet: greet(), typed, dual, optional, platform, dev: __DEV__, env: process.env.NODE_ENV, ids: [logo, icon, font], assets: [logo, icon, font].map(getAssetByID) }))',
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

const OPTIONS = ['--jsx', '--flow', '--babel-aliases=aliases.json', '--define=__DEV__=false', '--define=process.env.NODE_ENV="production"']
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

  it('bundles for iOS: its files, the aliases, Flow, the defines, and each asset as Metro builds it', () => {
    const r = run(['--platform=ios', ...OPTIONS, '--assets-dest=ios-assets', '--output=ios.js', 'index.js'])
    assert.equal(r.status, 0, r.stderr)
    const out = output('ios.js')
    assert.deepEqual([out.where, out.greet, out.typed, out.dual, out.optional, out.dev, out.env], ['ios', 'hi', 'flow', 'rn', 'none', false, 'production'])
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
    const noAliases = run(['--platform=ios', '--jsx', '--flow', '--output=out.js', 'index.js'])
    assert.equal(noAliases.status, 1)
    assert.match(noAliases.stderr, /Could not resolve "#lib\/greet"[\s\S]*index\.js/u)
    const divergent = run(['--platform=ios', '--output=out.js', 'divergent/index.js'])
    assert.equal(divergent.status, 1)
    assert.match(divergent.stderr, /esbuild resolved node_modules\/dep\/index\.js where Metro resolves nothing/u)
    const noFlow = run(['--platform=ios', '--jsx', '--babel-aliases=aliases.json', '--output=out.js', 'index.js'])
    assert.equal(noFlow.status, 1)
    assert.match(noFlow.stderr, /typed\.js/u)
    const enumFlow = run(['--platform=ios', '--flow', '--output=out.js', 'enum.js'])
    assert.equal(enumFlow.status, 1)
    assert.match(enumFlow.stderr, /Flow syntax flow-remove-types doesn't strip: Unexpected "enum"[\s\S]*lib\/mode\.js:2:7/u)
    const broken = run(['--platform=ios', '--flow', '--output=out.js', 'broken.js'])
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
})

// The project's own Babel, as an app installs it: the workspace's copies linked in.
const linked = (name) => ({ link: realpathSync(fileURLToPath(new URL(`../node_modules/${name}`, import.meta.url))) })
const BABEL_APP = {
  ...APP,
  'babel.config.js': [
    'module.exports = (api) => {',
    '  const platform = api.caller((caller) => caller && caller.platform)',
    '  const platformOf = ({ types: t }) => ({ visitor: { Identifier(path) { if (path.node.name === \'__PLATFORM__\') path.replaceWith(t.stringLiteral(platform)) } } })',
    "  return { plugins: [['module-resolver', { alias: { '#lib': './lib' } }], '@babel/plugin-transform-flow-strip-types', '@babel/plugin-transform-react-jsx', platformOf] }",
    '}',
    '',
  ].join('\n'),
  'node_modules/@babel/core': linked('@babel/core'),
  'node_modules/@babel/plugin-transform-flow-strip-types': linked('@babel/plugin-transform-flow-strip-types'),
  'node_modules/@babel/plugin-transform-react-jsx': linked('@babel/plugin-transform-react-jsx'),
  'node_modules/babel-plugin-module-resolver': linked('babel-plugin-module-resolver'),
}

describe('rn-bundle --babel', () => {
  const { root, cleanup } = writeTree(BABEL_APP)
  after(cleanup)
  const run = (args) => spawnSync(process.execPath, [BIN, ...args], { cwd: root, encoding: 'utf8' })

  it('builds each file as the project\'s Babel config makes it, for the platform', () => {
    const r = run(['--platform=ios', '--babel', '--define=__DEV__=false', '--define=process.env.NODE_ENV="production"', '--output=ios.js', 'index.js'])
    assert.equal(r.status, 0, r.stderr)
    const out = JSON.parse(spawnSync(process.execPath, [join(root, 'ios.js')], { encoding: 'utf8' }).stdout)
    assert.deepEqual([out.where, out.greet, out.typed, out.dual, out.optional, out.platform, out.dev, out.env], ['ios', 'hi', 'flow', 'rn', 'none', 'ios', false, 'production'])
    assert.equal(out.assets[0].hash, md5('img/logo.png', 'img/logo@2x.png', 'img/logo@3x.png'))
  })

  it('takes neither --flow nor --babel-aliases with it', () => {
    for (const other of ['--flow', '--babel-aliases=aliases.json']) {
      const r = run(['--platform=ios', '--babel', other, '--output=out.js', 'index.js'])
      assert.equal(r.status, 1)
      assert.match(r.stderr, /pass one/u)
    }
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
  const { root, cleanup } = writeTree({ ...APP, 'node_modules/esbuild': linked('esbuild-0.25') })
  after(cleanup)

  it('builds with it, from 0.25 on', () => {
    const r = spawnSync(process.execPath, [BIN, '--platform=ios', ...OPTIONS, '--output=ios.js', 'index.js'], { cwd: root, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stderr, /\(esbuild 0\.25\.\d+\)/u)
    const out = JSON.parse(spawnSync(process.execPath, [join(root, 'ios.js')], { encoding: 'utf8' }).stdout)
    assert.deepEqual([out.where, out.greet, out.typed, out.dual], ['ios', 'hi', 'flow', 'rn'])
    assert.equal(out.assets[0].hash, md5('img/logo.png', 'img/logo@2x.png', 'img/logo@3x.png'))
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

  // As if oxc-parser were installed nowhere.
  const NO_OXC = `data:text/javascript,${encodeURIComponent([
    "import Module from 'node:module'",
    'const resolve = Module._resolveFilename',
    "Module._resolveFilename = function (request, ...rest) { if (request === 'oxc-parser') throw Object.assign(new Error(request), { code: 'MODULE_NOT_FOUND' }); return resolve.call(this, request, ...rest) }",
  ].join('\n'))}`
  const withoutOxc = () => spawnSync(process.execPath, ['--import', NO_OXC, BIN, '--platform=ios', '--output=anim.js', 'anim.js'], { cwd: root, encoding: 'utf8' })

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
