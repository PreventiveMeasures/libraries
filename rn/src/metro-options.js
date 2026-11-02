// A project's Metro config, loaded as Metro loads it, by the project's own
// metro-config (loadConfig, which runs metro.config.js), as the options
// rn-bundle and rn-serve take. An option they don't do is an error, unless
// it is Metro's default or @react-native/metro-config's, or of no bearing on
// what they build (how Metro caches, watches or reports). What can't run the
// config reads its assetExts off it instead (metro-config.js).

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, relative, resolve } from 'node:path'

import { locateThrough, polyfills as reactNativePolyfills, tryResolve } from './cli.js'
import { defaults } from './defaults.js'

const under = (section, keys) => keys.map((key) => (section === '' ? key : `${section}.${key}`))
// The options rn-bundle and rn-serve do, whatever they are.
const TAKEN = new Set([
  ...under('resolver', ['assetExts', 'sourceExts', 'assetResolutions', 'resolverMainFields', 'unstable_conditionNames', 'unstable_conditionsByPlatform', 'nodeModulesPaths', 'extraNodeModules', 'disableHierarchicalLookup', 'blockList', 'unstable_enablePackageExports', 'resolveRequest']),
  ...under('serializer', ['getPolyfills', 'polyfillModuleNames', 'getModulesRunBeforeMainModule']),
  // getTransformOptions by what it gives (TRANSFORMS).
  ...under('transformer', ['assetRegistryPath', 'enableBabelRCLookup', 'enableBabelRuntime', 'getTransformOptions']),
  // How many workers Babel transforms in.
  'maxWorkers',
])
// Of the transform options getTransformOptions gives, those rn-bundle and
// rn-serve don't do, where not Metro's default: the rest are of how Metro
// inlines requires, which they do as it does (inlineRequiresOf()), or of
// nothing Metro 0.81 on reads.
const TRANSFORMS = {
  experimentalImportSupport: [Boolean, "Metro's own transform of import and export"],
  unstable_inlinePlatform: [(value) => value === false, 'Platform.OS left to run time'],
}
// Of no bearing on what is built: how Metro caches, watches, works, reports
// and parses (hermes-parser or Babel's, of one language).
const LEFT = new Set([
  ...under('', ['watchFolders', 'cacheStores', 'cacheVersion', 'stickyWorkers', 'resetCache', 'reporter', 'unstable_perfLoggerFactory', 'fileMapCacheDirectory', 'hasteMapCacheDirectory']),
  ...under('resolver', ['platforms', 'useWatchman', 'requireCycleIgnorePatterns', 'unstable_incrementalResolution']),
  ...under('transformer', ['optimizationSizeLimit', 'unstable_workerThreads', 'unstable_compactOutput', 'hermesParser']),
])
const SECTIONS = new Set(['resolver', 'serializer', 'server', 'symbolicator', 'transformer', 'watcher'])
// What one is, where its name doesn't say.
const WHY = {
  'transformer.babelTransformerPath': "a Babel transformer of its own, not the project's Babel config as @react-native/metro-babel-transformer runs it",
  'transformer.unstable_allowRequireContext': 'require.context',
  projectRoot: 'where the project is: it is where the command runs (and a config in another directory has that for it)',
}

// What Metro doesn't inline a require of, where the config names none
// (nonInlinedRequires): its transformHelpers' baseIgnoredInlineRequires.
const NOT_INLINED = ['React', 'react', 'react/jsx-dev-runtime', 'react/jsx-runtime', 'react-compiler-runtime', 'react-native']

// What getTransformOptions gives a bundle, asked as Metro asks it (`hot` as
// the project's Metro does), its getDependencies giving none, of the
// bundle's dependencies, which neither command knows before it builds:
// -> { transform, dependencies } (whether it asked them).
async function transformOf(getTransformOptions, entryPath, { platform, dev }, hot) {
  let dependencies = false
  const given = await getTransformOptions(entryPath === null ? [] : [entryPath], { dev, hot, platform }, () => {
    dependencies = true
    return Promise.resolve([])
  })
  return { transform: given?.transform ?? {}, dependencies }
}

