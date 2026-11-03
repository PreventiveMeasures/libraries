// Bundles with esbuild over the module graph Metro resolves for a platform, each asset built as
// Metro's asset module and each file read through the host. The layout is Metro's serializer's
// (serializer.js): the prelude, the polyfills, the modules run before the entry, then the entry.

import { dirname, relative, resolve } from 'node:path'

import { assetData, assetModule } from './assets.js'
import { defaults, diskHost } from './defaults.js'
import { aliasing } from './babel-aliases.js'
import { listing, lookingOnce, reading } from './build-host.js'
import { loadFile } from './load.js'
import { createMetroResolver } from './resolve.js'
import { reactNativeOf } from './serializer.js'

// Syntax Babel leaves, for esbuild to lower.
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
// Babel's output of a TS file is JS, which esbuild still loads as TS: keep each import, define fields.
const TS_AS_JS = { compilerOptions: { verbatimModuleSyntax: true, useDefineForClassFields: true } }
// Fails on bytes that aren't UTF-8 instead of decoding them to U+FFFD.
const decoder = new TextDecoder('utf-8', { fatal: true })
// eslint-disable-next-line require-unicode-regexp -- esbuild's filters are Go regexps, which take no `u`
export const ANY = /.*/
// The main module imports the polyfills, the modules run before the entry, then the entry.
const MAIN = 'metro-main'
const POLYFILL = 'metro-polyfill:'
const ENTRY = 'metro-entry:'
// The global object, as Metro passes it to a polyfill.
export const GLOBAL = "typeof globalThis !== 'undefined' ? globalThis : typeof global !== 'undefined' ? global : typeof window !== 'undefined' ? window : this"

export const posixRelative = (from, to) => relative(from, to).replaceAll('\\', '/')

// A file's text, or null where it isn't UTF-8.
export function utf8(bytes) {
  try {
    return decoder.decode(bytes)
  } catch {
    return null
  }
}

// esbuild's `supported`: where Babel lowers let and const (lowersLetOf()), esbuild must add none.
export const supportedOf = (babel, lowersLet) => (babel == null ? {} : { ...LOWERED, ...(lowersLet && { 'const-and-let': false }) })

// The result's `files` are those the build read or looked for.
export async function bundle(options) {
  const lowersLet = await lowersLetOf(options)
  const esm = options.esm === true ? new Set() : false
  // With `esm`, files loaded are kept for linking()'s rebuilds.
  const run = { ...options, esm, cache: options.cache ?? (esm === false ? null : new Map()) }
  return linking(run, async () => {
    // A graph per build, made first to know what runs before the entry.
    const graph = metroGraph(run, { reuseFirst: true })
    const main = graph.before().length > 0 || (options.polyfills?.length ?? 0) > 0
    return graph.result(await options.esbuild.build(buildOptions(options, graph, { main, lowersLet })))
  })
}

// bundle() on one esbuild context: each rebuild resolves and reads every file anew, but `cache`'s.
// With `esm`, `commonJs` is the Set of files left CommonJS, kept across rebuilds as `cache` is.
export async function createBundler(options) {
  const esm = options.esm === true ? (options.commonJs ?? new Set()) : false
  const run = { ...options, esm }
  const graph = metroGraph(run, { reuseFirst: false })
  const lowersLet = await lowersLetOf(options).catch(() => false)
  // Always through the main module, as what runs before the entry may change.
  const context = await options.esbuild.context(buildOptions(options, graph, { main: true, lowersLet }))
  return {
    // Throws as esbuild does, with the error's `files` those the build read or looked for.
    rebuild: async (onProgress = null) => {
      graph.progress.on = onProgress
      try {
        return await linking(run, async () => graph.result(await context.rebuild()))
      } catch (error) {
        if (error !== null && typeof error === 'object') error.files = graph.files()
        throw error
      }
    },
    dispose: () => context.dispose(),
  }
}

