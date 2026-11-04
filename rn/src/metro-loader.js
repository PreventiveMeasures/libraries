// Metro's resolution and transformation of each module, for an esbuild build of another tool's (a test
// runner's): onResolve and onLoad as bundle.js's metroGraph() has them, without its module graph, its
// polyfills, the modules run before the entry or the prelude, which are the build's own.

import { dirname, isAbsolute, join, resolve } from 'node:path'

import { assetData, assetModule } from './assets.js'
import { EMPTY, importResolution, moduleOf, posixRelative } from './build-host.js'
import { esbuildPath, loadCached, realPath, supportedOf, withDefaults } from './bundle.js'
import { bigBuild, defines, flowStripper, peers, projectBabel } from './cli.js'
import { diskHost } from './defaults.js'
import { createMetroResolver } from './resolve.js'
import { reactNativeOf } from './serializer.js'

const ASSET = 'metro-asset'
const TRANSFORM_PROFILES = new Set(['default', 'hermes-stable', 'hermes-canary'])
const BLOCK_SCOPING = 'transform-block-scoping'

const refuse = (message) => {
  throw new TypeError(`createMetroLoader: ${message}`)
}

// The options with their defaults, refusing what isn't one.
function optionsOf(options) {
  if (options === null || typeof options !== 'object') refuse('takes an options object')
  const { projectRoot, platform, esbuild, dev = false, sourcemap = false, transformProfile = 'default', resolver = {}, aliases = null, assetSource = null } = options
  if (typeof projectRoot !== 'string' || !isAbsolute(projectRoot)) refuse('projectRoot is an absolute path')
  if (typeof platform !== 'string' || platform.length === 0) refuse('platform is a platform name, e.g. ios')
  if (typeof esbuild?.transform !== 'function') refuse('esbuild is the esbuild module the build is made with')
  if (typeof dev !== 'boolean' || typeof sourcemap !== 'boolean') refuse('dev and sourcemap are booleans')
  if (!TRANSFORM_PROFILES.has(transformProfile)) refuse(`transformProfile is one of ${[...TRANSFORM_PROFILES].join(', ')}`)
  if (resolver === null || typeof resolver !== 'object') refuse("resolver is Metro's resolver options")
  if (aliases !== null && typeof aliases !== 'function') refuse("aliases is babel-aliases.js's createAliases() of the aliases")
  if (assetSource !== null && typeof assetSource !== 'function') refuse("assetSource is a function of an asset's path to its module's source")
  return { projectRoot, platform, esbuild, dev, sourcemap, transformProfile, resolver, aliases, assetSource }
}

export function createMetroLoader(options) {
  const { projectRoot, platform, esbuild, dev, sourcemap, transformProfile, resolver, aliases, assetSource } = optionsOf(options)
  const fail = (message) => {
    throw new Error(`createMetroLoader: ${message}`)
  }
  const project = peers(projectRoot, fail)
  // As rn-bundle's: Metro's caller and env, workers warmed for react-native's own Libraries. Files are taken
  // not to change Babel's config while it lives, as within a build: a .babelrc made later isn't seen.
  const target = projectBabel(projectRoot, project, fail, { sourceMaps: sourcemap, transformProfile, oneBuild: true, warm: bigBuild(project) })?.({ platform, dev }) ?? null
  if (target !== null && aliases !== null) {
    target.babel.close()
    fail("aliases map the imports where no Babel runs: the project's Babel config has its aliases")
  }
  // Each file as last loaded, reused while its contents are the same, across the builds it serves.
  const run = withDefaults({ projectRoot, esbuild, stripFlow: flowStripper(project, target !== null), babel: target?.babel ?? null, babelPlugins: target?.babelPlugins ?? null, sourcemap, cache: new Map() })
  const resolveModule = createMetroResolver({ ...resolver, dev })
  const resolution = importResolution(resolveModule, { platform, aliases })
  const assetOf = assetSource ?? metroAssets(resolveModule, projectRoot, platform)
  let supported = null
  return {
    define: defines(dev, [], fail),
    supported: () => (supported ??= lowersLet(target, projectRoot).then((lowers) => supportedOf(run.babel, lowers))),
    resolve: (args) => resolved(args, { projectRoot, resolution }),
    load: (args) => loaded(args, { projectRoot, run, assetOf }),
    realPath,
    close: async () => {
      await target?.babel.close()
    },
  }
}

// esbuild's onResolve of an import: a file, by a path esbuild takes as Metro does (realPath() of it is the
// file); an asset or the empty module, in a namespace of load()'s; undefined where Metro resolves nothing,
// left to esbuild, which fails but on a require in a try block, an optional dependency.
function resolved({ path, importer, namespace, resolveDir, kind, pluginData }, { projectRoot, resolution }) {
  if (kind === 'entry-point') {
    try {
      return { path: esbuildPath(diskHost.realpath(resolve(resolveDir || projectRoot, path))) }
    } catch {
      return undefined
    }
  }
  // An import of a file of another namespace (stdin) resolves from resolveDir, as from a file in it.
  const from = namespace === 'file' && isAbsolute(importer) ? realPath(importer) : namespace === ASSET ? resolve(projectRoot, importer) : join(resolveDir || projectRoot, 'index.js')
  const found = moduleOf(resolution(from, path, kind, namespace === 'file' ? pluginData : undefined))
  if (found === null) return undefined
  if (found.kind === 'empty') return { path: 'empty', namespace: EMPTY }
  // Relative to the project, as esbuild prints a file's, so the build doesn't depend on where it is.
  return found.kind === 'asset' ? { path: posixRelative(projectRoot, found.key), namespace: ASSET } : { path: esbuildPath(found.key) }
}

// esbuild's onLoad of what resolve() gave: a file as loadFile() makes it, its pluginData for the onResolve of its
// imports; an asset's module; the empty module.
async function loaded({ path, namespace = 'file' }, { projectRoot, run, assetOf }) {
  if (namespace === EMPTY) return { contents: '', loader: 'js' }
  if (namespace === ASSET) {
    const asset = resolve(projectRoot, path)
    return { contents: assetOf(asset), loader: 'js', resolveDir: dirname(asset) }
  }
  const file = realPath(path)
  return await loadCached(run, file, await diskHost.readFileAsync(file))
}

// Metro's module of an asset, registering it with the asset registry of the project's react-native.
function metroAssets(resolveModule, projectRoot, platform) {
  let registry = null
  return (path) => {
    registry ??= reactNativeOf(resolveModule, diskHost, join(projectRoot, 'package.json'), platform).assetRegistryPath
    return assetModule(assetData(path, { urlPath: posixRelative(projectRoot, path), platform, host: diskHost }), registry)
  }
}

// Whether the project's Babel config lowers let and const (bundle.js's lowersLetOf()), as for a file at its root.
async function lowersLet(target, projectRoot) {
  if (target === null) return false
  return (await target.babelPlugins(join(projectRoot, 'index.js')))?.has(BLOCK_SCOPING) === true
}