// Metro's inline requires, as getTransformOptions gives them a bundle (but
// of its dependencies, which transformRefusal refuses), and its transform
// worker inlines them after Babel, by its metro-transform-plugins (`plugin`,
// its path): -> async (entryPath, { platform, dev }) => { plugin, options,
// blockList } (the plugin's options, the files it leaves) or null.
function inlineRequiresOf(getTransformOptions, plugin, hot) {
  if (typeof getTransformOptions !== 'function' || plugin === null) return () => Promise.resolve(null)
  return async (entryPath, target) => {
    const { transform } = await transformOf(getTransformOptions, entryPath, target, hot)
    if (!transform.inlineRequires) return null
    return {
      plugin,
      options: { ignoredRequires: transform.nonInlinedRequires || NOT_INLINED, memoizeCalls: transform.unstable_memoizeInlineRequires || false, nonMemoizedModules: transform.unstable_nonMemoizedInlineRequires || [] },
      blockList: typeof transform.inlineRequires === 'object' ? Object.keys(transform.inlineRequires.blockList ?? {}) : [],
    }
  }
}

// Metro's metro-transform-plugins, as metro-config (at that path) has Metro's.
function transformPluginsOf(metroConfig) {
  try {
    return createRequire(createRequire(metroConfig).resolve('metro')).resolve('metro-transform-plugins')
  } catch {
    return null
  }
}

// Whether two values of an option are the same: functions by their source.
function same(a, b) {
  if (a === b) return true
  if (typeof a === 'function' || typeof b === 'function') return typeof a === typeof b && String(a) === String(b)
  if (a instanceof RegExp || b instanceof RegExp) return a instanceof RegExp && b instanceof RegExp && String(a) === String(b)
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((each, i) => same(each, b[i]))
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return Number.isNaN(a) && Number.isNaN(b)
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].every((key) => same(a[key], b[key]))
}

const at = (config, path) => path.split('.').reduce((value, key) => value?.[key], config)
const has = (config, path) => {
  const [section, key] = path.split('.')
  return key === undefined ? Object.hasOwn(config, section) : Object.hasOwn(config[section] ?? {}, key)
}

// What of no bearing on what this command builds: a dev server's options
// where it bundles; a minifier's where it doesn't minify.
const leftHere = (path, { serving, minify }) =>
  path.startsWith('watcher.') ||
  (!serving && (path.startsWith('server.') || path.startsWith('symbolicator.'))) ||
  (serving && ['server.port', 'server.forwardClientLogs', 'server.useGlobalHotkey'].includes(path)) ||
  (!minify && ['transformer.minifierPath', 'transformer.minifierConfig'].includes(path))

// Each option of `config` this command doesn't do, and isn't as either
// default has it; one no default has, Metro's own warns of and leaves.
export function unsupportedOptions(config, baselines, here) {
  const paths = Object.entries(config).flatMap(([key, value]) => (SECTIONS.has(key) && value !== null && typeof value === 'object' ? Object.keys(value).map((inner) => `${key}.${inner}`) : [key]))
  return paths.filter((path) => !TAKEN.has(path) && !LEFT.has(path) && !leftHere(path, here) && baselines.some((base) => has(base, path)) && !baselines.some((base) => same(at(config, path), at(base, path))))
}

const show = (value, cwd) => {
  if (typeof value === 'function') return 'a function'
  if (value instanceof RegExp) return String(value)
  if (typeof value === 'string' && isAbsolute(value)) return JSON.stringify(relative(cwd, value))
  return JSON.stringify(value) ?? String(value)
}

// Metro's maxWorkers (its getMaxWorkers() of the CPUs, by default), as its
// WorkerFarm takes it: one, which Metro transforms in on its main thread,
// where not more than one.
export const workersOf = (maxWorkers) => Math.max(1, Math.trunc(maxWorkers) || 1)

// --max-workers, as Metro's CLI takes it, over the config's maxWorkers
// (metroOptions()'s): unless given, the config's.
export function maxWorkersOf(given, metro, fail) {
  if (given === undefined) return metro.maxWorkers
  return /^\d+$/u.test(given) ? workersOf(Number(given)) : fail(`--max-workers takes a number of workers, not ${given}`)
}

// Metro's blockList, one RegExp or several, as RegExps that keep no state.
const patterns = (blockList) => {
  const list = blockList == null ? [] : Array.isArray(blockList) ? blockList : [blockList]
  return list.length === 0 ? null : list.map((pattern) => new RegExp(pattern.source, pattern.flags.replaceAll(/[gy]/gu, '')))
}