// Builds until esbuild links. With `esm`, a file it finds no matching export in is left CommonJS
// (the import undefined, as in Metro), with a warning, and the build is made again.
const FILE = new Set(['', 'file'])
async function linking({ esm, cache = null, projectRoot = process.cwd() }, build) {
  const warnings = []
  for (;;) {
    try {
      const result = await build()
      return { ...result, warnings: [...warnings, ...result.warnings.map(realMessage)] }
    } catch (error) {
      if (Array.isArray(error?.errors)) error.errors = error.errors.map(realMessage)
      const unlinked = esm === false ? [] : (error?.errors ?? []).filter(({ text, location }) => text.startsWith('No matching export in ') && FILE.has(location?.namespace) && !esm.has(resolve(projectRoot, location.file)))
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

// esbuild takes .mjs and .mts files for Node's ES modules whatever their code: `exports` unbound, and
// a default import of CommonJS the whole module.exports where Metro's (Babel's) interop takes
// exports.default. So esbuild gets them by another name, mapped back in messages and maps.
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

// Whether the entry's Babel config lowers let and const, as @react-native/babel-preset does for Hermes
// (whose don't bind per loop iteration). esbuild then adds none, its helpers having closures in
// `for (let ...)` loops, and fails on any left. Kept in `store` where given, sparing a later run the config.
export async function lowersLetOf({ babel = null, babelPlugins = null, host = diskHost, projectRoot = process.cwd(), entry, store = null }) {
  if (babel === null) return false
  const path = host.realpath(resolve(projectRoot, entry))
  const lowers = async () => (await babelPlugins?.(path))?.has('transform-block-scoping') === true
  return await (store === null ? lowers() : store.keep('lowers-let', path, lowers))
}

// keepNames: with `esm`, esbuild joins the ES modules in one scope, renaming clashes (`Text3`) and so
// their functions' `name`, which React shows; Babel's CommonJS keeps it. Not when minifying, as in Metro.
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
    supported: supportedOf(babel, lowersLet),
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
  stripFlow = null,
  // (source, path, without) => the project's Babel output (load.js).
  babel = null,
  // false, or the Set of files left CommonJS; the rest are ES modules esbuild links (load.js).
  esm = false,
  // Keep the config's plugins that have nothing to do (load.js).
  keepPlugins = false,
  // async (path) => a Map of the Babel config's plugins for a file to their options (load.js).
  babelPlugins = null,
  // (file, specifier) => the specifier an alias rewrites it to, or null.
  aliases = null,
  // Metro's transformer.assetRegistryPath; the project's react-native's where null.
  assetRegistryPath = null,
  assetExts = defaults.assetExts,
  // Metro's other resolver options, and its blockList: RegExps of files Metro doesn't see.
  resolver = {},
  blockList = null,
  // Metro's serializer.getPolyfills: paths of scripts to run first.
  polyfills = [],
  // Metro's serializer.getModulesRunBeforeMainModule; the project's react-native's where null.
  runBeforeMain = null,
  sourcemap = false,
  // Map<path, { contents, result }>: each file as last loaded, reused while its contents are the same.
  cache = null,
  // load-cache.js's store of loaded files, on disk across runs.
  store = null,
}, { reuseFirst }) {
  const options = { esbuild, projectRoot, stripFlow, babel, babelPlugins, sourcemap, esm, keepPlugins, store }
  let state = null
  let ahead = null
  const progress = { loaded: 0, on: null }
  const fresh = () => {
    ahead = readingAhead(host)
    newState({ host, assetExts, resolver, blockList, projectRoot, entry, platform }, (made) => {
      state = made
    })
  }
  // bundle() makes its state before the build, createBundler() as each build starts.
  if (reuseFirst) fresh()
  const before = () => runBeforeMain ?? state.reactNative.runBeforeMain
  const load = (path) => loadCached(options, ahead.hostOf(path, state.read), cache, path)
  // Only files Metro resolved may load.
  const file = (path) => {
    state.resolved.add(path)
    ahead.start(path)
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
          // Noted before it is found, so that a watcher sees a missing (deleted) entry made.
          const path = resolve(projectRoot, specifier === MAIN ? entry : specifier)
          state.read.add(path)
          return specifier === MAIN ? named(projectRoot, host.realpath(path), MAIN) : file(host.realpath(path))
        }
        if (namespace === MAIN && specifier.startsWith(POLYFILL)) return named(projectRoot, specifier.slice(POLYFILL.length), 'metro-polyfill')
        if (namespace === MAIN && specifier === ENTRY) return file(importer)
        const resolution = resolveImport(state, { importer, specifier, kind, aliases, platform, imports: pluginData?.imports, mapped: pluginData?.aliases })
        // Left to esbuild, which can't resolve it either: an error, but in a try block, where it is
        // an optional dependency, as Metro takes one, which fails at run time.
        if (resolution === null) return undefined
        if (resolution.type === 'empty') return { path: 'empty', namespace: 'metro-empty' }
        // Metro builds an asset into the module of its lowest path.
        if (resolution.type === 'assetFiles') return named(projectRoot, resolution.filePaths.toSorted()[0], 'metro-asset')
        return file(resolution.filePath)
      })
      build.onLoad({ filter: ANY, namespace: 'file' }, ({ path }) => loadResolved({ state, projectRoot, load, progress }, realPath(path)))
      build.onLoad({ filter: ANY, namespace: 'metro-asset' }, ({ path }) => {
        const asset = resolve(projectRoot, path)
        return { contents: assetSource(state, asset, { urlPath: path, platform, host, assetRegistryPath }), loader: 'js', resolveDir: dirname(asset) }
      })
      build.onLoad({ filter: ANY, namespace: 'metro-empty' }, () => ({ contents: '', loader: 'js' }))
      serializer(build, { polyfills, before, projectRoot, load })
    },
  }
  const result = ({ outputFiles, warnings }) => ({ outputFiles: outputFiles.map(realSources), warnings, assets: assetsOf(state), graph: state.graph, files: [...state.read] })
  return { plugin, result, before, files: () => [...(state?.read ?? [])], progress }
}

