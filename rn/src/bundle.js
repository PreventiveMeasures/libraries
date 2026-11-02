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
export const LOWERED = {
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
// TS as Babel makes it JS, which esbuild loads as TS (load.js), read as the
// JS it is: each import kept, fields defined.
const TS_AS_JS = { compilerOptions: { verbatimModuleSyntax: true, useDefineForClassFields: true } }
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

// -> { outputFiles, warnings, assets: AssetData[], graph: Map<importer, Map<specifier, Resolution>>, files: string[] }:
// `files`, those the build read, and those the resolver looked for.
export async function bundle(options) {
  const lowersLet = await lowersLetOf(options)
  const esm = options.esm === true ? new Set() : false
  // Each file loaded, for a build made again (linking()).
  const cache = options.cache ?? (esm === false ? null : new Map())
  return linking({ ...options, esm, cache }, async () => {
    // Each build takes the state made to know what runs before the entry.
    const graph = metroGraph({ ...options, esm, cache }, { reuseFirst: true })
    const main = graph.before().length > 0 || (options.polyfills?.length ?? 0) > 0
    return graph.result(await options.esbuild.build(buildOptions(options, graph, { main, lowersLet })))
  })
}

// bundle(), to build again and again on one esbuild context: each build
// resolves and reads every file anew, but for `cache`'s.
// With `esm`, `commonJs`, the Set of files left CommonJS, where it is kept
// with `cache`.
export async function createBundler(options) {
  const esm = options.esm === true ? (options.commonJs ?? new Set()) : false
  const graph = metroGraph({ ...options, esm }, { reuseFirst: false })
  // Through the main module always, as what runs before the entry may change.
  const context = await options.esbuild.context(buildOptions(options, graph, { main: true, lowersLet: await lowersLetOf(options).catch(() => false) }))
  return {
    // Throws as esbuild does, the error's `files` those the build read and
    // looked for. onProgress(done, total), as each file Metro resolved loads.
    rebuild: async (onProgress = null) => {
      graph.progress.on = onProgress
      try {
        return await linking({ ...options, esm }, async () => graph.result(await context.rebuild()))
      } catch (error) {
        if (error !== null && typeof error === 'object') error.files = graph.files()
        throw error
      }
    },
    dispose: () => context.dispose(),
  }
}

// A build, made again while esbuild fails to link imports of what an ES
// module doesn't export: each file it finds one in is then left CommonJS
// (`esm`, a Set of them), the import undefined, as Metro has it; a warning
// of each.
// A file's namespace, as esbuild's messages have it.
const FILE = new Set(['', 'file'])
async function linking({ esm, cache = null, projectRoot = process.cwd() }, build) {
  const warnings = []
  for (;;) {
    try {
      const result = await build()
      return { ...result, warnings: [...warnings, ...result.warnings.map(realMessage)] }
    } catch (error) {
      if (Array.isArray(error?.errors)) error.errors = error.errors.map(realMessage)
      const unlinked = (esm === false ? [] : (error?.errors ?? [])).filter(({ text, location }) => text.startsWith('No matching export in ') && FILE.has(location?.namespace) && !esm.has(resolve(projectRoot, location.file)))
      if (unlinked.length === 0) throw error
      for (const message of unlinked) {
        const path = resolve(projectRoot, message.location.file)
        esm.add(path)
        cache?.delete(path)
        warnings.push({ ...message, text: `${message.text}: left CommonJS, as Metro has it, the import undefined` })
      }
    }
  }
}

// An .mjs or .mts file, as esbuild is given it: of a name with no module
// type of Node's, as Metro has none. esbuild takes one such for an ES module
// whatever its code, its `exports` unbound (Babel's CommonJS of it), and
// its default import of CommonJS the whole of `module.exports`, where
// Babel's interop, Metro's, takes `exports.default` of one that says it is
// an ES module. Named back as it is in messages and the map.
const esbuildPath = (path) => path.replace(/\.m([jt])s$/u, '.m$1s.rn.$1s')
const realPath = (path) => path.replace(/(\.m[jt]s)\.rn\.[jt]s$/u, '$1')
const realMessage = (message) => (message.location?.file === undefined ? message : { ...message, location: { ...message.location, file: realPath(message.location.file) } })
const encoder = new TextEncoder()
const realSources = (file) => {
  if (!file.path.endsWith('.map')) return file
  const map = JSON.parse(file.text)
  if (!map.sources.some((source) => realPath(source) !== source)) return file
  const text = JSON.stringify({ ...map, sources: map.sources.map(realPath) })
  return { path: file.path, text, contents: encoder.encode(text) }
}

// Where Babel's config lowers let and const, as @react-native/babel-preset
// does for Hermes, whose own don't bind each iteration of a loop apart,
// esbuild adds none after Babel: its helpers have `for (let key of ...)`,
// with a closure (__copyProps), which it then writes with var and bind;
// and fails on any left.
// Kept in `store` (load-cache.js's), where given: of the entry's config,
// which a run after then loads none of.
export async function lowersLetOf({ babel = null, babelPlugins = null, host = diskHost, projectRoot = process.cwd(), entry, store = null }) {
  if (babel === null) return false
  const path = host.realpath(resolve(projectRoot, entry))
  const lowers = async () => (await babelPlugins?.(path))?.has('transform-block-scoping') === true
  return await (store === null ? lowers() : store.keep('lowers-let', path, lowers))
}

// With `esm`, esbuild joins the ES modules in one scope, a name two of them
// declare renamed in one (`Text3`), and with it its function's `name`, which
// React shows (its warnings, DevTools); in CommonJS, each its own, Babel's
// keeps it. esbuild then keeps each function's name, as Babel's does: but
// where it minifies, which takes them away from both, as Metro's does.
function buildOptions({ entry, outfile, projectRoot = process.cwd(), define = {}, minify = false, babel = null, prelude = null, sourcemap = false, esm = false }, { plugin }, { main, lowersLet }) {
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
    ...(esm === true && !minify && { keepNames: true }),
    supported: babel === null ? {} : { ...LOWERED, ...(lowersLet && { 'const-and-let': false }) },
    logLevel: 'silent',
    plugins: [plugin],
    ...(babel !== null && { tsconfigRaw: TS_AS_JS }),
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
  // of the keys in without, or { code, imports }, with the specifiers of the
  // file's imports; with `esm`, a Set of the files left CommonJS, the rest ES
  // modules, which esbuild links (load.js).
  babel = null,
  esm = false,
  // With babel: none of the config's plugins left out for having nothing to do (load.js).
  keepPlugins = false,
  // async (path) => the plugins of the project's Babel config for a file: a
  // Map of their keys to their options, or, for a key of more than one
  // plugin, to { instances }, the options of each.
  babelPlugins = null,
  // (file, specifier) => the specifier an alias rewrites it to, or null.
  aliases = null,
  // Metro's transformer.assetRegistryPath: the project's react-native's where not given.
  assetRegistryPath = null,
  // Metro's resolver.assetExts: its defaults where not given.
  assetExts = defaults.assetExts,
  // Metro's other resolver options, as createMetroResolver takes them; and
  // its blockList, RegExps of the files it sees none of.
  resolver = {},
  blockList = null,
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
  // Each file as it loads, on disk, across runs, of the options above:
  // load-cache.js's, of a target (loadCached()).
  store = null,
}, { reuseFirst }) {
  const options = { esbuild, projectRoot, stripFlow, babel, babelPlugins, sourcemap, esm, keepPlugins, store }
  let state = null
  // The files loaded, of those resolved, and to whom it is told.
  const progress = { loaded: 0, on: null }
  const fresh = () => newState({ host, assetExts, resolver, blockList, projectRoot, entry, platform }, (made) => {
    state = made
  })
  // bundle()'s, made before its build; createBundler()'s, as each starts.
  if (reuseFirst) fresh()
  const before = () => runBeforeMain ?? state.reactNative.runBeforeMain
  const load = (path) => loadCached(options, reading(host, state.read), cache, path)
  // The files Metro resolved, which alone esbuild may load.
  const file = (path) => {
    state.resolved.add(path)
    return { path: esbuildPath(path) }
  }
  const plugin = {
    name: 'metro-graph',
    setup(build) {
      let reuse = reuseFirst
      build.onStart(() => {
        if (!reuse) fresh()
        reuse = false
        progress.loaded = 0
      })
      build.onResolve({ filter: ANY }, ({ path: specifier, importer: from, kind, namespace, pluginData }) => {
        const importer = namespace === 'file' ? realPath(from) : resolve(projectRoot, from)
        if (kind === 'entry-point') {
          // Looked for before it is found: an entry not there (deleted) is a file a watcher sees made.
          const path = resolve(projectRoot, specifier === MAIN ? entry : specifier)
          state.read.add(path)
          return specifier === MAIN ? named(projectRoot, host.realpath(path), MAIN) : file(host.realpath(path))
        }
        if (namespace === MAIN && specifier.startsWith(POLYFILL)) return named(projectRoot, specifier.slice(POLYFILL.length), 'metro-polyfill')
        if (namespace === MAIN && specifier === ENTRY) return file(importer)
        const resolution = resolveImport(state, { importer, specifier, kind, aliases, platform, imports: pluginData?.imports })
        // Left to esbuild, which can't resolve it either: in a try block, an
        // optional dependency, as Metro takes one, which fails at run time;
        // else an error.
        if (resolution === null) return undefined
        if (resolution.type === 'empty') return { path: 'empty', namespace: 'metro-empty' }
        // Metro builds an asset into the module of its lowest path.
        if (resolution.type === 'assetFiles') return named(projectRoot, resolution.filePaths.toSorted()[0], 'metro-asset')
        return file(resolution.filePath)
      })
      build.onLoad({ filter: ANY, namespace: 'file' }, ({ path }) => loadResolved({ state, projectRoot, load, progress }, realPath(path)))
      build.onLoad({ filter: ANY, namespace: 'metro-asset' }, ({ path }) => {
        const asset = resolve(projectRoot, path)
        // Each file it reads counted, though building it fails (an empty image).
        const data = assetData(asset, { urlPath: path, platform, host: reading(host, state.read) })
        state.assets.set(asset, data)
        return { contents: assetModule(data, assetRegistryPath ?? state.reactNative.assetRegistryPath), loader: 'js', resolveDir: dirname(asset) }
      })
      build.onLoad({ filter: ANY, namespace: 'metro-empty' }, () => ({ contents: '', loader: 'js' }))
      serializer(build, { polyfills, before, projectRoot, load })
    },
  }
  const result = ({ outputFiles, warnings }) => ({
    outputFiles: outputFiles.map(realSources),
    warnings,
    assets: [...state.assets.keys()].toSorted().map((path) => state.assets.get(path)),
    graph: state.graph,
    files: [...state.read],
  })
  return { plugin, result, before, files: () => [...(state?.read ?? [])], progress }
}

