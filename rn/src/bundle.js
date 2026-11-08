// Bundles with esbuild over the module graph Metro resolves, in the layout of Metro's serializer
// (serializer.js): the prelude, the polyfills, the modules run before the entry, then the entry.

import { dirname, relative, resolve } from 'node:path'

import { ASSET, EMPTY, newState, posixRelative } from './build-host.js'
import { defaults, diskHost } from './defaults.js'
import { unmatchedImports } from './esm-imports.js'
import { jsval } from './jsval.js'
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
export const TS_AS_JS = { compilerOptions: { verbatimModuleSyntax: true, useDefineForClassFields: true } }
// Fails on bytes that aren't UTF-8 instead of decoding them to U+FFFD.
const decoder = new TextDecoder('utf-8', { fatal: true })
// eslint-disable-next-line require-unicode-regexp -- esbuild's filters are Go regexps, which take no `u`
export const ANY = /.*/
const MAIN = 'metro-main'
const POLYFILL = 'metro-polyfill:'
const ENTRY = 'metro-entry:'

export function utf8(bytes) {
  try {
    return decoder.decode(bytes)
  } catch {
    return null
  }
}

// Syntax esbuild must not emit when the Babel config lowers it: let and const (lowered for Hermes, which
// doesn't bind them per loop iteration, while esbuild's helpers use them in loops), and async functions,
// generators and for await, which a plugin run after the config's may add.
const BABEL_LOWERS = {
  'transform-block-scoping': { 'const-and-let': false },
  'transform-async-to-generator': { 'async-await': false },
  'transform-async-generator-functions': { 'async-generator': false, 'for-await': false },
}

// esbuild's `supported`: LOWERED, and what the entry's Babel config lowers (loweredOf()).
export const supportedOf = (babel, lowered) => (babel === null ? {} : { ...LOWERED, ...lowered })

// The options of bundle() and rn-serve's bundlers, with defaults. `esm` becomes false or the Set of files left
// CommonJS (`commonJs`, kept across builds).
export function withDefaults(options) {
  const given = Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined))
  return {
    host: diskHost,
    stripFlow: null,
    // babel(source, path, without) runs the project's Babel config; babelPlugins(path) maps its plugins to options.
    babel: null,
    babelPlugins: null,
    keepPlugins: false,
    // (file, specifier) => the specifier an alias rewrites it to, or null.
    aliases: null,
    // Metro's assetRegistryPath and getModulesRunBeforeMainModule (react-native's where null), and getPolyfills'.
    assetRegistryPath: null,
    runBeforeMain: null,
    polyfills: [],
    // Metro's resolver options, and its blockList: RegExps of files Metro doesn't see.
    assetExts: defaults.assetExts,
    resolver: {},
    blockList: null,
    define: {},
    minify: false,
    sourcemap: false,
    prelude: null,
    // cache: Map<path, { contents, result, at }>, reused while a file is unchanged; store: rn-serve's on-disk
    // load cache; kept(path): a load result to reuse without reading the file, else undefined.
    cache: null,
    store: null,
    kept: null,
    checkImports: false,
    // (path) => the errors of rn.config.json's restrictions of a file the build takes (restrictions.js), or null.
    restrict: null,
    ...given,
    esm: given.esm === true ? (given.commonJs ?? new Set()) : false,
  }
}

// The result's `files` are those the build read or looked for.
export async function bundle(options) {
  const run = withDefaults(options)
  // With `esm`, linking() may build again: keep what was loaded.
  if (run.esm !== false) run.cache ??= new Map()
  const lowered = await loweredOf(run)
  return linking(run, async () => {
    // State first, to know whether anything runs before the entry, which needs a main module.
    const state = newState(run)
    const graph = metroGraph(run, state)
    const main = run.polyfills.length > 0 || state.before.length > 0
    return graph.result(await run.esbuild.build(buildOptions(run, graph.plugin, main, lowered)))
  })
}