// Reads each file resolved off the main thread where the host can, while Babel transforms those before it.
// A failed read is retried by loadCached(), failing as the host does.
function readingAhead(host) {
  const ahead = new Map()
  return {
    start(path) {
      if (host.readFileAsync !== undefined && !ahead.has(path)) ahead.set(path, host.readFileAsync(path).catch(() => null))
    },
    // The host to load `path` by, noting what it reads in `read`.
    hostOf(path, read) {
      const bytes = ahead.get(path)
      // Kept as a key, so that a path resolved again once loaded isn't read again.
      ahead.set(path, undefined)
      const readAhead = () => {
        read.add(path)
        return bytes
      }
      return { ...reading(host, read), ...(bytes !== undefined && { readAhead }) }
    },
  }
}

// Loads a file Metro resolved, telling the progress of those loaded of those resolved.
async function loadResolved({ state, projectRoot, load, progress }, path) {
  if (!state.resolved.has(path)) return { errors: [{ text: `esbuild resolved ${relative(projectRoot, path)} where Metro resolves nothing` }] }
  try {
    return await load(path)
  } finally {
    progress.on?.(++progress.loaded, state.resolved.size)
  }
}

// The main module, and each polyfill, loaded as any file and run as a script.
function serializer(build, { polyfills, before, projectRoot, load }) {
  build.onLoad({ filter: ANY, namespace: MAIN }, () => {
    const specifiers = [...polyfills.map((path) => POLYFILL + path), ...before(), ENTRY]
    return { contents: specifiers.map((specifier) => `import ${JSON.stringify(specifier)}\n`).join(''), loader: 'js', resolveDir: projectRoot }
  })
  build.onLoad({ filter: ANY, namespace: 'metro-polyfill' }, async ({ path }) => {
    const file = resolve(projectRoot, path)
    const loaded = await load(file)
    if (loaded.errors !== undefined) return loaded
    // Opened on its first line, so that its lines stay where they are.
    return { ...loaded, contents: `(function (global) {${loaded.contents}\n})(${GLOBAL});\n`, resolveDir: dirname(file) }
  })
}

