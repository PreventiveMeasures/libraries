// Bundles with esbuild over the module graph Metro resolves for a platform, each asset built as
// Metro's asset module and each file read through the host. The layout is Metro's serializer's
// (serializer.js): the prelude, the polyfills, the modules run before the entry, then the entry.

import { dirname, relative, resolve } from 'node:path'

import { EMPTY, newState, posixRelative, resolutionOf } from './build-host.js'
import { defaults, diskHost } from './defaults.js'
import { unmatchedImports } from './esm-imports.js'
import { loadFile } from './load.js'
import { GLOBAL } from './serializer.js'

// Syntax Babel leaves, for esbuild to lower.
const LOWERED = Object.fromEntries(
  [
    'class-field',
    'class-private-accessor',
    'class-private-brand-check',
    'class-private-field',
    'class-private-method',
    'class-private-static-accessor',
    'class-private-static-field',
    'class-private-static-method',
    'class-static-blocks',
    'class-static-field',
    'import-attributes',
    'using',
  ].map((name) => [name, false]),
)
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

// A file's text, or null where it isn't UTF-8.
export function utf8(bytes) {
  try {
    return decoder.decode(bytes)
  } catch {
    return null
  }
}

// esbuild's `supported`: where Babel lowers let and const (lowersLetOf()), esbuild must add none.
export const supportedOf = (babel, lowersLet) => (babel === null ? {} : { ...LOWERED, ...(lowersLet && { 'const-and-let': false }) })

// The options of bundle(), createBundler() and createModuleBundler(), with their defaults. `esm` is false, or
// the Set of files left CommonJS (`commonJs`, kept across builds); the rest are ES modules esbuild links.
// `checkImports` checks the imports of ES modules where esbuild doesn't link them (esm-imports.js).
export function withDefaults(options) {
  const given = Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined))
  return {
    host: diskHost,
    stripFlow: null,
    // (source, path, without) => the project's Babel output; async (path) => a Map of its config's plugins
    // for a file to their options; with keepPlugins, those that have nothing to do kept (load.js).
    babel: null,
    babelPlugins: null,
    keepPlugins: false,
    // (file, specifier) => the specifier an alias rewrites it to, or null.
    aliases: null,
    // Metro's transformer.assetRegistryPath and serializer.getModulesRunBeforeMainModule, the project's
    // react-native's where null; serializer.getPolyfills, paths of scripts to run first.
    assetRegistryPath: null,
    runBeforeMain: null,
    polyfills: [],
    // Metro's resolver options, and its blockList: RegExps of files Metro doesn't see.
    assetExts: defaults.assetExts,
    resolver: {},
    blockList: null,
    // The bundle's.
    define: {},
    minify: false,
    sourcemap: false,
    prelude: null,
    // Map<path, { contents, result, at }>: each file as last loaded (of the build at `at`, a dev bundler's
    // version), reused while its contents are the same; and serve/load-cache.js's store of loaded files, on disk
    // across runs. changedAt(path): a dev bundler's version of the last change its watcher saw of the file,
    // or of a directory it is in.
    cache: null,
    store: null,
    changedAt: null,
    checkImports: false,
    ...given,
    esm: given.esm === true ? (given.commonJs ?? new Set()) : false,
  }
}

// The result's `files` are those the build read or looked for.
export async function bundle(options) {
  const run = withDefaults(options)
  // With `esm`, files loaded are kept for linking()'s builds again.
  if (run.esm !== false) run.cache ??= new Map()
  const lowersLet = await lowersLetOf(run)
  return linking(run, async () => {
    // Its state made first, to know what runs before the entry: through a main module only where something does.
    const state = newState(run)
    const graph = metroGraph(run, state)
    const main = run.polyfills.length > 0 || state.before.length > 0
    return graph.result(await run.esbuild.build(buildOptions(run, graph.plugin, main, lowersLet)))
  })
}

// bundle() on one esbuild context: each full rebuild resolves and reads every file anew, but `cache`'s; a
// watcher-caused one keeps the resolutions its changes leave (build-host.js's resolutionOf()), and takes
// each file `cache` has from it (trustedOf()).
export async function createBundler(options) {
  const run = withDefaults(options)
  run.resolution = resolutionOf(run)
  const graph = metroGraph(run)
  const lowersLet = await lowersLetOf(run).catch(() => false)
  // Always through the main module, as what runs before the entry may change.
  const context = await run.esbuild.context(buildOptions(run, graph.plugin, true, lowersLet))
  return {
    // Throws as esbuild does, with the error's `files` those the build read or looked for. `changes`, a
    // watcher's since the build before ({ path, event }); null, a full build. `at`, a dev bundler's version
    // of the build, its files read after each change of an earlier one.
    rebuild: (onProgress = null, changes = null, at = null) => {
      graph.onProgress = onProgress
      run.changes = changes
      run.trusted = changes !== null
      run.at = at
      return linking(run, async () => graph.result(await context.rebuild())).catch((error) => {
        throw Object.assign(error, { files: graph.files() })
      })
    },
    dispose: () => context.dispose(),
  }
}

