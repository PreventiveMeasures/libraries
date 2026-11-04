// Metro's resolution and transformation of each module, for an esbuild build of another tool's (a test
// runner's): metroGraph()'s onResolve and onLoad (bundle.js), without its module graph, its polyfills, the
// modules run before the entry or the prelude, which are the build's own.

import { isAbsolute, join, resolve } from 'node:path'

import { assetModule } from './assets.js'
import { ASSET, EMPTY, assetDataOf, importResolution, resolvedModule } from './build-host.js'
import { TS_AS_JS, assetLoaded, esbuildPath, loadCached, lowersLetAt, notResolved, realPath, resolvedAs, supportedOf, withDefaults } from './bundle.js'
import { TRANSFORM_PROFILES, bigBuild, defines, flowStripper, peers, projectBabel } from './cli.js'
import { diskHost } from './defaults.js'
import { createMetroResolver } from './resolve.js'
import { reactNativeOf } from './serializer.js'

const refuse = (message) => {
  throw new TypeError(`createMetroLoader: ${message}`)
}
const fail = (message) => {
  throw new Error(`createMetroLoader: ${message}`)
}

export function createMetroLoader(options) {
  if (options === null || typeof options !== 'object') refuse('takes an options object')
  const { projectRoot, platform, esbuild, dev = false, sourcemap = false, transformProfile = 'default', resolver = {}, aliases = null, assetSource = null } = options
  if (typeof projectRoot !== 'string' || !isAbsolute(projectRoot)) refuse('projectRoot is an absolute path')
  if (typeof platform !== 'string' || platform.length === 0) refuse('platform is a platform name, e.g. ios')
  if (typeof esbuild?.transform !== 'function') refuse('esbuild is the esbuild module the build is made with')
  if (typeof dev !== 'boolean' || typeof sourcemap !== 'boolean') refuse('dev and sourcemap are booleans')
  if (!TRANSFORM_PROFILES.includes(transformProfile)) refuse(`transformProfile is one of ${TRANSFORM_PROFILES.join(', ')}`)
  if (resolver === null || typeof resolver !== 'object') refuse("resolver is Metro's resolver options")
  if (aliases !== null && typeof aliases !== 'function') refuse("aliases is babel-aliases.js's createAliases() of the aliases")
  if (assetSource !== null && typeof assetSource !== 'function') refuse("assetSource is a function of an asset's path to its module's source")
  const project = peers(projectRoot, fail)
  // As rn-bundle's: Metro's caller and env, workers warmed for react-native's own Libraries. Files are taken
  // not to change Babel's config while it lives, as within a build: a .babelrc made later isn't seen.
  const target = projectBabel(projectRoot, project, fail, { sourceMaps: sourcemap, transformProfile, oneBuild: true, warm: aliases === null && bigBuild(project) })?.({ platform, dev }) ?? null
  if (target !== null && aliases !== null) {
    target.babel.close()
    fail("aliases map the imports where no Babel runs: the project's Babel config has its aliases")
  }
  // Each file as last loaded, reused while its contents are the same, across the builds it serves; each
  // resolution, as createMetroResolver() keeps it, for as long.
  const run = withDefaults({ projectRoot, esbuild, stripFlow: flowStripper(project, target !== null), babel: target?.babel, babelPlugins: target?.babelPlugins, sourcemap, cache: new Map() })
  const resolveModule = createMetroResolver({ ...resolver, host: diskHost, dev })
  const resolution = importResolution(resolveModule, { platform, aliases })
  const assetOf = assetSource ?? metroAssets(resolveModule, projectRoot, platform)
  // Each file Metro resolved while it lives, which alone load() loads, as metroGraph() loads only those.
  const resolved = new Set()
  const file = (path) => {
    resolved.add(path)
    return { path: esbuildPath(path) }
  }
  let supported = null
  return {
    define: defines(dev, [], fail),
    // As bundle.js's buildOptions(): Babel's output of a TS file loads as TS, keeping each import and field.
    tsconfigRaw: target === null ? undefined : TS_AS_JS,
    // As bundle.js's lowersLetOf(), for a file at the project's root.
    supported: () => (supported ??= lowersLetAt(run.babelPlugins, join(projectRoot, 'index.js')).then((lowers) => supportedOf(run.babel, lowers))),
    // An entry point as a path; an import of a file of another namespace (stdin's) from resolveDir, as from a file in it.
    resolve({ path, importer, namespace, resolveDir, kind, pluginData }) {
      const dir = resolveDir || projectRoot
      if (kind === 'entry-point') {
        try {
          return file(diskHost.realpath(resolve(dir, path)))
        } catch {
          return undefined
        }
      }
      const from = namespace === 'file' ? realPath(importer) : namespace === ASSET ? resolve(projectRoot, importer) : join(dir, 'index.js')
      return resolvedAs(projectRoot, resolvedModule(resolution(from, path, kind, namespace === 'file' ? pluginData : undefined)), file)
    },
    async load({ path, namespace = 'file' }) {
      if (namespace === EMPTY) return { contents: '', loader: 'js' }
      if (namespace === ASSET) return assetLoaded(projectRoot, path, assetOf)
      const real = realPath(path)
      if (!resolved.has(real)) return notResolved(projectRoot, real)
      return await loadCached(run, real, await diskHost.readFileAsync(real))
    },
    realPath,
    close: async () => {
      await target?.babel.close()
    },
  }
}

// Metro's module of an asset, registering it with the asset registry of the project's react-native.
function metroAssets(resolveModule, projectRoot, platform) {
  let registry = null
  return (path) => {
    registry ??= reactNativeOf(resolveModule, diskHost, join(projectRoot, 'package.json'), platform).assetRegistryPath
    return assetModule(assetDataOf({ projectRoot, platform, host: diskHost }, path), registry)
  }
}