// A file Metro resolved, loaded; the progress of those loaded, of those
// resolved, told.
async function loadResolved({ state, projectRoot, load, progress }, path) {
  if (!state.resolved.has(path)) return { errors: [{ text: `esbuild resolved ${relative(projectRoot, path)} where Metro resolves nothing` }] }
  try {
    return await load(path)
  } finally {
    progress.on?.(++progress.loaded, state.resolved.size)
  }
}

// The main module, and each polyfill, which is loaded as any file and run as
// a script.
function serializer(build, { polyfills, before, projectRoot, load }) {
  build.onLoad({ filter: ANY, namespace: MAIN }, () => {
    const specifiers = [...polyfills.map((path) => POLYFILL + path), ...before(), ENTRY]
    return { contents: specifiers.map((specifier) => `import ${JSON.stringify(specifier)}\n`).join(''), loader: 'js', resolveDir: projectRoot }
  })
  build.onLoad({ filter: ANY, namespace: 'metro-polyfill' }, async ({ path }) => {
    const file = resolve(projectRoot, path)
    const loaded = await load(file)
    // On its first line, so that its lines stay where they are.
    return loaded.errors === undefined ? { ...loaded, contents: `(function (global) {${loaded.contents}\n})(${GLOBAL});\n`, resolveDir: dirname(file) } : loaded
  })
}

