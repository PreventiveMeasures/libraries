import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { readMetroAssetExts } from '../asset-exts.js'
import { defaults } from '../src/defaults.js'
import { writeTree } from './fixtures.js'

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

  it("takes rn.config.json's: the assetExts it adds to Metro's defaults, reading no Metro config then; else the config of its metroConfig, of none where false, `file` over it", () => {
    const { root: own, cleanup: done } = writeTree({
      'package.json': { name: 'app' },
      'metro.config.js': "module.exports = { resolver: { assetExts: [...defaults.assetExts, 'riv'] } }\n",
      'spread.config.js': "module.exports = { resolver: { assetExts: [...defaults.assetExts, 'glow'] } }\n",
      // Which only a parser reads.
      'parsed.config.js': "const exts = ['vrm']\nmodule.exports = { resolver: { assetExts } }\n",
    })
    const withConfig = (config, options) => {
      writeFileSync(join(own, 'rn.config.json'), JSON.stringify(config))
      return readMetroAssetExts(own, { oxc: null, ...options })
    }
    try {
      // Of its assetExts, no Metro config read: not one a parser alone reads, nor one not there.
      for (const options of [{}, { file: 'parsed.config.js' }, { file: 'none.config.js' }]) assert.deepEqual(withConfig({ assetExts: ['lottie', 'png', 'lottie'] }, options), [...defaults.assetExts, 'lottie'])
      assert.deepEqual(withConfig({ metroConfig: 'parsed.config.js', assetExts: ['lottie'] }), [...defaults.assetExts, 'lottie'])
      assert.throws(() => withConfig({ metroConfig: 'parsed.config.js' }), /reading the assetExts of parsed\.config\.js needs oxc-parser/u)
      assert.deepEqual(withConfig({}), [...defaults.assetExts, 'riv'])
      assert.deepEqual(withConfig({ metroConfig: false }), [...defaults.assetExts])
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
