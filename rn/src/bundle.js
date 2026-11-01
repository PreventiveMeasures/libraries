// `stasis bundle --metro` and `stasis build --metro=PLATFORM` in one: the
// module graph as Metro resolves it for a platform, captured as esbuild
// follows the imports, is what esbuild builds. Each asset is built as Metro's
// asset module; each file is read through the host. As Metro's serializer
// has a bundle (serializer.js): the prelude, the polyfills, the modules run
// before the entry, then the entry.

import { dirname, relative, resolve } from 'node:path'

import { assetData, assetModule } from './assets.js'
import { defaults, diskHost } from './defaults.js'
import { loadFile } from './load.js'
import { createMetroResolver } from './resolve.js'
import { reactNativeOf } from './serializer.js'

// Lowered by esbuild in the bundle, after Babel, which leaves them.
const LOWERED = {
  'class-field': false,
  'class-private-accessor': false,
  'class-private-brand-check': false,
  'class-private-field': false,
  'class-private-method': false,
  'class-private-static-accessor': false,
  'class-private-static-field': false,
  'class-private-static-method': false,
  'class-static-blocks': false,
  'class-static-field': false,
  'import-attributes': false,
  using: false,
}
const decoder = new TextDecoder()
// eslint-disable-next-line require-unicode-regexp -- esbuild's filters are Go regexps, which take no `u`
const ANY = /.*/
// The module that runs the polyfills, then each module run before the entry,
// then the entry.
const MAIN = 'metro-main'
const POLYFILL = 'metro-polyfill:'
const ENTRY = 'metro-entry:'
// As Metro wraps a polyfill: a script, given the global object.
const GLOBAL = "typeof globalThis !== 'undefined' ? globalThis : typeof global !== 'undefined' ? global : typeof window !== 'undefined' ? window : this"

// -> { outputFiles, warnings, assets: AssetData[], graph: Map<importer, Map<specifier, Resolution>>, files: string[] }
export async function bundle(options) {
  // Its one build takes the state made to know what runs before the entry.
  const graph = metroGraph(options, { reuseFirst: true })
  return graph.result(await options.esbuild.build(buildOptions(options, graph, graph.before().length > 0 || (options.polyfills?.length ?? 0) > 0)))
}

// bundle(), to build again and again on one esbuild context: each build
// resolves and reads every file anew, but for `cache`'s.
export async function createBundler(options) {
  const graph = metroGraph(options, { reuseFirst: false })
  // Through the main module always, as what runs before the entry may change.
  const context = await options.esbuild.context(buildOptions(options, graph, true))
  return {
    // Throws as esbuild does, the error's `files` those the build read.
    rebuild: async () => {
      try {
        return graph.result(await context.rebuild())
      } catch (error) {
        if (error !== null && typeof error === 'object') error.files = graph.files()
        throw error
      }
    },
    dispose: () => context.dispose(),
  }
}

function buildOptions({ entry, outfile, projectRoot = process.cwd(), define = {}, minify = false, babel = null, prelude = null, sourcemap = false }, { plugin }, main) {
  return {
    entryPoints: [main ? MAIN : entry],
    absWorkingDir: projectRoot,
    bundle: true,
    write: false,
    outfile: resolve(projectRoot, outfile),
    format: 'iife',
    platform: 'neutral',
    define,
    minify,
    supported: babel === null ? {} : LOWERED,
    logLevel: 'silent',
    plugins: [plugin],
    ...(prelude !== null && { banner: { js: prelude } }),
    ...(sourcemap && { sourcemap: 'external' }),
  }
}