// What an import of `importer`'s resolves to, as Metro resolves it, put in
// the state's graph: null where nothing. `imports`, the specifiers of the
// file's imports, as its Babel output has them (load.js): a require call Babel
// made of one resolves as an ESM import, as Metro resolves it.
export function resolveImport(state, { importer, specifier, kind, aliases, platform, imports = [] }) {
  const isESMImport = kind === 'import-statement' || kind === 'dynamic-import' || (kind === 'require-call' && imports.includes(specifier))
  const resolution = state.resolveModule(importer, aliases?.(importer, specifier) ?? specifier, { platform, isESMImport })
  if (!state.graph.has(importer)) state.graph.set(importer, new Map())
  state.graph.get(importer).set(specifier, resolution)
  return resolution
}

// A build's state, given to `publish`: a new resolver, which reads each
// package.json anew and counts each file it reads; given before what of
// react-native runs before the entry is found, so that a manifest that fails
// it (no JSON) is among the build's files.
export function newState({ host, assetExts, resolver = {}, blockList = null, projectRoot, entry, platform }, publish) {
  const read = new Set()
  const resolveModule = metroResolverOf({ host: lookingOnce(reading(host, read)), assetExts, resolver, blockList })
  const made = { resolveModule, reactNative: { runBeforeMain: [] }, graph: new Map(), assets: new Map(), resolved: new Set(), read }
  publish(made)
  publish({ ...made, reactNative: reactNativeOf(resolveModule, host, resolve(projectRoot, entry), platform) })
}

