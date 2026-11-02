// A project's Metro config, loaded as Metro loads it, by the project's own
// metro-config (loadConfig, which runs metro.config.js), as the options
// rn-bundle and rn-serve take. An option they don't do is an error, unless
// it is Metro's default or @react-native/metro-config's, or of no bearing on
// what they build (how Metro caches, watches or reports). What can't run the
// config reads its assetExts off it instead (metro-config.js).

import { existsSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

import { locateThrough, polyfills as reactNativePolyfills } from './cli.js'
import { defaults } from './defaults.js'

const under = (section, keys) => keys.map((key) => (section === '' ? key : `${section}.${key}`))
// The options rn-bundle and rn-serve do, whatever they are.
const TAKEN = new Set([
  ...under('resolver', ['assetExts', 'sourceExts', 'assetResolutions', 'resolverMainFields', 'unstable_conditionNames', 'unstable_conditionsByPlatform', 'nodeModulesPaths', 'extraNodeModules', 'disableHierarchicalLookup', 'blockList']),
  ...under('serializer', ['getPolyfills', 'polyfillModuleNames', 'getModulesRunBeforeMainModule']),
  ...under('transformer', ['assetRegistryPath', 'enableBabelRCLookup']),
])
// Of no bearing on what is built: how Metro caches, watches, works, reports
// and parses (hermes-parser or Babel's, of one language).
const LEFT = new Set([
  ...under('', ['watchFolders', 'cacheStores', 'cacheVersion', 'maxWorkers', 'stickyWorkers', 'resetCache', 'reporter', 'unstable_perfLoggerFactory', 'fileMapCacheDirectory', 'hasteMapCacheDirectory']),
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

// Metro's blockList, one RegExp or several, as RegExps that keep no state.
const patterns = (blockList) => {
  const list = blockList == null ? [] : Array.isArray(blockList) ? blockList : [blockList]
  return list.length === 0 ? null : list.map((pattern) => new RegExp(pattern.source, pattern.flags.replaceAll(/[gy]/gu, '')))
}

// Without a config: Metro's defaults as @react-native/metro-config has
// them, its polyfills those of the project's @react-native/js-polyfills, and
// what runs before the entry, and the asset registry, react-native's own.
function fallback(project, fail) {
  let polyfills = null
  const none = { runBeforeMain: null, assetRegistryPath: null, blockList: null, port: null, minifyRefusal: null }
  return { ...none, file: null, assetExts: defaults.assetExts, resolver: {}, polyfills: () => (polyfills ??= reactNativePolyfills(project, fail)), babelRCLookup: true }
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
// assetRegistryPath or null, babelRCLookup, port or null, minifyRefusal }.
// `name` is the command's, `serving` whether it serves, `minify` whether it
// minifies; where it doesn't, minifyRefusal is the error of the options it
// would not do if it did (a minifier's), or null.
export async function metroOptions(cwd, project, fail, { file = null, name, serving = false, minify = false }) {
  if (file !== null && !existsSync(resolve(cwd, file))) fail(`no such Metro config: ${file}`)
  const metroConfig = locateThrough(project, 'metro-config', ['@react-native/metro-config']) ?? locateThrough(project, 'metro-config', ['react-native', '@react-native/community-cli-plugin'])
  if (metroConfig === null) {
    const found = file ?? ['js', 'cjs', 'mjs', 'json', 'ts'].map((ext) => `metro.config.${ext}`).find((each) => existsSync(resolve(cwd, each)))
    return found === undefined ? fallback(project, fail) : fail(`loading ${found} needs metro-config, as react-native has it: npm i -D metro-config`)
  }
  const metro = project.load(metroConfig)
  const given = file === null ? undefined : resolve(cwd, file)
  const { isEmpty, filepath } = await metro.resolveConfig(given, cwd)
  if (isEmpty) return fallback(project, fail)
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
      extraNodeModules: Object.fromEntries(Object.entries(resolver.extraNodeModules ?? {}).map(([key, path]) => [key, absolute(path)])),
      disableHierarchicalLookup: resolver.disableHierarchicalLookup,
    },
    blockList: patterns(resolver.blockList),
    polyfills: (platform) => [...serializer.getPolyfills({ platform }), ...(serializer.polyfillModuleNames ?? [])],
    runBeforeMain: (entryPath) => serializer.getModulesRunBeforeMainModule(entryPath),
    // Metro's own default names no registry: react-native's then.
    assetRegistryPath: transformer.assetRegistryPath === 'missing-asset-registry-path' ? null : transformer.assetRegistryPath,
    babelRCLookup: transformer.enableBabelRCLookup !== false,
    port: server?.port ?? null,
    minifyRefusal: minifying.length === 0 ? null : errorOf(minifying),
  }
}