function metroGraph({
  entry,
  platform,
  esbuild,
  host = diskHost,
  projectRoot = process.cwd(),
  // (source, path) => source with Flow types stripped.
  stripFlow = null,
  // (source, path, without) => the project's Babel output, but for the plugins
  // of the keys in without.
  babel = null,
  // async (path) => the plugins of the project's Babel config for a file: a
  // Map of their keys to their options.
  babelPlugins = null,
  // (file, specifier) => the specifier an alias rewrites it to, or null.
  aliases = null,
  // Metro's transformer.assetRegistryPath: the project's react-native's where not given.
  assetRegistryPath = null,
  // Metro's resolver.assetExts: its defaults where not given.
  assetExts = defaults.assetExts,
  // Paths of the scripts to run first, as Metro's serializer.getPolyfills.
  polyfills = [],
  // Specifiers, from the entry, of the modules to run before it, as Metro's
  // serializer.getModulesRunBeforeMainModule: the project's react-native's
  // where not given.
  runBeforeMain = null,
  // Each file's map to its source, through Flow, esbuild and Babel.
  sourcemap = false,
  // Map<path, { contents, result }>: each file as it was last loaded, kept
  // while its contents are the same; for one set of the options above.
  cache = null,
}, { reuseFirst }) {
  const options = { esbuild, projectRoot, stripFlow, babel, babelPlugins, sourcemap }
  // A new resolver each build, which reads each package.json anew, and
  // counts it among the files the build read.
  const fresh = () => {
    const read = new Set()
    const resolveModule = createMetroResolver({ host: reading(host, read), assetExts })
    return { resolveModule, reactNative: reactNativeOf(resolveModule, host, resolve(projectRoot, entry), platform), graph: new Map(), assets: new Map(), resolved: new Set(), read }
  }
  let state = fresh()
  const before = () => runBeforeMain ?? state.reactNative.runBeforeMain
  const load = (path) => {
    state.read.add(path)
    return loadCached(options, host, cache, path)
  }
  // The files Metro resolved, which alone esbuild may load.
  const file = (path) => {
    state.resolved.add(path)
    return { path }
  }
  const plugin = {
    name: 'metro-graph',
    setup(build) {
      let reuse = reuseFirst
      build.onStart(() => {
        if (!reuse) state = fresh()
        reuse = false
      })
      build.onResolve({ filter: ANY }, ({ path: specifier, importer, kind, namespace }) => {
        if (kind === 'entry-point') return specifier === MAIN ? { path: host.realpath(resolve(projectRoot, entry)), namespace: MAIN } : file(host.realpath(resolve(projectRoot, specifier)))
        if (namespace === MAIN && specifier.startsWith(POLYFILL)) return { path: specifier.slice(POLYFILL.length), namespace: 'metro-polyfill' }
        if (namespace === MAIN && specifier === ENTRY) return file(importer)
        const resolution = state.resolveModule(importer, aliases?.(importer, specifier) ?? specifier, { platform, isESMImport: kind === 'import-statement' || kind === 'dynamic-import' })
        if (!state.graph.has(importer)) state.graph.set(importer, new Map())
        state.graph.get(importer).set(specifier, resolution)
        // Left to esbuild, which can't resolve it either: in a try block, an
        // optional dependency, as Metro takes one, which fails at run time;
        // else an error.
        if (resolution === null) return undefined
        if (resolution.type === 'empty') return { path: 'empty', namespace: 'metro-empty' }
        // Metro builds an asset into the module of its lowest path.
        if (resolution.type === 'assetFiles') return { path: resolution.filePaths.toSorted()[0], namespace: 'metro-asset' }
        return file(resolution.filePath)
      })
      build.onLoad({ filter: ANY, namespace: 'file' }, ({ path }) => {
        if (!state.resolved.has(path)) return { errors: [{ text: `esbuild resolved ${relative(projectRoot, path)} where Metro resolves nothing` }] }
        return load(path)
      })
      build.onLoad({ filter: ANY, namespace: 'metro-asset' }, ({ path }) => {
        const data = assetData(path, { urlPath: relative(projectRoot, path).replaceAll('\\', '/'), platform, host })
        state.assets.set(path, data)
        for (const asset of data.files) state.read.add(asset)
        return { contents: assetModule(data, assetRegistryPath ?? state.reactNative.assetRegistryPath), loader: 'js', resolveDir: dirname(path) }
      })
      build.onLoad({ filter: ANY, namespace: 'metro-empty' }, () => ({ contents: '', loader: 'js' }))
      serializer(build, { polyfills, before, projectRoot, load })
    },
  }
  const result = ({ outputFiles, warnings }) => ({
    outputFiles,
    warnings,
    assets: [...state.assets.keys()].toSorted().map((path) => state.assets.get(path)),
    graph: state.graph,
    files: [...state.read],
  })
  return { plugin, result, before, files: () => [...state.read] }
}

// The main module, and each polyfill, which is loaded as any file and run as
// a script.
function serializer(build, { polyfills, before, projectRoot, load }) {
  build.onLoad({ filter: ANY, namespace: MAIN }, () => {
    const specifiers = [...polyfills.map((path) => POLYFILL + path), ...before(), ENTRY]
    return { contents: specifiers.map((specifier) => `import ${JSON.stringify(specifier)}\n`).join(''), loader: 'js', resolveDir: projectRoot }
  })
  build.onLoad({ filter: ANY, namespace: 'metro-polyfill' }, async ({ path }) => {
    const loaded = await load(path)
    // On its first line, so that its lines stay where they are.
    return loaded.errors === undefined ? { ...loaded, contents: `(function (global) {${loaded.contents}\n})(${GLOBAL});\n`, resolveDir: dirname(path) } : loaded
  })
}

// The host, each file read through it added to `read`.
const reading = (host, read) => ({
  isFile: (path) => host.isFile(path),
  isDirectory: (path) => host.isDirectory(path),
  realpath: (path) => host.realpath(path),
  readdir: (path) => host.readdir(path),
  readFile: (path) => {
    read.add(path)
    return host.readFile(path)
  },
})

async function loadCached(options, host, cache, path) {
  const contents = decoder.decode(host.readFile(path))
  const hit = cache?.get(path)
  if (hit !== undefined && hit.contents === contents) return hit.result
  const result = await loadFile(options, path, contents)
  if (cache !== null && result.errors === undefined) cache.set(path, { contents, result })
  return result
}