// Without a config: Metro's defaults as @react-native/metro-config has
// them, its polyfills those of the project's @react-native/js-polyfills, and
// what runs before the entry, and the asset registry, react-native's own;
// its inline requires, where Metro is the project's (`inlineRequires`).
function fallback(project, fail, resolver = {}, inlineRequires = () => Promise.resolve(null)) {
  let polyfills = null
  const none = { runBeforeMain: null, assetRegistryPath: null, blockList: null, port: null, maxWorkers: null, minifyRefusal: null, transformRefusal: () => null }
  return { ...none, file: null, assetExts: defaults.assetExts, resolver, polyfills: () => (polyfills ??= reactNativePolyfills(project, fail)), babelRCLookup: true, babelRuntime: true, inlineRequires }
}

// The metro-resolver the project's Metro runs, of its metro-config's metro:
// a resolveRequest of the config runs through it, as through Metro's.
function metroResolverOf(project, metroConfig, fail) {
  const fromConfig = createRequire(metroConfig)
  const metro = tryResolve(fromConfig, 'metro')
  const found = (metro === null ? null : tryResolve(createRequire(metro), 'metro-resolver')) ?? tryResolve(fromConfig, 'metro-resolver')
  return found === null ? fail('resolver.resolveRequest runs through metro-resolver, as Metro has it: npm i -D metro-resolver') : project.load(found)
}

// Metro's defaults, and @react-native/metro-config's over them where the
// project has it, and it loads.
async function baselinesOf(metro, project, cwd) {
  const metroDefaults = await metro.getDefaultConfig(cwd)
  const reactNative = locateThrough(project, '@react-native/metro-config')
  if (reactNative === null) return [metroDefaults]
  try {
    return [metroDefaults, metro.mergeConfig(metroDefaults, project.load(reactNative).getDefaultConfig(cwd))]
  } catch {
    return [metroDefaults]
  }
}

