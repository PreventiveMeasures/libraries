// A dev server's bundle in Metro's module format, for Fast Refresh: each
// module its own `__d(factory, id, dependencyMap, name)`, after Metro's
// prelude, metro-runtime's require and the polyfills, then `__r` of each
// module to run before the entry and of the entry, as Metro's serializer
// (baseJSBundle, wrapModule) writes them for metro-runtime's require (MIT,
// Copyright (c) Meta Platforms, Inc. and affiliates); an update defines a
// module anew. Each module is built by esbuild alone, as CommonJS, each of
// its imports a require() left as it is, resolved as Metro resolves it (as
// bundle() resolves it), each module's build kept while its source is the
// same. A require of what resolves to nothing is an error, but in a try
// block, as esbuild takes it: an optional dependency, which fails at run time.

import { dirname, relative, resolve } from 'node:path'

import { assetData, assetModule } from './assets.js'
import { LOWERED, loadCached, lowersLetOf, newState, reading, resolveImport } from './bundle.js'
import { defaults, diskHost } from './defaults.js'
import { concatMaps, pieceOf } from './mappings.js'

// eslint-disable-next-line require-unicode-regexp -- esbuild's filters are Go regexps, which take no `u`
const ANY = /.*/
const FACTORY = 'function (global, _$$_REQUIRE, _$$_IMPORT_DEFAULT, _$$_IMPORT_ALL, module, exports, _dependencyMap)'
const GLOBAL = "typeof globalThis !== 'undefined' ? globalThis : typeof global !== 'undefined' ? global : typeof window !== 'undefined' ? window : this"
// The module an import Metro resolves to an empty module is.
export const EMPTY = 'metro-empty'
const OUTFILE = 'rn-serve.module.js'
const lineCount = (text) => {
  let count = 0
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) count++
  return count
}
const nameOf = (projectRoot, key) => (key === EMPTY ? EMPTY : relative(projectRoot, key).replaceAll('\\', '/'))

// -> { rebuild(), dispose() }, as createBundler's; rebuild() -> { js, map,
// modules, entryId, scripts, assets, files }, or throws as esbuild does, the error's
// `errors` esbuild's and `files` those read. `modules`: Map<id, { id, key,
// name, deps, factory }>, `deps` the ids of its dependency map. `ids`:
// Map<key, id> of each module's id, a file's by its path, kept from build to
// build; `cache`: Map<path, { contents, result }> as bundle()'s; `builds`,
// Map<key, { contents, loader, built }> of each module's build. `runtime`:
// metro-runtime's require.js.
export function createModuleBundler(options) {
  const { entry, platform, projectRoot, host = diskHost, assetExts = defaults.assetExts, polyfills = [], runtime, prelude = null, ids = new Map(), builds = new Map() } = options
  const supportedOf = lowersLetOf(options).then(
    (lowersLet) => (options.babel ? { ...LOWERED, ...(lowersLet && { 'const-and-let': false }) } : {}),
    () => (options.babel ? LOWERED : {}),
  )
  const idOf = (key) => {
    if (!ids.has(key)) ids.set(key, ids.size)
    return ids.get(key)
  }
  return {
    async rebuild() {
      const run = { ...options, stripFlow: options.stripFlow ?? null, babel: options.babel ?? null, babelPlugins: options.babelPlugins ?? null, aliases: options.aliases ?? null, host, assetExts, supported: { ...(await supportedOf), 'dynamic-import': false }, idOf, builds }
      let state = null
      try {
        // Its state published before what of react-native runs before the
        // entry is found, which reads manifests a failure is of.
        newState({ host, assetExts, projectRoot, entry, platform }, (made) => {
          state = made
        })
        return await graphOf(run, state, { scripts: [runtime, ...polyfills], prelude })
      } catch (error) {
        if (!Array.isArray(error?.errors)) throw Object.assign(new Error(error?.message ?? String(error)), { errors: [{ text: error?.message ?? String(error), location: null }], files: [...state.read] })
        if (error !== null && typeof error === 'object') error.files = [...state.read]
        throw error
      }
    },
    dispose: async () => {},
  }
}

