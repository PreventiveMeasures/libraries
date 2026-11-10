// Metro's resolution and transforms for another tool's esbuild build (a test runner's): metroGraph()'s
// onResolve and onLoad, without its graph, polyfills or prelude. It reads no rn.config.json, whose
// restrictions are for the app's bundles, not tests and what they import.

import { isAbsolute, join, resolve } from 'node:path'

import { assetModule } from './assets.js'
import { ASSET, EMPTY, assetDataOf, importResolution, resolvedModule } from './build-host.js'
import { TS_AS_JS, assetLoaded, esbuildPath, loadCached, loweredAt, notResolved, realPath, resolvedAs, supportedOf, withDefaults } from './bundle.js'
import { TRANSFORM_PROFILES, bigBuild, buildEnvOf, defines, flowStripper, peers, projectBabel } from './cli.js'
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
  // As in rn-bundle, NODE_ENV and BABEL_ENV the build's for the Babel config and its plugins, without
  // setting this process's. Babel's config is taken not to change while the loader lives: a .babelrc made
  // later isn't seen.
  const define = defines(dev, [], fail)
  const shellBabelEnv = process.env.BABEL_ENV
  const envFor = (forDev) => buildEnvOf(forDev, defines(forDev, [], fail), shellBabelEnv)
  const target = projectBabel(projectRoot, project, fail, { sourceMaps: sourcemap, transformProfile, oneBuild: true, warm: aliases === null && bigBuild(project), envFor })?.({ platform, dev }) ?? null
  if (target !== null && aliases !== null) {
    target.babel.close()
    fail("aliases map the imports where no Babel runs: the project's Babel config has its aliases")
  }
  // Loaded files and resolutions are cached across the builds the loader serves.
  const run = withDefaults({ projectRoot, esbuild, stripFlow: flowStripper(project, target !== null), babel: target?.babel, babelPlugins: target?.babelPlugins, sourcemap, cache: new Map() })
  const resolveModule = createMetroResolver({ ...resolver, host: diskHost, dev })
  const resolution = importResolution(resolveModule, { platform, aliases })
  const assetOf = assetSource ?? metroAssets(resolveModule, projectRoot, platform)
  // As in metroGraph(), load() takes only files Metro resolved.
  const resolved = new Set()
  const file = (path) => {
    resolved.add(path)
    return { path: esbuildPath(path) }
  }
  let supported = null
  return {
    define,
    tsconfigRaw: target === null ? undefined : TS_AS_JS,
    supported: () => (supported ??= loweredAt(run.babelPlugins, join(projectRoot, 'index.js')).then((lowered) => supportedOf(run.babel, lowered))),
    // An import from another namespace (stdin's) resolves as from a file in resolveDir.
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

function metroAssets(resolveModule, projectRoot, platform) {
  let registry = null
  return (path) => {
    registry ??= reactNativeOf(resolveModule, diskHost, join(projectRoot, 'package.json'), platform).assetRegistryPath
    return assetModule(assetDataOf({ projectRoot, platform, host: diskHost }, path), registry)
  }
}