// Builds until esbuild links. With `esm`, a file it finds no matching export in is left CommonJS
// (the import undefined, as in Metro), with a warning, and the build is made again.
const FILE = new Set(['', 'file'])
async function linking({ esm, cache, projectRoot }, build) {
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
export async function lowersLetOf({ babel, babelPlugins, host = diskHost, projectRoot, entry, store }) {
  if (babel === null) return false
  const path = host.realpath(resolve(projectRoot, entry))
  const lowers = async () => (await babelPlugins?.(path))?.has('transform-block-scoping') === true
  return await (store === null ? lowers() : store.keep('lowers-let', path, lowers))
}

// keepNames: with `esm`, esbuild joins the ES modules in one scope, renaming clashes (`Text3`) and so
// their functions' `name`, which React shows; Babel's CommonJS keeps it. Not when minifying, as in Metro.
function buildOptions({ entry, outfile, projectRoot, define, minify, babel, prelude, sourcemap, esm }, plugin, main, lowersLet) {
  return {
    entryPoints: [main ? MAIN : entry],
    absWorkingDir: projectRoot,
    outfile: resolve(projectRoot, outfile),
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'neutral',
    logLevel: 'silent',
    define,
    minify,
    ...(esm !== false && !minify && { keepNames: true }),
    supported: supportedOf(babel, lowersLet),
    plugins: [plugin],
    ...(babel !== null && { tsconfigRaw: TS_AS_JS }),
    ...(prelude !== null && { banner: { js: prelude } }),
    ...(sourcemap && { sourcemap: 'external' }),
  }
}

// The plugin resolving each import as Metro does, loading only the files Metro resolves. Each build makes
// its state as it starts, but the first where it is given; graph.onProgress(loaded, resolved) follows it.
function metroGraph(run, first = null) {
  const { host, projectRoot, entry, polyfills } = run
  let next = first
  let state = null
  let read = new Set()
  // Each file Metro resolved, which alone may load: read off the main thread where the host can, while Babel
  // transforms those before it. A read that failed is made again as it loads, failing as the host does.
  let resolved = new Map()
  let loaded = 0
  // Each ES module loaded, its imports and exports, for checkImports.
  let esModules = new Map()
  const file = (path) => {
    if (!resolved.has(path)) resolved.set(path, run.trusted && run.cache?.has(path) ? null : host.readFileAsync?.(path).catch(() => null))
    return { path: esbuildPath(path) }
  }
  const load = async (path) => {
    const bytes = resolved.get(path)
    if (bytes !== undefined) resolved.set(path, undefined)
    read.add(path)
    const source = await (trustedOf(run, path) ?? loadCached(run, path, (await bytes) ?? host.readFile(path)))
    if (source.pluginData?.module !== undefined) esModules.set(path, source.pluginData.module)
    return source
  }
  const setup = (build) => {
    build.onStart(() => {
      resolved = new Map()
      loaded = 0
      esModules = new Map()
      read = next?.read ?? new Set()
      // Taken as soon as it is made: where finding react-native's modules then fails, the build goes on with it.
      state = next ?? newState(run, read, (made) => (state = made))
      next = null
    })
    build.onResolve({ filter: ANY }, ({ path: specifier, importer: from, kind, namespace, pluginData }) => {
      if (kind === 'entry-point') {
        // Noted before it is found, so that a watcher sees a missing (deleted) entry made.
        const path = resolve(projectRoot, entry)
        read.add(path)
        return specifier === MAIN ? named(projectRoot, host.realpath(path), MAIN) : file(host.realpath(path))
      }
      const importer = namespace === 'file' ? realPath(from) : resolve(projectRoot, from)
      if (namespace === MAIN && specifier.startsWith(POLYFILL)) return named(projectRoot, specifier.slice(POLYFILL.length), 'metro-polyfill')
      if (namespace === MAIN && specifier === ENTRY) return file(importer)
      const found = state.resolveImport(importer, specifier, kind, pluginData)
      // Left to esbuild, which can't resolve it either: an error, but in a try block, where it is
      // an optional dependency, as Metro takes one, which fails at run time.
      if (found === null) return undefined
      if (found.kind === 'empty') return { path: 'empty', namespace: EMPTY }
      return found.kind === 'asset' ? named(projectRoot, found.key, 'metro-asset') : file(found.key)
    })
    build.onLoad({ filter: ANY, namespace: 'file' }, async ({ path: esbuilt }) => {
      const path = realPath(esbuilt)
      if (!resolved.has(path)) return { errors: [{ text: `esbuild resolved ${relative(projectRoot, path)} where Metro resolves nothing` }] }
      try {
        return await load(path)
      } finally {
        graph.onProgress?.(++loaded, resolved.size)
      }
    })
    build.onLoad({ filter: ANY, namespace: 'metro-asset' }, ({ path }) => {
      const asset = resolve(projectRoot, path)
      return { contents: state.assetSource(asset), loader: 'js', resolveDir: dirname(asset) }
    })
    build.onLoad({ filter: ANY, namespace: EMPTY }, () => ({ contents: '', loader: 'js' }))
    // The main module, and each polyfill, loaded as any file and run as a script.
    build.onLoad({ filter: ANY, namespace: MAIN }, () => {
      const specifiers = [...polyfills.map((path) => POLYFILL + path), ...state.before, ENTRY]
      return { contents: specifiers.map((specifier) => `import ${JSON.stringify(specifier)}\n`).join(''), loader: 'js', resolveDir: projectRoot }
    })
    build.onLoad({ filter: ANY, namespace: 'metro-polyfill' }, async ({ path }) => {
      const polyfill = resolve(projectRoot, path)
      const source = await load(polyfill)
      if (source.errors !== undefined) return source
      // Opened on its first line, so that its lines stay where they are.
      return { ...source, contents: `(function (global) {${source.contents}\n})(${GLOBAL});\n`, resolveDir: dirname(polyfill) }
    })
  }
  const graph = {
    onProgress: null,
    plugin: { name: 'metro-graph', setup },
    result: ({ outputFiles, warnings }) => ({ outputFiles: outputFiles.map(realSources), warnings: [...warnings, ...importWarnings(run, esModules, state.graph, run.esm !== false)], assets: state.assets(), graph: state.graph, files: [...read] }),
    files: () => [...read],
  }
  return graph
}

// With checkImports, each import of a name its ES module doesn't export, unless esbuild links the modules
// (`linked`), which tells it as linking() does.
export function importWarnings({ checkImports, projectRoot, host }, modules, graph, linked) {
  if (!checkImports || linked) return []
  const source = (path) => {
    try {
      return utf8(host.readFile(path))
    } catch {
      return null
    }
  }
  return unmatchedImports({ modules, graph, projectRoot, source })
}

// A path in one of this plugin's namespaces, which esbuild prints as is (in comments and module names):
// relative to the project, as esbuild prints a file's, so the bundle doesn't depend on where it is.
const named = (projectRoot, path, namespace) => ({ path: posixRelative(projectRoot, path), namespace })

// Of a watcher-caused build (options.trusted), a file as options.cache has it, unread: a change the watcher
// sees lets the file go from the cache (serve/dev-bundler.js's changed()). Not one a build read before a change
// of it the watcher saw (options.changedAt()): a load under way as it changes keeps what it read before.
// Else undefined, the file read.
export function trustedOf(options, path) {
  const hit = options.trusted ? options.cache?.get(path) : undefined
  const since = options.changedAt?.(path) ?? null
  if (hit === undefined || (since !== null && !(hit.at >= since))) return undefined
  options.store?.note('memory')
  return hit.result
}

// Loads a file of these bytes with loadFile(): from options.cache while its contents are the same, else from
// options.store (serve/load-cache.js's) by the options that shape it, kept there unless it failed or Babel said
// `uncacheable`. A file that isn't UTF-8 fails to load.
export async function loadCached(options, path, bytes) {
  const contents = utf8(bytes)
  if (contents === null) return { errors: [{ text: 'Not UTF-8: the file has bytes UTF-8 has no character of', location: { file: posixRelative(options.projectRoot, path) } }] }
  const { cache = null, store = null, esm = false } = options
  const hit = cache?.get(path)
  if (hit?.contents === contents) {
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
  if (result.errors === undefined) cache?.set(path, { contents, result, at: options.at ?? null })
  return result
}