// The project's Metro config (`file`, else the one Metro finds), as
// bundle() and createDevBundler() take it: { file, assetExts, resolver,
// blockList, polyfills(platform), runBeforeMain(entryPath) or null,
// assetRegistryPath or null, babelRCLookup, babelRuntime, port or null,
// maxWorkers (workersOf()) or null, Metro's default then, minifyRefusal,
// transformRefusal(entryPath, { platform, dev }), inlineRequires(entryPath,
// { platform, dev }) (inlineRequiresOf()) }. `name` is the command's,
// `serving` whether it serves, `minify` whether it minifies; where it
// doesn't, minifyRefusal is the error of the options it would not do if it
// did (a minifier's), or null. transformRefusal is (a promise of) the error
// of the transform options getTransformOptions gives a bundle, as Metro asks
// it for each, that they don't do (TRANSFORMS), or null.
export async function metroOptions(cwd, project, fail, { file = null, name, serving = false, minify = false }) {
  if (file !== null && !existsSync(resolve(cwd, file))) fail(`no such Metro config: ${file}`)
  const metroConfig = locateThrough(project, 'metro-config', ['@react-native/metro-config']) ?? locateThrough(project, 'metro-config', ['react-native', '@react-native/community-cli-plugin'])
  if (metroConfig === null) {
    const found = file ?? ['js', 'cjs', 'mjs', 'json', 'ts'].map((ext) => `metro.config.${ext}`).find((each) => existsSync(resolve(cwd, each)))
    return found === undefined ? fallback(project, fail) : fail(`loading ${found} needs metro-config, as react-native has it: npm i -D metro-config`)
  }
  const metro = project.load(metroConfig)
  // As Metro asks getTransformOptions, from 0.84 on, `hot` of each bundle;
  // before, a served one's alone.
  const [major, minor] = createRequire(metroConfig)('metro-config/package.json').version.split('.').map(Number)
  const hot = serving || major > 0 || minor >= 84
  const given = file === null ? undefined : resolve(cwd, file)
  const { isEmpty, filepath } = await metro.resolveConfig(given, cwd)
  const plugins = transformPluginsOf(metroConfig)
  // Without one, Metro's defaults: from 0.82 on, a package's exports read;
  // its requires inlined as @react-native/metro-config has them, where the
  // project has it.
  if (isEmpty) return fallback(project, fail, { packageExports: Boolean((await metro.getDefaultConfig(cwd)).resolver.unstable_enablePackageExports) }, inlineRequiresOf((await baselinesOf(metro, project, cwd)).at(-1).transformer?.getTransformOptions, plugins, hot))
  const shown = relative(cwd, filepath)
  let config
  try {
    config = await metro.loadConfig({ cwd, ...(given !== undefined && { config: given }) })
  } catch (error) {
    return fail(`${shown}: ${error.message}`)
  }
  const baselines = await baselinesOf(metro, project, cwd)
  const unsupported = unsupportedOptions(config, baselines, { serving, minify })
  const why = (path) => (Object.hasOwn(WHY, path) ? `, ${WHY[path]}` : '')
  const errorOf = (paths) => paths.map((path) => `${shown}: ${path} is ${show(at(config, path), cwd)}${why(path)}: ${name} does it as Metro's default alone`).join(`\n${name}: `)
  if (unsupported.length > 0) fail(errorOf(unsupported))
  const minifying = minify ? [] : unsupportedOptions(config, baselines, { serving, minify: true }).filter((path) => !unsupported.includes(path))
  const { resolver, serializer, transformer, server } = config
  const absolute = (path) => (isAbsolute(path) ? path : resolve(config.projectRoot ?? cwd, path))
  return {
    file: shown,
    assetExts: resolver.assetExts,
    resolver: {
      sourceExts: resolver.sourceExts,
      assetResolutions: resolver.assetResolutions,
      mainFields: resolver.resolverMainFields,
      conditionNames: resolver.unstable_conditionNames,
      conditionsByPlatform: resolver.unstable_conditionsByPlatform,
      nodeModulesPaths: (resolver.nodeModulesPaths ?? []).map(absolute),
      // Read by name, as Metro reads it: a Proxy's names too.
      extraNodeModules: new Proxy(resolver.extraNodeModules ?? {}, { get: (target, key) => (typeof target[key] === 'string' ? absolute(target[key]) : target[key]) }),
      disableHierarchicalLookup: resolver.disableHierarchicalLookup,
      packageExports: Boolean(resolver.unstable_enablePackageExports),
      ...(typeof resolver.resolveRequest === 'function' && { metroResolver: metroResolverOf(project, metroConfig, fail), resolveRequest: resolver.resolveRequest }),
    },
    blockList: patterns(resolver.blockList),
    polyfills: (platform) => [...serializer.getPolyfills({ platform }), ...(serializer.polyfillModuleNames ?? [])],
    runBeforeMain: (entryPath) => serializer.getModulesRunBeforeMainModule(entryPath),
    // Metro's own default names no registry: react-native's then.
    assetRegistryPath: transformer.assetRegistryPath === 'missing-asset-registry-path' ? null : transformer.assetRegistryPath,
    babelRCLookup: transformer.enableBabelRCLookup !== false,
    babelRuntime: transformer.enableBabelRuntime ?? true,
    inlineRequires: inlineRequiresOf(transformer.getTransformOptions, plugins, hot),
    port: server?.port ?? null,
    maxWorkers: workersOf(config.maxWorkers),
    minifyRefusal: minifying.length === 0 ? null : errorOf(minifying),
    transformRefusal: async (entryPath, target) => {
      // Its getDependencies, of what preloads, of no bearing here; but of
      // the requires it inlines, which it would have of none.
      const { transform, dependencies } = await transformOf(transformer.getTransformOptions, entryPath, target, hot)
      const refused = Object.entries(TRANSFORMS).filter(([key, [isRefused]]) => isRefused(transform[key]))
      const errors = refused.map(([key, [, what]]) => `${shown}: transformer.getTransformOptions gives ${key} ${show(transform[key], cwd)}, ${what}: ${name} does it as Metro's default alone`)
      if (dependencies && transform.inlineRequires) errors.push(`${shown}: transformer.getTransformOptions gives inlineRequires of what getDependencies gives, the bundle's dependencies: ${name} gives it none, and doesn't inline requires of them`)
      return errors.length === 0 ? null : errors.join(`\n${name}: `)
    },
  }
}
