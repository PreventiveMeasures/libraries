// Loads a project's Metro config as Metro does (its metro-config's loadConfig) into rn-bundle's and
// rn-serve's options. An option they can't honor is an error unless it is a default (Metro's or
// @react-native/metro-config's) or doesn't affect the build. asset-exts.js reads assetExts without running it.

import { existsSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import { locateThrough, tryResolve } from './cli.js'
import { defaults } from './defaults.js'

const under = (section, keys) => keys.map((key) => `${section}.${key}`)
// The options rn-bundle and rn-serve honor, whatever their values.
const TAKEN = new Set([
  ...under('resolver', ['assetExts', 'sourceExts', 'assetResolutions', 'resolverMainFields', 'unstable_conditionNames', 'unstable_conditionsByPlatform', 'nodeModulesPaths', 'extraNodeModules', 'disableHierarchicalLookup', 'blockList', 'unstable_enablePackageExports', 'resolveRequest']),
  ...under('serializer', ['getPolyfills', 'polyfillModuleNames', 'getModulesRunBeforeMainModule']),
  // getTransformOptions is checked by what it returns (TRANSFORMS).
  ...under('transformer', ['assetRegistryPath', 'enableBabelRCLookup', 'enableBabelRuntime', 'getTransformOptions']),
  'maxWorkers',
])
// Transform options that are refused unless at Metro's default. The rest concern inline
// requires, which are honored (inlineRequiresOf()), or are unread since Metro 0.81.
const TRANSFORMS = {
  experimentalImportSupport: [Boolean, "Metro's own transform of import and export"],
  unstable_inlinePlatform: [(value) => value === false, 'Platform.OS left to run time'],
}
// Options that don't affect the output: caching, watching, workers, reporting and parsing.
const LEFT = new Set([
  'watchFolders', 'cacheStores', 'cacheVersion', 'stickyWorkers', 'resetCache', 'reporter', 'unstable_perfLoggerFactory', 'fileMapCacheDirectory', 'hasteMapCacheDirectory',
  ...under('resolver', ['platforms', 'useWatchman', 'requireCycleIgnorePatterns', 'unstable_incrementalResolution']),
  ...under('transformer', ['optimizationSizeLimit', 'unstable_workerThreads', 'unstable_compactOutput', 'hermesParser']),
])
const SECTIONS = new Set(['resolver', 'serializer', 'server', 'symbolicator', 'transformer', 'watcher'])
// Explanations for options whose names don't say what they do.
const WHY = {
  'transformer.babelTransformerPath': "a Babel transformer of its own, not the project's Babel config as @react-native/metro-babel-transformer runs it",
  'transformer.unstable_allowRequireContext': 'require.context',
  projectRoot: 'where the project is: it is where the command runs (and a config in another directory has that for it)',
}

// Metro's transformHelpers' baseIgnoredInlineRequires, used when the config sets no nonInlinedRequires.
const NOT_INLINED = ['React', 'react', 'react/jsx-dev-runtime', 'react/jsx-runtime', 'react-compiler-runtime', 'react-native']

// Asks getTransformOptions as Metro does. getDependencies resolves to none, since the bundle's
// dependencies aren't known before it builds; `dependencies` says whether it was called.
async function transformOf(getTransformOptions, entryPath, { platform, dev }, hot) {
  let dependencies = false
  const given = await getTransformOptions(entryPath === null ? [] : [entryPath], { dev, hot, platform }, () => {
    dependencies = true
    return Promise.resolve([])
  })
  return { transform: given?.transform ?? {}, dependencies }
}

// Metro's inline requires for a bundle, as metro-transform-plugins (`plugin`) applies them after
// Babel: async (entryPath, { platform, dev }) => { plugin, options, blockList } or null.
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

// A package as the Metro at `metro` (a path, or null) requires it.
const besideMetro = (metro, name) => (metro === null ? null : tryResolve(createRequire(metro), name))

// @react-native/metro-config's getTransformOptions in 0.76 to 0.88.
const reactNativeTransformOptions = () => Promise.resolve({ transform: { experimentalImportSupport: false, inlineRequires: true } })

// Metro's default blockList (metro-config's exclusionList()): __tests__ directories.
const METRO_BLOCK_LIST = Object.freeze([new RegExp(`(\\${sep}__tests__\\${sep}.*)$`, 'u')])

// Whether two option values are the same; functions compare by source.
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

// Options that don't matter to this command: the dev server's when only bundling, the minifier's when not minifying.
const leftHere = (path, { serving, minify }) =>
  path.startsWith('watcher.') ||
  (!serving && (path.startsWith('server.') || path.startsWith('symbolicator.'))) ||
  (serving && ['server.port', 'server.forwardClientLogs', 'server.useGlobalHotkey'].includes(path)) ||
  (!minify && ['transformer.minifierPath', 'transformer.minifierConfig'].includes(path))

// The options of `config` this command can't honor that differ from every default. An option
// no default has is left alone, as Metro only warns of it.
function unsupportedOptions(config, baselines, here) {
  const paths = Object.entries(config).flatMap(([key, value]) => (SECTIONS.has(key) && value !== null && typeof value === 'object' ? Object.keys(value).map((inner) => `${key}.${inner}`) : [key]))
  return paths.filter((path) => !TAKEN.has(path) && !LEFT.has(path) && !leftHere(path, here) && baselines.some((base) => has(base, path)) && !baselines.some((base) => same(at(config, path), at(base, path))))
}

const show = (value, cwd) => {
  if (typeof value === 'function') return 'a function'
  if (value instanceof RegExp) return String(value)
  if (typeof value === 'string' && isAbsolute(value)) return JSON.stringify(relative(cwd, value))
  return JSON.stringify(value) ?? String(value)
}

// As Metro's WorkerFarm takes maxWorkers: at least one.
const workersOf = (maxWorkers) => Math.max(1, Math.trunc(maxWorkers) || 1)

// --max-workers, else the config's maxWorkers.
export function maxWorkersOf(given, metro, fail) {
  if (given === undefined) return metro.maxWorkers
  return /^\d+$/u.test(given) ? workersOf(Number(given)) : fail(`--max-workers takes a number of workers, not ${given}`)
}

const realPathOf = (path) => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

// Metro's blockList, one RegExp or several, as stateless RegExps (no g or y flag).
const patterns = (blockList) => {
  const list = [blockList ?? []].flat()
  return list.length === 0 ? null : list.map((pattern) => new RegExp(pattern.source, pattern.flags.replaceAll(/[gy]/gu, '')))
}

// @react-native/metro-config's serializer.getPolyfills: the project's @react-native/js-polyfills
// (through its @react-native/metro-config); none if it has none.
function reactNativePolyfills(project, fail) {
  const list = locateThrough(project, '@react-native/js-polyfills', ['@react-native/metro-config'])
  if (list === null) return []
  const getPolyfills = project.load(list)
  const paths = typeof getPolyfills === 'function' ? getPolyfills() : null
  return Array.isArray(paths) && paths.every((path) => typeof path === 'string') ? paths : fail(`${list} lists no polyfills`)
}

// Without a config: Metro's defaults as @react-native/metro-config sets them, with react-native's
// own modules before the entry and asset registry.
function fallback(project, fail, resolver = {}, inlineRequires = () => Promise.resolve(null)) {
  let polyfills = null
  return {
    file: null,
    assetExts: defaults.assetExts,
    resolver,
    blockList: METRO_BLOCK_LIST,
    polyfills: () => (polyfills ??= reactNativePolyfills(project, fail)),
    runBeforeMain: null,
    assetRegistryPath: null,
    babelRCLookup: true,
    babelRuntime: true,
    inlineRequires,
    port: null,
    watchFolders: null,
    maxWorkers: null,
    defaultLists: null,
    minifyRefusal: null,
    transformRefusal: () => null,
  }
}

// The metro-resolver of the project's Metro, which a config's resolveRequest runs through.
function metroResolverOf(project, fromConfig, metro, fail) {
  const found = besideMetro(metro, 'metro-resolver') ?? tryResolve(fromConfig, 'metro-resolver')
  return found === null ? fail('resolver.resolveRequest runs through metro-resolver, as Metro has it: npm i -D metro-resolver') : project.load(found)
}

// Metro's defaults, plus @react-native/metro-config's merged over them if the project has it and it loads.
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

// The project's Metro config as bundle() and createDevBundler() take it: `file`, else the one Metro
// finds, else none if false. A refusal is the error message of what this command can't honor:
// minifyRefusal for minifier options when not minifying, transformRefusal per bundle, else null.
export async function metroOptions(cwd, project, fail, { file = null, name, serving = false, minify = false }) {
  // React Native's defaults with no metro-config loaded: package exports read, and requires inlined by
  // metro-transform-plugins: the project's, else rn's, else its Metro's (which pnpm only exposes there).
  if (file === false) {
    const plugins = project.locate('metro-transform-plugins') ?? besideMetro(locateThrough(project, 'metro', ['react-native', '@react-native/community-cli-plugin']) ?? locateThrough(project, 'metro', ['@react-native/metro-config', 'metro-config']), 'metro-transform-plugins')
    return fallback(project, fail, { packageExports: true }, inlineRequiresOf(reactNativeTransformOptions, plugins, serving))
  }
  if (typeof file === 'string' && !existsSync(resolve(cwd, file))) fail(`no such Metro config: ${file}`)
  const metroConfig = locateThrough(project, 'metro-config', ['@react-native/metro-config']) ?? locateThrough(project, 'metro-config', ['react-native', '@react-native/community-cli-plugin'])
  if (metroConfig === null) {
    const found = file ?? ['js', 'cjs', 'mjs', 'json', 'ts'].map((ext) => `metro.config.${ext}`).find((each) => existsSync(resolve(cwd, each)))
    return found === undefined ? fallback(project, fail) : fail(`loading ${found} needs metro-config, as react-native has it: npm i -D metro-config`)
  }
  const metro = project.load(metroConfig)
  const fromConfig = createRequire(metroConfig)
  const metroPath = tryResolve(fromConfig, 'metro')
  // Metro 0.84+ passes `hot` to getTransformOptions for every bundle; before, only when serving.
  const [major, minor] = fromConfig('metro-config/package.json').version.split('.').map(Number)
  const hot = serving || major > 0 || minor >= 84
  const given = typeof file === 'string' ? resolve(cwd, file) : undefined
  const { isEmpty, filepath } = await metro.resolveConfig(given, cwd)
  const plugins = besideMetro(metroPath, 'metro-transform-plugins')
  // No config file: Metro's defaults (package exports read from 0.82), with requires inlined as
  // @react-native/metro-config does, if the project has it.
  if (isEmpty) {
    const baselines = await baselinesOf(metro, project, cwd)
    return fallback(project, fail, { packageExports: Boolean(baselines[0].resolver.unstable_enablePackageExports) }, inlineRequiresOf(baselines.at(-1).transformer?.getTransformOptions, plugins, hot))
  }
  const shown = relative(cwd, filepath)
  let config
  try {
    config = await metro.loadConfig({ cwd, ...(given !== undefined && { config: given }) })
  } catch (error) {
    return fail(`${shown}: ${error.message}`)
  }
  const baselines = await baselinesOf(metro, project, cwd)
  const errorOf = (paths) => paths.map((path) => `${shown}: ${path} is ${show(at(config, path), cwd)}${Object.hasOwn(WHY, path) ? `, ${WHY[path]}` : ''}: ${name} does it as Metro's default alone`).join(`\n${name}: `)
  const unsupported = unsupportedOptions(config, baselines, { serving, minify })
  if (unsupported.length > 0) fail(errorOf(unsupported))
  const minifying = minify ? [] : unsupportedOptions(config, baselines, { serving, minify: true })
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
      // Looked up by name, as Metro does, so a config's own Proxy works too.
      extraNodeModules: new Proxy(resolver.extraNodeModules ?? {}, { get: (target, key) => (typeof target[key] === 'string' ? absolute(target[key]) : target[key]) }),
      disableHierarchicalLookup: resolver.disableHierarchicalLookup,
      packageExports: Boolean(resolver.unstable_enablePackageExports),
      ...(typeof resolver.resolveRequest === 'function' && { metroResolver: metroResolverOf(project, fromConfig, metroPath, fail), resolveRequest: resolver.resolveRequest }),
    },
    blockList: patterns(resolver.blockList),
    polyfills: (platform) => [...serializer.getPolyfills({ platform }), ...(serializer.polyfillModuleNames ?? [])],
    runBeforeMain: (entryPath) => serializer.getModulesRunBeforeMainModule(entryPath),
    // Metro's own default names no registry, so react-native's is used.
    assetRegistryPath: transformer.assetRegistryPath === 'missing-asset-registry-path' ? null : transformer.assetRegistryPath,
    babelRCLookup: transformer.enableBabelRCLookup !== false,
    babelRuntime: transformer.enableBabelRuntime ?? true,
    inlineRequires: inlineRequiresOf(transformer.getTransformOptions, plugins, hot),
    port: server?.port ?? null,
    watchFolders: config.watchFolders.map((folder) => realPathOf(resolve(cwd, folder))),
    // Null at a default: Metro's (by CPU count) is too many for rn, which uses defaultWorkers().
    maxWorkers: baselines.some((baseline) => baseline.maxWorkers === config.maxWorkers) ? null : workersOf(config.maxWorkers),
    defaultLists: baselines.map(({ resolver: lists }) => ({ assetExts: lists.assetExts, sourceExts: lists.sourceExts, assetResolutions: lists.assetResolutions })),
    minifyRefusal: minifying.length === 0 ? null : errorOf(minifying),
    transformRefusal: async (entryPath, target) => {
      const { transform, dependencies } = await transformOf(transformer.getTransformOptions, entryPath, target, hot)
      const refused = Object.entries(TRANSFORMS).filter(([key, [isRefused]]) => isRefused(transform[key]))
      const errors = refused.map(([key, [, what]]) => `${shown}: transformer.getTransformOptions gives ${key} ${show(transform[key], cwd)}, ${what}: ${name} does it as Metro's default alone`)
      // getDependencies only matters here when inlineRequires depends on it.
      if (dependencies && transform.inlineRequires) errors.push(`${shown}: transformer.getTransformOptions gives inlineRequires of what getDependencies gives, the bundle's dependencies: ${name} gives it none, and doesn't inline requires of them`)
      return errors.length === 0 ? null : errors.join(`\n${name}: `)
    },
  }
}
