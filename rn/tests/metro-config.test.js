import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { describe, it } from 'node:test'

import { metroAssetExts, scanMetroAssetExts } from '../metro-config.js'

const { parseSync } = createRequire(import.meta.url)('oxc-parser')
const program = (source) => parseSync('metro.config.js', source, { sourceType: 'unambiguous' }).program

// [label, metro.config.js, what the AST reader reads, what the scan reads (null: a parser is needed)]
const CONFIGS = [
  ['a spread of the defaults and a string', [
    "const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config')",
    'const defaultConfig = getDefaultConfig(__dirname)',
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
