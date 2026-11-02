import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { after, describe, it } from 'node:test'

import { peers } from '../src/cli.js'
import { metroOptions } from '../src/metro-options.js'
import { METRO_CONFIG, writeTree } from './fixtures.js'

const template = (custom = '{}') => `const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config')\nmodule.exports = mergeConfig(getDefaultConfig(__dirname), ${custom})\n`

describe("metroOptions, of a config over @react-native/metro-config's", () => {
  const { root, cleanup } = writeTree({
    'package.json': { name: 'app' },
    'metro.config.js': template(),
    'svg-transformer.js': 'module.exports = {}\n',
    'lib/.keep': '',
    ...METRO_CONFIG,
  })
  after(cleanup)
  // -> its options, or the message it fails with.
  const load = async (custom, here = {}) => {
    const file = `config-${Math.random().toString(36).slice(2)}.config.js`
    writeFileSync(join(root, file), template(custom))
    const fail = (message) => {
      throw Object.assign(new Error(message), { failed: true })
    }
    try {
      return await metroOptions(root, peers(root, fail), fail, { file, name: 'rn-bundle', ...here })
    } catch (error) {
      if (!error.failed) throw error
      return error.message.replaceAll(file, 'its config')
    }
  }

  it("takes React Native's template as it is, with its defaults: @react-native/metro-config's polyfills and asset registry, Metro's blockList and port", async () => {
    const options = await metroOptions(root, peers(root, assert.fail), assert.fail, { name: 'rn-bundle' })
    assert.equal(options.file, 'metro.config.js')
    assert.deepEqual(options.polyfills('ios').map((path) => basename(path)), ['polyfill.js'])
    assert.deepEqual([options.assetRegistryPath, options.blockList.map(String), options.port, options.babelRCLookup], ['react-native/Libraries/Image/AssetRegistry', [String(/(\/__tests__\/.*)$/u).replace('/u', '/')], 8081, true])
    assert.deepEqual([options.resolver.sourceExts, options.resolver.mainFields, options.resolver.conditionNames], [['js', 'jsx', 'json', 'ts', 'tsx'], ['react-native', 'browser', 'main'], ['react-native']])
    assert.equal(typeof options.runBeforeMain, 'function')
  })

  it('takes the options it does, whatever they are', async () => {
    const options = await load("{ resolver: { sourceExts: ['js', 'mjs'], extraNodeModules: { shared: '../shared' }, nodeModulesPaths: ['vendor'], disableHierarchicalLookup: true }, transformer: { enableBabelRCLookup: false } }")
    assert.deepEqual([options.resolver.sourceExts, options.resolver.extraNodeModules, options.resolver.nodeModulesPaths, options.resolver.disableHierarchicalLookup, options.babelRCLookup], [['js', 'mjs'], { shared: join(root, '../shared') }, [join(root, 'vendor')], true, false])
    // extraNodeModules by name, as Metro reads it: a Proxy's too.
    const lazy = await load("{ resolver: { extraNodeModules: new Proxy({}, { get: (_, name) => `../${String(name)}` }) } }")
    assert.equal(lazy.resolver.extraNodeModules.shared, join(root, '../shared'))
  })

  it('refuses a Babel transformer, a resolver, a serializer and transform options of its own', async () => {
    const message = await load("{ transformer: { babelTransformerPath: require.resolve('./svg-transformer.js'), getTransformOptions: async () => ({ transform: { inlineRequires: false } }) }, resolver: { resolveRequest: () => null }, serializer: { customSerializer: () => '' } }")
    assert.deepEqual(message.split('\nrn-bundle: '), [
      'its config: resolver.resolveRequest is a function: rn-bundle does it as Metro\'s default alone',
      'its config: serializer.customSerializer is a function: rn-bundle does it as Metro\'s default alone',
      "its config: transformer.babelTransformerPath is \"svg-transformer.js\", a Babel transformer of its own, not the project's Babel config as @react-native/metro-babel-transformer runs it: rn-bundle does it as Metro's default alone",
      'its config: transformer.getTransformOptions is a function: rn-bundle does it as Metro\'s default alone',
    ])
  })

  it("refuses a dev server's options where it serves alone, and a minifier's where it minifies", async () => {
    const custom = "{ server: { enhanceMiddleware: (middleware) => middleware, port: 8088 }, symbolicator: { customizeFrame: () => ({}) }, transformer: { minifierConfig: { mangle: false } } }"
    assert.equal(typeof (await load(custom)), 'object')
    const serving = await load(custom, { serving: true })
    assert.match(serving, /server\.enhanceMiddleware is a function/u)
    assert.match(serving, /symbolicator\.customizeFrame is a function/u)
    assert.doesNotMatch(serving, /server\.port|minifierConfig/u)
    assert.match(await load(custom, { minify: true }), /^its config: transformer\.minifierConfig is \{"mangle":false\}/u)
    assert.equal((await load('{ server: { port: 8088 } }', { serving: true })).port, 8088)
  })

  it("keeps, where it doesn't minify, the error a minifier's options are for a minified bundle", async () => {
    const options = await load('{ transformer: { minifierConfig: { mangle: false } } }', { serving: true })
    assert.match(options.minifyRefusal, /\.config\.js: transformer\.minifierConfig is \{"mangle":false\}: rn-bundle does it as Metro's default alone$/u)
    assert.equal((await load('{}', { serving: true })).minifyRefusal, null)
  })

  it('leaves an option Metro has none of, as Metro does (it warns), and those of no bearing on what is built', async () => {
    assert.equal(typeof (await load("{ transformer: { svgAssetPlugin: true }, watchFolders: ['..'], maxWorkers: 1, resolver: { useWatchman: false }, watcher: { additionalExts: ['cts'] } }")), 'object')
  })

  it('refuses a config of another directory, which has it for the project root', async () => {
    writeFileSync(join(root, 'lib/elsewhere.config.js'), template())
    const fail = (message) => {
      throw new Error(message)
    }
    await assert.rejects(metroOptions(root, peers(root, fail), fail, { file: 'lib/elsewhere.config.js', name: 'rn-bundle' }), /lib\/elsewhere\.config\.js: projectRoot is "lib", where the project is/u)
  })

  it('refuses require.context', async () => {
    assert.match(await load('{ transformer: { unstable_allowRequireContext: true } }'), /transformer\.unstable_allowRequireContext is true, require\.context/u)
  })
})

describe('metroOptions, of a project with no config', () => {
  const { root, cleanup } = writeTree({ 'package.json': { name: 'app' }, 'node_modules/metro-config': METRO_CONFIG['node_modules/metro-config'] })
  after(cleanup)

  it("is Metro's defaults as @react-native/metro-config has them, its registry and what runs before the entry react-native's", async () => {
    const options = await metroOptions(root, peers(root, assert.fail), assert.fail, { name: 'rn-bundle' })
    assert.deepEqual([options.file, options.runBeforeMain, options.assetRegistryPath, options.blockList, options.polyfills('ios')], [null, null, null, null, []])
  })
})