// Each module from the entry, and each script, built; then the bundle.
async function graphOf(run, state, { scripts, prelude }) {
  const { projectRoot, entry } = run
  const entryPath = resolve(projectRoot, entry)
  state.read.add(entryPath)
  const pending = new Map()
  const errors = []
  const fail = (key) => (error) => {
    errors.push(...errorsOf(error, key, projectRoot))
    return null
  }
  // A module by its key, once: `kind` 'file', 'asset' or 'empty'.
  const visit = ({ key, kind }) => {
    if (!pending.has(key)) pending.set(key, moduleOf(run, state, { key, kind }, visit).catch(fail(key)))
  }
  let entryKey
  try {
    entryKey = run.host.realpath(entryPath)
  } catch {
    throw Object.assign(new Error('no entry'), { errors: [{ text: `Could not resolve "${entry}"`, location: null }] })
  }
  visit({ key: entryKey, kind: 'file' })
  const before = state.reactNative.runBeforeMain.map((specifier) => moduleOfResolution(resolveImport(state, { importer: entryKey, specifier, kind: 'import-statement', aliases: run.aliases, platform: run.platform }))).filter((found) => found !== null)
  for (const found of before) visit(found)
  const scriptsBuilt = Promise.all(scripts.map((path) => scriptOf(run, state, path).catch(fail(path))))
  let size = 0
  while (size !== pending.size) {
    size = pending.size
    await Promise.all(pending.values())
  }
  const built = await scriptsBuilt
  if (errors.length > 0) throw Object.assign(new Error(`Build failed with ${errors.length} error(s)`), { errors })
  const modules = new Map()
  for (const record of await Promise.all(pending.values())) modules.set(record.id, record)
  const runs = [...before.map(({ key }) => key), entryKey].map(run.idOf)
  // The scripts, which no update can define anew, as they are.
  return { ...serialize({ prelude, scripts: built, modules, runs }), modules, entryId: run.idOf(entryKey), scripts: built.map(({ text }) => text).join(''), assets: [...state.assets.keys()].toSorted().map((path) => state.assets.get(path)), files: [...state.read] }
}

// The module a resolution is: { key, kind }, a file's key its path, an
// asset's its lowest path, as bundle() has it; null where nothing.
function moduleOfResolution(resolution) {
  if (resolution === null) return null
  if (resolution.type === 'empty') return { key: EMPTY, kind: 'empty' }
  if (resolution.type === 'assetFiles') return { key: resolution.filePaths.toSorted()[0], kind: 'asset' }
  return { key: resolution.filePath, kind: 'file' }
}

// A module: its source, built, its imports resolved, each visited. -> its record.
async function moduleOf(run, state, { key, kind }, visit) {
  const { projectRoot, platform, host } = run
  let source
  if (kind === 'empty') {
    source = { contents: '', loader: 'js' }
  } else if (kind === 'asset') {
    const data = assetData(key, { urlPath: nameOf(projectRoot, key), platform, host: reading(host, state.read) })
    state.assets.set(key, data)
    source = { contents: assetModule(data, run.assetRegistryPath ?? state.reactNative.assetRegistryPath), loader: 'js' }
  } else {
    state.read.add(key)
    source = await loadCached({ ...run, sourcemap: true }, host, run.cache ?? null, key)
    if (source.errors !== undefined) throw Object.assign(new Error('load'), { errors: source.errors })
  }
  let built = await buildOf(run, key, source)
  const resolve1 = (imported) => resolveImport(state, { importer: key, specifier: imported.specifier, kind: imported.kind, aliases: run.aliases, platform, imports: source.pluginData?.imports })
  let resolved = built.imports.map((imported) => ({ ...imported, resolution: resolve1(imported) }))
  // An import of nothing, not known as optional: esbuild says whether it is.
  if (resolved.some(({ specifier, resolution }) => resolution === null && !built.optional.has(specifier))) {
    built = await buildOf(run, key, source, new Set(resolved.filter(({ resolution }) => resolution !== null).map(({ specifier }) => specifier)))
    resolved = built.imports.map((imported) => ({ ...imported, resolution: resolve1(imported) }))
  }
  const deps = []
  const indices = {}
  for (const { specifier, resolution } of resolved) {
    const child = moduleOfResolution(resolution)
    if (child === null || Object.hasOwn(indices, specifier)) continue
    visit(child)
    indices[specifier] = deps.length
    deps.push(child.key)
  }
  return { id: run.idOf(key), key, name: nameOf(projectRoot, key), deps: deps.map(run.idOf), factory: factoryOf(built, indices), lines: built.lines, piece: built.piece }
}

// A module's code as esbuild builds it, as CommonJS, each import left a
// require(): { code, piece, lines, imports: [{ specifier, kind }], optional }.
// Kept while its source is the same. With `resolvable`, the specifiers that
// resolve: the rest are left to esbuild, which fails on each but in a try
// block, which it leaves; those are `optional`.
async function buildOf(run, key, source, resolvable = null) {
  const kept = run.builds.get(key)
  if (resolvable === null && kept !== undefined && kept.contents === source.contents && kept.loader === source.loader) return kept.built
  const { esbuild, projectRoot } = run
  // Absolute: esbuild takes stdin's file from its resolveDir.
  const sourcefile = key === EMPTY ? EMPTY : key
  const common = { bundle: true, write: false, format: 'cjs', platform: 'neutral', absWorkingDir: projectRoot, outfile: resolve(projectRoot, OUTFILE), metafile: true, sourcemap: 'external', define: run.define ?? {}, minify: run.minify ?? false, supported: run.supported, logLevel: 'silent' }
  const result = resolvable === null
    ? await esbuild.build({ ...common, stdin: { contents: source.contents, loader: source.loader, sourcefile, resolveDir: key === EMPTY ? projectRoot : dirname(key) }, external: ['*'] })
    : await esbuild.build({ ...common, entryPoints: [key], plugins: [checking(key, source, resolvable, projectRoot)] })
  const text = (ext) => result.outputFiles.find(({ path }) => path.endsWith(ext)).text
  const imports = Object.values(result.metafile.inputs).flatMap((input) => input.imports).filter((imported) => imported.external).map(({ path, kind }) => ({ specifier: path, kind }))
  const code = text('.js')
  const built = { code, piece: pieceOf(JSON.parse(text('.map'))), lines: lineCount(code), imports, optional: new Set(resolvable === null ? [] : imports.map(({ specifier }) => specifier).filter((specifier) => !resolvable.has(specifier))) }
  run.builds.set(key, { contents: source.contents, loader: source.loader, built })
  return built
}