// Builds until esbuild links. With `esm`, a file it finds no matching export in is left CommonJS
// (the import undefined, as in Metro), with a warning, and the build is made again.
const FILE = new Set(['', 'file'])
export async function linking({ esm, cache, projectRoot }, build) {
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

// esbuild treats .mjs/.mts as Node's ES modules whatever their code (a default import of CommonJS is all of
// module.exports, not Babel's exports.default), so they're renamed for it and mapped back in messages and maps.
export const esbuildPath = (path) => path.replace(/\.m([jt])s$/u, '.m$1s.rn.$1s')
export const realPath = (path) => path.replace(/(\.m[jt]s)\.rn\.[jt]s$/u, '$1')
const realMessage = (message) => (message.location?.file === undefined ? message : { ...message, location: { ...message.location, file: realPath(message.location.file) } })
const encoder = new TextEncoder()
const realSources = (file) => {
  if (!file.path.endsWith('.map')) return file
  const map = JSON.parse(file.text)
  if (!map.sources.some((source) => realPath(source) !== source)) return file
  const text = JSON.stringify({ ...map, sources: map.sources.map(realPath) })
  return { path: file.path, text, contents: encoder.encode(text) }
}

// loweredAt() of the entry, kept in `store` if given to spare a later run loading the config.
export async function loweredOf({ babel, babelPlugins, host = diskHost, projectRoot, entry, store }) {
  if (babel === null) return {}
  const path = host.realpath(resolve(projectRoot, entry))
  const lowered = () => loweredAt(babelPlugins, path)
  return await (store === null ? lowered() : store.keep('lowered', path, lowered))
}

// esbuild's `supported` for what the Babel config of `path` lowers (BABEL_LOWERS).
export async function loweredAt(babelPlugins, path) {
  const plugins = (await babelPlugins?.(path)) ?? new Map()
  return Object.assign({}, ...Object.entries(BABEL_LOWERS).flatMap(([key, features]) => (plugins.has(key) ? [features] : [])))
}

// keepNames: with `esm`, esbuild joins the ES modules in one scope, renaming clashes (`Text3`) and so
// their functions' `name`, which React shows; Babel's CommonJS keeps it. Not when minifying, as in Metro.
export function buildOptions({ entry, outfile, projectRoot, define, minify, babel, prelude, sourcemap, esm }, plugin, main, lowered) {
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
    supported: supportedOf(babel, lowered),
    plugins: [plugin],
    ...(babel !== null && { tsconfigRaw: TS_AS_JS }),
    ...(prelude !== null && { banner: { js: prelude } }),
    ...(sourcemap && { sourcemap: 'external' }),
  }
}

// The esbuild plugin resolving imports as Metro does, loading only what Metro resolves. Each build makes its
// state as it starts, except the first if given; graph.onProgress(loaded, resolved) reports progress.
export function metroGraph(run, first = null) {
  const { host, projectRoot, entry, polyfills } = run
  let next = first
  let state = null
  let read = new Set()
  // The files Metro resolved, read ahead off the main thread where the host can. A failed read is retried
  // on load, to fail as the host does.
  let resolved = new Map()
  let loaded = 0
  // ES modules' imports and exports, for checkImports.
  let esModules = new Map()
  const file = (path) => {
    if (!resolved.has(path)) resolved.set(path, run.kept?.(path) === undefined ? host.readFileAsync?.(path).catch(() => null) : null)
    return { path: esbuildPath(path) }
  }
  const load = async (path) => {
    const bytes = resolved.get(path)
    if (bytes !== undefined) resolved.set(path, undefined)
    read.add(path)
    const kept = run.kept?.(path)
    if (kept !== undefined) run.store?.note('memory')
    const source = await (kept ?? loadCached(run, path, (await bytes) ?? host.readFile(path)))
    if (source.pluginData?.module !== undefined) esModules.set(path, source.pluginData.module)
    return source
  }
  const setup = (build) => {
    build.onStart(() => {
      resolved = new Map()
      loaded = 0
      esModules = new Map()
      read = next?.read ?? new Set()
      // Taken as soon as it is made, so the build goes on if finding react-native's modules then fails.
      state = next ?? newState(run, read, (made) => (state = made))
      next = null
    })
    build.onResolve({ filter: ANY }, ({ path: specifier, importer: from, kind, namespace, pluginData }) => {
      if (kind === 'entry-point') {
        // Noted before the lookup, so a watcher sees a deleted entry made again.
        const path = resolve(projectRoot, entry)
        read.add(path)
        const real = host.realpath(path)
        return taken(state, { kind: 'file', key: real }, () => (specifier === MAIN ? named(projectRoot, real, MAIN) : file(real)))
      }
      const importer = namespace === 'file' ? realPath(from) : resolve(projectRoot, from)
      if (namespace === MAIN && specifier.startsWith(POLYFILL)) {
        const polyfill = specifier.slice(POLYFILL.length)
        return taken(state, state.fileOf(polyfill), () => named(projectRoot, polyfill, 'metro-polyfill'))
      }
      if (namespace === MAIN && specifier === ENTRY) return file(importer)
      const found = state.resolveImport(importer, specifier, kind, pluginData)
      return taken(state, found, () => resolvedAs(projectRoot, found, file))
    })
    build.onLoad({ filter: ANY, namespace: 'file' }, async ({ path: esbuilt }) => {
      const path = realPath(esbuilt)
      if (!resolved.has(path)) return notResolved(projectRoot, path)
      try {
        return await load(path)
      } finally {
        graph.onProgress?.(++loaded, resolved.size)
      }
    })
    build.onLoad({ filter: ANY, namespace: ASSET }, ({ path }) => assetLoaded(projectRoot, path, state.assetSource))
    build.onLoad({ filter: ANY, namespace: EMPTY }, () => ({ contents: '', loader: 'js' }))
    build.onLoad({ filter: ANY, namespace: MAIN }, () => {
      const specifiers = [...polyfills.map((path) => POLYFILL + path), ...state.before, ENTRY]
      return { contents: specifiers.map((specifier) => `import ${jsval(specifier)}\n`).join(''), loader: 'js', resolveDir: projectRoot }
    })
    build.onLoad({ filter: ANY, namespace: 'metro-polyfill' }, async ({ path }) => {
      const polyfill = resolve(projectRoot, path)
      const source = await load(polyfill)
      if (source.errors !== undefined) return source
      // Run as a script. The wrapper opens on its first line, so its lines stay where they are.
      return { ...source, contents: `(function (global) {${source.contents}\n})(${GLOBAL});\n`, resolveDir: dirname(polyfill) }
    })
  }
  const graph = {
    onProgress: null,
    plugin: { name: 'metro-graph', setup },
    // Only renamed inputs need their map paths restored. Otherwise leave the potentially large map
    // unread: rn-bundle's serializer will parse it when writing Metro's source paths.
    result: ({ outputFiles, warnings }) => ({ outputFiles: run.sourcemap && resolved.keys().some((path) => esbuildPath(path) !== path) ? outputFiles.map(realSources) : outputFiles, warnings: [...warnings, ...importWarnings(run, esModules, state.graph, run.esm !== false)], assets: state.assets(), graph: state.graph, files: [...read] }),
    files: () => [...read],
  }
  return graph
}

