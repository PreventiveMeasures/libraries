import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { describe, it } from 'node:test'

import { metroAssetExts, scanMetroAssetExts } from '../metro-config.js'

const { parseSync } = createRequire(import.meta.url)('oxc-parser')
const program = (source) => parseSync('metro.config.js', source, { sourceType: 'unambiguous' }).program

// [label, metro.config.js, what both read, what the AST reader alone reads]
const CONFIGS = [
  ['a spread of the defaults and a string', [
    "const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config')",
    'const defaultConfig = getDefaultConfig(__dirname)',
    'const config = {',
    '  resolver: {',
    "    assetExts: [...defaultConfig.resolver.assetExts, 'riv'],",
    "    sourceExts: [...defaultConfig.resolver.sourceExts, 'svg'],",
    '    blockList: /node_modules\\/.*\\/"fixtures"\\/.*/,',
    '  },',
    '}',
    'module.exports = mergeConfig(defaultConfig, config)',
  ], ['riv']],
  ['pushed and unshifted', ["config.resolver.assetExts.push('lottie', \"bin\")", 'config.resolver.assetExts?.unshift(`glb`)'], ['lottie', 'bin', 'glb']],
  ['assigned, concatenated', ["config.resolver.assetExts = config.resolver.assetExts.concat(['c', 'd'], 'e')"], ['c', 'd', 'e']],
  ['in a comment, a regex or a template', ["// assetExts: ['no']", "const re = /assetExts: ['no']/", 'const t = `${x}`', "const s = 'assetExts: [\\'no\\']'", "module.exports = { assetExts: ['yes'] }"], ['yes']],
  ['through a variable and a branch', ["const extra = ['riv']", 'module.exports = { resolver: { assetExts: [...base, ...(web ? [] : extra)] } }'], [], ['riv']],
  ['filtered, then concatenated', ["const c = { resolver: { assetExts: base.filter((ext) => ext !== 'svg').concat(['riv']) } }"], [], ['riv']],
]

describe('metroAssetExts and scanMetroAssetExts', () => {
  for (const [label, lines, both, ast = []] of CONFIGS) {
    it(`read ${label}`, () => {
      const source = lines.join('\n')
      assert.deepEqual(metroAssetExts(program(source)).toSorted(), [...both, ...ast].toSorted())
      assert.deepEqual(scanMetroAssetExts(source).toSorted(), both.toSorted())
    })
  }
})