// The module, each import that resolves left as it is, the rest to esbuild.
const checking = (key, source, resolvable, projectRoot) => ({
  name: 'metro-module',
  setup(build) {
    build.onResolve({ filter: ANY }, ({ path, kind }) => {
      if (kind === 'entry-point') return { path: key }
      return resolvable.has(path) ? { path, external: true } : undefined
    })
    build.onLoad({ filter: ANY }, ({ path }) => {
      if (path === key) return { ...source, resolveDir: dirname(key) }
      return { errors: [{ text: `esbuild resolved ${relative(projectRoot, path)} where Metro resolves nothing` }] }
    })
  },
})

// The factory, on lines of its own: its first, whose `require` takes each
// specifier to its module's id in the dependency map, the module's `use
// strict` before it; then the module's.
const STRICT = '"use strict";'
function factoryOf({ code }, indices) {
  const strict = code.startsWith(STRICT)
  // Each line and column kept: the directive, which goes first, made
  // spaces, minified or not, and a hashbang, which esbuild keeps and is no
  // JS inside a function, emptied.
  const body = strict ? ' '.repeat(STRICT.length) + code.slice(STRICT.length) : code.startsWith('#!') ? code.slice(code.indexOf('\n')) : code
  const require = `var _$$_AT = ${JSON.stringify(indices)}; var require = function (name) { if (!Object.prototype.hasOwnProperty.call(_$$_AT, name)) { var error = new Error("Cannot find module '" + name + "'"); error.code = "MODULE_NOT_FOUND"; throw error } return _$$_REQUIRE(_dependencyMap[_$$_AT[name]], name) };`
  return `${FACTORY} {${strict ? STRICT : ''}${require}\n${body}}`
}

// `__d(...)`, as Metro defines a module; with `inverse`, as an update does.
export const defineCall = (record, inverse) => `__d(${record.factory},${record.id},${JSON.stringify(record.deps)},${JSON.stringify(record.name)}${inverse === undefined ? '' : `,${JSON.stringify(inverse)}`});\n`

// A polyfill or metro-runtime's require: a script, given the global object, as Metro wraps one.
async function scriptOf(run, state, path) {
  state.read.add(path)
  const source = await loadCached({ ...run, sourcemap: true }, run.host, run.cache ?? null, path)
  if (source.errors !== undefined) throw Object.assign(new Error('load'), { errors: source.errors })
  const { code, map } = await run.esbuild.transform(source.contents, { loader: source.loader, sourcefile: relative(run.projectRoot, path).replaceAll('\\', '/'), sourcemap: 'external', define: run.define ?? {}, minify: run.minify ?? false, supported: run.supported, logLevel: 'silent' })
  return { text: `(function (global) {\n${code}})(${GLOBAL});\n`, lines: lineCount(code) + 2, piece: pieceOf(JSON.parse(map)) }
}

// The bundle and its map: the prelude, the scripts, each module, each run.
function serialize({ prelude, scripts, modules, runs }) {
  const parts = []
  const pieces = []
  if (prelude !== null) {
    parts.push(`${prelude}\n`)
    pieces.push({ lines: lineCount(`${prelude}\n`), piece: null })
  }
  for (const script of scripts) {
    parts.push(script.text)
    pieces.push({ lines: 1, piece: null }, { lines: script.lines - 2, piece: script.piece }, { lines: 1, piece: null })
  }
  // By id: the same bundle of the same modules, whatever order they were built in.
  for (const record of [...modules.values()].toSorted((a, b) => a.id - b.id)) {
    parts.push(defineCall(record))
    pieces.push({ lines: 1, piece: null }, { lines: record.lines, piece: record.piece }, { lines: 1, piece: null })
  }
  const tail = runs.map((id) => `__r(${id});\n`).join('')
  parts.push(tail)
  pieces.push({ lines: runs.length, piece: null })
  return { js: parts.join(''), map: JSON.stringify(concatMaps(pieces.filter(({ lines }) => lines > 0))) }
}

// esbuild's errors, else the error as one, located in the module.
function errorsOf(error, key, projectRoot) {
  if (Array.isArray(error?.errors)) return error.errors.map((each) => ({ ...each, location: each.location ?? (key === EMPTY ? null : { file: nameOf(projectRoot, key), line: 1, column: 0, lineText: '' }) }))
  return [{ text: error?.message ?? String(error), location: key === EMPTY ? null : { file: nameOf(projectRoot, key), line: 1, column: 0, lineText: '' } }]
}
