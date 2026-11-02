import assert from 'node:assert/strict'
import { rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, describe, it } from 'node:test'

import { peers } from '../src/cli.js'
import { maxWorkersOf, metroOptions } from '../src/metro-options.js'
import { METRO_0_81, METRO_CONFIG, writeTree } from './fixtures.js'

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
    // Metro's default, of the CPUs: rn's then.
    assert.equal(options.maxWorkers, null)
    assert.deepEqual([options.assetRegistryPath, options.blockList.map(String), options.port, options.babelRCLookup], ['react-native/Libraries/Image/AssetRegistry', [String(/(\/__tests__\/.*)$/u).replace('/u', '/')], 8081, true])
    assert.deepEqual([options.resolver.sourceExts, options.resolver.mainFields, options.resolver.conditionNames, options.resolver.packageExports], [['js', 'jsx', 'json', 'ts', 'tsx'], ['react-native', 'browser', 'main'], ['react-native'], true])
    assert.equal(typeof options.runBeforeMain, 'function')
    assert.equal(options.babelRuntime, true)
    assert.equal(await options.transformRefusal(join(root, 'index.js'), { platform: 'ios', dev: true }), null)
    assert.deepEqual(options.ownLists, [])
  })

  it("tells which of the resolver's lists it sets as neither default has them, for rn.config.json's", async () => {
    assert.deepEqual((await load("{ resolver: { assetExts: ['png', 'riv'], sourceExts: ['js', 'mjs'] } }")).ownLists, ['assetExts', 'sourceExts'])
    // Its default, set as it is: not its own.
    assert.deepEqual((await load("{ resolver: { assetResolutions: ['1', '2'], assetExts: require('@react-native/metro-config').getDefaultConfig(__dirname).resolver.assetExts } }")).ownLists, ['assetResolutions'])
  })

  it('takes the options it does, whatever they are', async () => {
    const options = await load("{ resolver: { sourceExts: ['js', 'mjs'], extraNodeModules: { shared: '../shared' }, nodeModulesPaths: ['vendor'], disableHierarchicalLookup: true, unstable_enablePackageExports: false }, transformer: { enableBabelRCLookup: false, enableBabelRuntime: false } }")
    assert.deepEqual([options.resolver.sourceExts, options.resolver.extraNodeModules, options.resolver.nodeModulesPaths, options.resolver.disableHierarchicalLookup, options.resolver.packageExports, options.babelRCLookup, options.babelRuntime], [['js', 'mjs'], { shared: join(root, '../shared') }, [join(root, 'vendor')], true, false, false, false])
    // extraNodeModules by name, as Metro reads it: a Proxy's too.
    const lazy = await load("{ resolver: { extraNodeModules: new Proxy({}, { get: (_, name) => `../${String(name)}` }) } }")
    assert.equal(lazy.resolver.extraNodeModules.shared, join(root, '../shared'))
  })

  it('refuses a Babel transformer and a serializer of its own', async () => {
    const message = await load("{ transformer: { babelTransformerPath: require.resolve('./svg-transformer.js') }, serializer: { customSerializer: () => '' } }")
    assert.deepEqual(message.split('\nrn-bundle: '), [
      'its config: serializer.customSerializer is a function: rn-bundle does it as Metro\'s default alone',
      "its config: transformer.babelTransformerPath is \"svg-transformer.js\", a Babel transformer of its own, not the project's Babel config as @react-native/metro-babel-transformer runs it: rn-bundle does it as Metro's default alone",
    ])
  })

  it("takes Metro's inline requires as @react-native/metro-config has them, by the project's Metro", async () => {
    const options = await metroOptions(root, peers(root, assert.fail), assert.fail, { name: 'rn-bundle' })
    const { plugin, ...inline } = await options.inlineRequires(join(root, 'index.js'), { platform: 'ios', dev: false })
    assert.match(plugin, /[/\\]metro-transform-plugins[/\\]/u)
    assert.equal(typeof (await import(pathToFileURL(plugin).href)).default.inlineRequiresPlugin, 'function')
    assert.deepEqual(inline, { options: { ignoredRequires: ['React', 'react', 'react/jsx-dev-runtime', 'react/jsx-runtime', 'react-compiler-runtime', 'react-native'], memoizeCalls: false, nonMemoizedModules: [] }, blockList: [] })
  })

  it('takes the inline requires getTransformOptions gives each bundle: its nonInlinedRequires, blockList and memoizing, or none', async () => {
    const options = await load("{ transformer: { getTransformOptions: async (entries, { dev }) => ({ transform: { inlineRequires: dev && { blockList: { [entries[0]]: true } }, nonInlinedRequires: ['kept'], unstable_memoizeInlineRequires: true, unstable_nonMemoizedInlineRequires: ['fresh'] } }) } }")
    const entry = join(root, 'index.js')
    const { plugin: _plugin, ...inline } = await options.inlineRequires(entry, { platform: 'ios', dev: true })
    assert.deepEqual(inline, { options: { ignoredRequires: ['kept'], memoizeCalls: true, nonMemoizedModules: ['fresh'] }, blockList: [entry] })
    assert.equal(await options.inlineRequires(entry, { platform: 'ios', dev: false }), null)
  })

  it("refuses inline requires getTransformOptions gives of the bundle's dependencies, which it gives none", async () => {
    const options = await load("{ transformer: { getTransformOptions: async (entries, options, getDependencies) => ({ transform: { inlineRequires: { blockList: Object.fromEntries((await getDependencies(entries[0])).map((path) => [path, true])) } } }) } }")
    assert.equal((await options.transformRefusal(join(root, 'index.js'), { platform: 'ios', dev: false })).replaceAll(options.file, 'its config'), "its config: transformer.getTransformOptions gives inlineRequires of what getDependencies gives, the bundle's dependencies: rn-bundle gives it none, and doesn't inline requires of them")
  })

  it("takes a resolveRequest, to run through the metro-resolver of the project's Metro", async () => {
    const options = await load('{ resolver: { resolveRequest: (context, moduleName, platform) => context.resolveRequest(context, moduleName, platform) } }')
    assert.equal(typeof options.resolver.resolveRequest, 'function')
    assert.equal(typeof options.resolver.metroResolver.resolve, 'function')
    assert.equal((await load('{}')).resolver.metroResolver, undefined)
  })

  it('takes getTransformOptions by the transform options it gives each bundle, refusing those it does not do', async () => {
    const options = await load("{ transformer: { getTransformOptions: async (entries, { dev, hot, platform }, getDependencies) => ({ transform: { inlineRequires: false, nonInlinedRequires: ['React'], unstable_disableES6Transforms: true, experimentalImportSupport: platform === 'android' && hot && (await getDependencies(entries[0])).length === 0, unstable_inlinePlatform: !dev } }) } }")
    const entry = join(root, 'index.js')
    assert.equal(await options.transformRefusal(entry, { platform: 'ios', dev: false }), null)
    assert.deepEqual((await options.transformRefusal(entry, { platform: 'android', dev: true })).replaceAll(options.file, 'its config').split('\nrn-bundle: '), [
      "its config: transformer.getTransformOptions gives experimentalImportSupport true, Metro's own transform of import and export: rn-bundle does it as Metro's default alone",
      "its config: transformer.getTransformOptions gives unstable_inlinePlatform false, Platform.OS left to run time: rn-bundle does it as Metro's default alone",
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
    assert.equal(typeof (await load("{ transformer: { svgAssetPlugin: true }, watchFolders: ['..'], resolver: { useWatchman: false }, watcher: { additionalExts: ['cts'] } }")), 'object')
  })

  it("takes maxWorkers, where not Metro's default, as Metro's WorkerFarm does, one where not more, and --max-workers over it", async () => {
    assert.deepEqual([(await load('{ maxWorkers: 5 }')).maxWorkers, (await load('{ maxWorkers: 0 }')).maxWorkers], [5, 1])
    assert.equal((await load("{ maxWorkers: require('metro-config').getDefaultConfig.getDefaultValues().maxWorkers }")).maxWorkers, null)
    const fail = (message) => {
      throw new Error(message)
    }
    assert.deepEqual([undefined, '2', '0'].map((given) => maxWorkersOf(given, { maxWorkers: 5 }, fail)), [5, 2, 1])
    assert.throws(() => maxWorkersOf('two', { maxWorkers: 5 }, fail), /^Error: --max-workers takes a number of workers, not two$/u)
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

// Metro before 0.84 asks getTransformOptions `hot` of a served bundle alone.
describe('metroOptions, of a Metro before 0.84', () => {
  const { 'node_modules/metro-config': { link: real }, ...rest } = METRO_CONFIG
  const { root, cleanup } = writeTree({
    ...rest,
    'node_modules/metro-config/package.json': { name: 'metro-config', version: '0.83.3', main: 'index.js', exports: { '.': './index.js', './package.json': './package.json' } },
    'node_modules/metro-config/index.js': `module.exports = require(${JSON.stringify(real)})\n`,
    'metro.config.js': 'module.exports = { transformer: { getTransformOptions: async (entries, { hot }) => ({ transform: { experimentalImportSupport: hot } }) } }\n',
  })
  after(cleanup)

  it('asks it `hot` true where it serves alone', async () => {
    const refusal = async (serving) => (await metroOptions(root, peers(root, assert.fail), assert.fail, { name: 'rn-bundle', serving })).transformRefusal(join(root, 'index.js'), { platform: 'ios', dev: true })
    assert.equal(await refusal(false), null)
    assert.match(await refusal(true), /getTransformOptions gives experimentalImportSupport true/u)
  })
})

describe('metroOptions, of none loaded (rn.config.json\'s metroConfig false)', () => {
  // Of a Metro whose default reads no package's exports.
  const { root, cleanup } = writeTree({ 'package.json': { name: 'app' }, ...METRO_0_81, 'metro.config.js': "module.exports = { resolver: { unstable_enablePackageExports: false, resolveRequest: () => { throw new Error('never run') } } }\n" })
  const bare = writeTree({ 'package.json': { name: 'bare' } })
  after(() => {
    cleanup()
    bare.cleanup()
  })

  it("reads a package's exports, whatever Metro's default, of no config run", async () => {
    const options = await metroOptions(root, peers(root, assert.fail), assert.fail, { file: false, name: 'rn-bundle' })
    assert.deepEqual([options.file, options.resolver.packageExports], [null, true])
    // Without metro-config too.
    assert.equal((await metroOptions(bare.root, peers(bare.root, assert.fail), assert.fail, { file: false, name: 'rn-bundle' })).resolver.packageExports, true)
  })

  it("is Metro's default where the project has no config: of 0.81, none", async () => {
    rmSync(join(root, 'metro.config.js'))
    assert.equal((await metroOptions(root, peers(root, assert.fail), assert.fail, { name: 'rn-bundle' })).resolver.packageExports, false)
  })
})

describe('metroOptions, of a project with no config', () => {
  const { root, cleanup } = writeTree({ 'package.json': { name: 'app' }, 'node_modules/metro-config': METRO_CONFIG['node_modules/metro-config'] })
  after(cleanup)

  it("is Metro's defaults as @react-native/metro-config has them, its registry and what runs before the entry react-native's", async () => {
    const options = await metroOptions(root, peers(root, assert.fail), assert.fail, { name: 'rn-bundle' })
    assert.deepEqual([options.file, options.runBeforeMain, options.assetRegistryPath, options.blockList, options.polyfills('ios')], [null, null, null, null, []])
    // Metro's own default, of its version: 0.87's.
    assert.equal(options.resolver.packageExports, true)
    // Metro's own inline none.
    assert.equal(await options.inlineRequires(join(root, 'index.js'), { platform: 'ios', dev: false }), null)
  })
})