// An asset's module, as Metro builds it. The files it reads are noted even if that fails (an empty image).
export function assetSource(state, path, { urlPath, platform, host, assetRegistryPath }) {
  const data = assetData(path, { urlPath, platform, host: reading(host, state.read) })
  state.assets.set(path, data)
  return assetModule(data, assetRegistryPath ?? state.reactNative.assetRegistryPath)
}

export const assetsOf = (state) => [...state.assets.keys()].toSorted().map((path) => state.assets.get(path))

// Resolves an import of `importer`'s as Metro does, recording it in the state's graph; null where nothing.
// `imports`: the specifiers of the file's ES imports, which a require call Babel made of one resolves as.
// `mapped`: module-resolver's aliases Babel left (load.js), mapped as it maps them; else `aliases`.
export function resolveImport(state, { importer, specifier, kind, aliases, platform, imports = [], mapped = null }) {
  const isESMImport = kind === 'import-statement' || kind === 'dynamic-import' || (kind === 'require-call' && imports.includes(specifier))
  const map = mapped === null ? aliases : aliasing(mapped)
  const resolution = state.resolveModule(importer, map?.(importer, specifier) ?? specifier, { platform, isESMImport })
  if (!state.graph.has(importer)) state.graph.set(importer, new Map())
  state.graph.get(importer).set(specifier, resolution)
  return resolution
}

// A build's state, with a resolver that reads each package.json anew and notes each file it reads.
// Published before react-native's modules to run first are looked up, so the files read when that
// fails (a manifest of no JSON) are among the build's.
export function newState({ host, assetExts, resolver = {}, blockList = null, projectRoot, entry, platform }, publish) {
  const read = new Set()
  const resolveModule = metroResolverOf({ host: lookingOnce(reading(listing(host), read)), assetExts, resolver, blockList })
  const made = { resolveModule, reactNative: { runBeforeMain: [] }, graph: new Map(), assets: new Map(), resolved: new Set(), read }
  publish(made)
  publish({ ...made, reactNative: reactNativeOf(resolveModule, host, resolve(projectRoot, entry), platform) })
}

// Metro's resolver over the host, seeing no file `blockList` matches, as Metro's file map has none.
export function metroResolverOf({ host, assetExts, resolver = {}, blockList = null }) {
  const seen = blockList === null ? host : { ...host, isFile: (path) => !blockList.some((pattern) => pattern.test(path)) && host.isFile(path) }
  return createMetroResolver({ ...resolver, host: seen, assetExts })
}

// A path in one of this plugin's namespaces, which esbuild prints as is (in comments and module names):
// relative to the project, as esbuild prints a file's, so the bundle doesn't depend on where it is.
const named = (projectRoot, path, namespace) => ({ path: posixRelative(projectRoot, path), namespace })

// Loads a file with loadFile(): from `cache` while its contents are the same, else from options.store
// (load-cache.js's) by the options that shape it, kept there unless it failed or Babel said `uncacheable`.
// Its bytes are host.readAhead()'s where it has one. A file that isn't UTF-8 fails to load.
export async function loadCached(options, host, cache, path) {
  const contents = utf8((await host.readAhead?.()) ?? host.readFile(path))
  if (contents === null) return { errors: [{ text: 'Not UTF-8: the file has bytes UTF-8 has no character of', location: { file: posixRelative(options.projectRoot ?? process.cwd(), path) } }] }
  const { store = null, esm = false } = options
  const hit = cache?.get(path)
  if (hit !== undefined && hit.contents === contents) {
    store?.note('memory')
    return hit.result
  }
  const variant = [Boolean(options.sourcemap), esm === false ? null : esm.has(path), Boolean(options.keepPlugins)]
  const { key, why = null } = store === null ? { key: null } : await store.keyOf(path, contents, variant)
  const kept = key === null ? null : await store.get(key)
  const { uncacheable = false, ...result } = kept ?? (await loadFile(options, path, contents))
  if (kept === null && store !== null) {
    const unkept = result.errors === undefined ? (why ?? (uncacheable ? 'external' : null)) : 'failed'
    store.note('misses')
    if (unkept === null) store.set(key, result)
    else store.note('unkept', unkept)
  }
  if (cache !== null && result.errors === undefined) cache.set(path, { contents, result })
  return result
}