// Metro's resolver over the host, as Metro's config has it: its options, and
// no file `blockList` matches, as Metro's file map has none of them.
export function metroResolverOf({ host, assetExts, resolver = {}, blockList = null }) {
  const blocked = (path) => blockList !== null && blockList.some((pattern) => pattern.test(path))
  const seen = blockList === null ? host : { ...host, isFile: (path) => !blocked(path) && host.isFile(path) }
  return createMetroResolver({ ...resolver, host: seen, assetExts })
}

// A path in a namespace of this plugin's, which esbuild prints as it is (in
// comments, and as a module's name), made relative to the project, as
// esbuild prints a file's, so that the bundle doesn't depend on where the
// project is; absolute, it is the path itself.
const named = (projectRoot, path, namespace) => ({ path: relative(projectRoot, path).replaceAll('\\', '/'), namespace })

// The host, each file read or looked for through it added to `read`: a
// file not there yet (an import written before its module) is a file a
// watcher sees made.
const look = (read, path, found) => {
  read.add(path)
  return found
}
export const reading = (host, read) => ({
  isFile: (path) => look(read, path, host.isFile(path)),
  isDirectory: (path) => look(read, path, host.isDirectory(path)),
  realpath: (path) => host.realpath(path),
  readdir: (path) => host.readdir(path),
  readFile: (path) => {
    read.add(path)
    return host.readFile(path)
  },
})

// The host, each path's isFile, isDirectory and realpath looked up once:
// Metro's resolver (metro-resolver's own too, as its fileSystemLookup) looks
// up each spelling of a module (each platform and extension), and each
// directory up to its package.json, of each import, as a build's files,
// which it reads anew, don't change in it; as Metro's file map has them,
// not from the disk at each import.
export function lookingOnce(host) {
  const known = { isFile: new Map(), isDirectory: new Map(), realpath: new Map() }
  const once = (name) => (path) => {
    const map = known[name]
    if (!map.has(path)) map.set(path, host[name](path))
    return map.get(path)
  }
  return { ...host, isFile: once('isFile'), isDirectory: once('isDirectory'), realpath: once('realpath') }
}

// A file as loadFile() loads it: as `cache` has it while its contents are
// the same; else as options.store (load-cache.js's) has it, of the options
// that make it (sourcemap, esm, keepPlugins), where it does, kept there
// where it doesn't; but none failed, nor one of Babel's `uncacheable`.
export async function loadCached(options, host, cache, path) {
  const contents = decoder.decode(host.readFile(path))
  const hit = cache?.get(path)
  if (hit !== undefined && hit.contents === contents) return hit.result
  const { store = null, esm = false } = options
  const variant = [Boolean(options.sourcemap), esm === false ? null : esm.has(path), Boolean(options.keepPlugins)]
  const key = store === null ? null : await store.keyOf(path, contents, variant)
  const kept = key === null ? null : store.get(key)
  const { uncacheable = false, ...result } = kept ?? (await loadFile(options, path, contents))
  if (kept === null && key !== null && !uncacheable && result.errors === undefined) store.set(key, result)
  if (cache !== null && result.errors === undefined) cache.set(path, { contents, result })
  return result
}