// With checkImports, warnings of imports of names not exported, unless esbuild links the modules and
// reports them itself.
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

// esbuild prints a namespaced path as is (in comments and module names): relative to the project, the
// bundle doesn't depend on where the project is.
const named = (projectRoot, path, namespace) => ({ path: posixRelative(projectRoot, path), namespace })

// onResolve's result for resolvedModule()'s module. Where Metro resolves nothing, esbuild fails to as well:
// an error, unless the import is in a try block, an optional dependency as in Metro.
export function resolvedAs(projectRoot, found, file) {
  if (found === null) return undefined
  if (found.kind === 'empty') return { path: 'empty', namespace: EMPTY }
  return found.kind === 'asset' ? named(projectRoot, found.key, ASSET) : file(found.key)
}

// as(), or the errors where rn.config.json's restrictions forbid any of the module's files.
function taken(state, found, as) {
  const errors = state.forbidden(found)
  return errors.length === 0 ? as() : { errors: errors.map((text) => ({ text })) }
}

// The onLoad of a file esbuild resolved where Metro resolves nothing (resolvedAs() left it to esbuild).
export const notResolved = (projectRoot, path) => ({ errors: [{ text: `esbuild resolved ${relative(projectRoot, path)} where Metro resolves nothing` }] })

export function assetLoaded(projectRoot, path, assetSource) {
  const asset = resolve(projectRoot, path)
  return { contents: assetSource(asset), loader: 'js', resolveDir: dirname(asset) }
}

// loadFile() through options.cache while the contents are the same, then options.store, which keeps the
// result unless it failed or is `uncacheable`. A file that isn't UTF-8 fails to load.
export async function loadCached(options, path, bytes) {
  const contents = utf8(bytes)
  if (contents === null) return { errors: [{ text: 'Not UTF-8: the file has bytes UTF-8 has no character of', location: { file: posixRelative(options.projectRoot, path) } }] }
  const { cache, store = null, esm = false } = options
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
    if (unkept === null) {
      store.set(key, result)
    } else {
      store.note('unkept', unkept)
    }
  }
  if (result.errors === undefined) cache?.set(path, { contents, result, at: options.at ?? null })
  return result
}
