import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { metroAssetExts, readMetroAssetExts, scanMetroAssetExts } from '../metro-config.js'
import { defaults } from '../src/defaults.js'
import { writeTree } from './fixtures.js'

const { parseSync } = createRequire(import.meta.url)('oxc-parser')
const program = (source) => parseSync('metro.config.js', source, { sourceType: 'unambiguous' }).program

// [label, metro.config.js, what the AST reader reads, what the scan reads (null: a parser is needed)]
const CONFIGS = [
  ['a spread of the defaults and a string', [
    "const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config')",
    'const defaultConfig = getDefaultConfig(__dirname)',
    '/**',
    ' * Metro configuration',
    ' * https://reactnative.dev/docs/metro',
    ' *',
    " * @type {import('@react-native/metro-config').MetroConfig}",
    ' */',
    'const config = {',
    '  resolver: {',
    "    assetExts: [...defaultConfig.resolver.assetExts, 'riv'],",
    "    sourceExts: [...defaultConfig.resolver.sourceExts, 'svg'],",
    '  },',
    '}',
    'module.exports = mergeConfig(defaultConfig, config)',
  ], ['riv'], ['riv']],
  ['no assetExts', ["module.exports = { resolver: { sourceExts: ['ts'] } }"], [], []],
  ['several strings, a trailing comma', ["module.exports = { resolver: { assetExts: [ ...defaults.assetExts, 'riv', \"lottie\", ] } }"], ['riv', 'lottie'], ['riv', 'lottie']],
  ['pushed', ["config.resolver.assetExts.push('lottie')"], ['lottie'], null],
  ['a quoted key', ["module.exports = { resolver: { 'assetExts': [...defaults.assetExts, 'riv'] } }"], ['riv'], null],
  ['commented out', ["// assetExts: [...defaults.assetExts, 'svg'],", "module.exports = { assetExts: [...defaults.assetExts, 'riv'] }"], ['riv'], null],
  ['in a block comment', ['/*', "  assetExts: [...defaults.assetExts, 'svg'],", '*/', 'module.exports = {}'], [], null],
  ['in a template', ['const doc = `', "  assetExts: [...defaults.assetExts, 'svg'],", '`', 'module.exports = {}'], [], null],
  ['in a string', ['const doc = "assetExts: [...defaults.assetExts, \'svg\']"', 'module.exports = {}'], [], null],
  ['also in a comment', ['// assetExts: also lottie, below', "module.exports = { assetExts: [...defaults.assetExts, 'riv'] }"], ['riv'], null],
  ['through a variable and a branch', ["const extra = ['riv']", 'module.exports = { resolver: { assetExts: [...base, ...(web ? [] : extra)] } }'], ['riv'], null],
  ['filtered, then concatenated', ["const c = { resolver: { assetExts: base.filter((ext) => ext !== 'svg').concat(['riv']) } }"], ['riv'], null],
]

describe('metroAssetExts and scanMetroAssetExts', () => {
  for (const [label, lines, ast, scan] of CONFIGS) {
    it(`read ${label}`, () => {
      const source = lines.join('\n')
      assert.deepEqual(metroAssetExts(program(source)), ast)
      assert.deepEqual(scanMetroAssetExts(source), scan)
    })
  }
})

describe('readMetroAssetExts', () => {
  const { root, cleanup } = writeTree({
    'package.json': { name: 'app' },
    'metro.config.js': [
      "const { getDefaultConfig } = require('@react-native/metro-config')",
      'const defaultConfig = getDefaultConfig(__dirname)',
      "const config = { resolver: { assetExts: [...defaultConfig.resolver.assetExts, 'riv'] } }",
      "config.resolver.assetExts.push('lottie')",
      'module.exports = config',
      '',
    ].join('\n'),
    'spread.config.js': "module.exports = { resolver: { assetExts: [...defaults.assetExts, 'glow'] } }\n",
    // Which a read never runs.
    'node_modules/@react-native/metro-config/index.js': "throw new Error('never run')\n",
  })
  const bare = writeTree({ 'package.json': { name: 'bare' } })
  after(() => {
    cleanup()
    bare.cleanup()
  })

  it("reads them off the project's metro.config.js, never running it, after Metro's", () => {
    assert.deepEqual(readMetroAssetExts(root), [...defaults.assetExts, 'riv', 'lottie'])
  })

  it("takes rn.config.json's: the assetExts it adds after the config's, the config of its metroConfig, of none where false, `file` over it", () => {
    const { root: own, cleanup: done } = writeTree({
      'package.json': { name: 'app' },
      'metro.config.js': "module.exports = { resolver: { assetExts: [...defaults.assetExts, 'riv'] } }\n",
      'spread.config.js': "module.exports = { resolver: { assetExts: [...defaults.assetExts, 'glow'] } }\n",
    })
    const withConfig = (config, options) => {
      writeFileSync(join(own, 'rn.config.json'), JSON.stringify(config))
      return readMetroAssetExts(own, { oxc: null, ...options })
    }
    try {
      assert.deepEqual(withConfig({ assetExts: ['lottie', 'riv', 'lottie'] }), [...defaults.assetExts, 'riv', 'lottie'])
      assert.deepEqual(withConfig({ metroConfig: false, assetExts: ['lottie'] }), [...defaults.assetExts, 'lottie'])
      assert.deepEqual(withConfig({ metroConfig: 'spread.config.js' }), [...defaults.assetExts, 'glow'])
      assert.deepEqual(withConfig({ metroConfig: false }, { file: 'metro.config.js' }), [...defaults.assetExts, 'riv'])
      assert.throws(() => withConfig({ assetExts: ['.lottie'] }), { message: /^rn\.config\.json: assetExts is a list of extensions/u })
    } finally {
      done()
    }
  })

  it('reads `file` where given, throwing where it is not there', () => {
    assert.deepEqual(readMetroAssetExts(root, { file: 'spread.config.js' }), [...defaults.assetExts, 'glow'])
    assert.throws(() => readMetroAssetExts(root, { file: 'metro.json' }), /no such Metro config: metro\.json/u)
  })

  it("without oxc-parser, reads the spread form, and throws on a config only a parser reads", () => {
    assert.deepEqual(readMetroAssetExts(root, { file: 'spread.config.js', oxc: null }), [...defaults.assetExts, 'glow'])
    assert.throws(() => readMetroAssetExts(root, { oxc: null }), /reading the assetExts of metro\.config\.js needs oxc-parser/u)
  })

  it("is Metro's defaults where the project has no metro.config.js", () => {
    assert.deepEqual(readMetroAssetExts(bare.root), [...defaults.assetExts])
  })
})
