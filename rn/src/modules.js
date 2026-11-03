// A dev server's bundle in Metro's module format, for Fast Refresh: each module built alone by esbuild as
// CommonJS, its imports left as require calls, and defined by `__d(factory, id, deps, name)`.
// Ported from Metro's baseJSBundle and wrapModule (MIT, Copyright (c) Meta Platforms, Inc. and affiliates).

import { dirname, relative, resolve } from 'node:path'

import { ANY, GLOBAL, assetSource, assetsOf, loadCached, lowersLetOf, newState, posixRelative, resolveImport, supportedOf } from './bundle.js'
import { defaults, diskHost } from './defaults.js'
import { concatMapsJson, pieceOf } from './mappings.js'

const FACTORY = 'function (global, _$$_REQUIRE, _$$_IMPORT_DEFAULT, _$$_IMPORT_ALL, module, exports, _dependencyMap)'
// The key of the empty module, which Metro resolves some imports to.
const EMPTY = 'metro-empty'
const OUTFILE = 'rn-serve.module.js'
const lineCount = (text) => text.split('\n').length - 1
const nameOf = (projectRoot, key) => (key === EMPTY ? EMPTY : posixRelative(projectRoot, key))
// A wrapped script's or module's map pieces: its code between the wrapper's first and last lines.
export const wrapped = ({ lines, piece }) => [{ lines: 1, piece: null }, { lines, piece }, { lines: 1, piece: null }]

// rebuild() returns { js, map, modules, entryId, scripts, assets, files, bundled } or throws as
// createBundler()'s: `js` and `map` the bundle and its map, as bundled.js() and bundled.map() make each
// when first asked for, not as each build is done (an edit's, which an update has the modules of alone).
// `ids` (key => id) persist across builds, `builds` holds each module's build, `runtime` is metro-runtime's
// require.js, and `injected` are rn's own modules run after those run first, resolved as the entry's imports.
export function createModuleBundler(options) {
  const { entry, platform, projectRoot, host = diskHost, assetExts = defaults.assetExts, polyfills = [], runtime, prelude = null, ids = new Map(), builds = new Map() } = options
  const supported = lowersLetOf(options).catch(() => false).then((lowersLet) => ({ ...supportedOf(options.babel, lowersLet), 'dynamic-import': false }))
  const idOf = (key) => {
    if (!ids.has(key)) ids.set(key, ids.size)
    return ids.get(key)
  }
  return {
    async rebuild(onProgress = null) {
      // With `esm`, Babel leaves import and export to esbuild, which makes each module CommonJS, but `commonJs`'s.
      const esm = options.esm === true ? (options.commonJs ?? new Set()) : false
      const run = { ...options, esm, onProgress, stripFlow: options.stripFlow ?? null, babel: options.babel ?? null, babelPlugins: options.babelPlugins ?? null, aliases: options.aliases ?? null, host, assetExts, supported: await supported, idOf, builds }
      let state = null
      try {
        newState({ host, assetExts, resolver: options.resolver, blockList: options.blockList ?? null, projectRoot, entry, platform }, (made) => {
          state = made
        })
        return await graphOf(run, state, { scripts: [runtime, ...polyfills], prelude })
      } catch (error) {
        const files = [...state.read]
        if (Array.isArray(error?.errors)) throw Object.assign(error, { files })
        const text = error?.message ?? String(error)
        throw Object.assign(new Error(text), { errors: [{ text, location: null }], files })
      }
    },
    dispose: async () => {},
  }
}

// Builds each module from the entry, and each script; then the bundle.
async function graphOf(run, state, { scripts, prelude }) {
  const { projectRoot, entry } = run
  const entryPath = resolve(projectRoot, entry)
  state.read.add(entryPath)
  const pending = new Map()
  let done = 0
  const errors = []
  const fail = (key) => (error) => {
    errors.push(...errorsOf(error, key, projectRoot))
    return null
  }
  // Builds a module once by its key, telling the progress of those built of those found, as Metro does.
  const visit = (found) => {
    if (pending.has(found.key)) return
    pending.set(found.key, moduleOf(run, state, found, visit).catch(fail(found.key)).finally(() => run.onProgress?.(++done, pending.size)))
  }
  let entryKey
  try {
    entryKey = run.host.realpath(entryPath)
  } catch {
    throw Object.assign(new Error('no entry'), { errors: [{ text: `Could not resolve "${entry}"`, location: null }] })
  }
  visit({ key: entryKey, kind: 'file' })
  const fromEntry = (specifiers) => specifiers.map((specifier) => moduleOfResolution(resolveImport(state, { importer: entryKey, specifier, kind: 'import-statement', aliases: run.aliases, platform: run.platform }))).filter((found) => found !== null)
  // Those to run before the entry, then rn's own, whose imports resolve as the entry's.
  const before = [...fromEntry(run.runBeforeMain ?? state.reactNative.runBeforeMain), ...fromEntry(run.injected ?? []).map((found) => ({ ...found, importer: entryKey }))]
  for (const found of before) visit(found)
  const scriptsBuilt = Promise.all(scripts.map((path) => scriptOf(run, state, path).catch(fail(path))))
  // Until building finds no module more.
  let size = 0
  while (size !== pending.size) {
    size = pending.size
    await Promise.all(pending.values())
  }
  const built = await scriptsBuilt
  if (errors.length > 0) throw Object.assign(new Error(`Build failed with ${errors.length} error(s)`), { errors })
  const modules = new Map((await Promise.all(pending.values())).map((record) => [record.id, record]))
  const runs = [...before.map(({ key }) => key), entryKey].map(run.idOf)
  const bundled = serialize({ prelude, scripts: built, modules, runs })
  // `scripts`, which no update can define anew, as they are.
  const result = { modules, entryId: run.idOf(entryKey), scripts: built.map(({ text }) => text).join(''), assets: assetsOf(state), files: [...state.read], bundled }
  return Object.defineProperties(result, { js: { get: bundled.js, enumerable: true }, map: { get: bundled.map, enumerable: true } })
}

// The module a resolution is, { key, kind }, an asset's key its lowest path as in bundle(); null where nothing.
function moduleOfResolution(resolution) {
  if (resolution === null) return null
  if (resolution.type === 'empty') return { key: EMPTY, kind: 'empty' }
  if (resolution.type === 'assetFiles') return { key: resolution.filePaths.toSorted()[0], kind: 'asset' }
  return { key: resolution.filePath, kind: 'file' }
}

// A file loaded as bundle() loads it, with its map; throws its errors.
async function loaded(run, state, path) {
  state.read.add(path)
  const source = await loadCached({ ...run, sourcemap: true }, run.host, run.cache ?? null, path)
  if (source.errors !== undefined) throw Object.assign(new Error('load'), { errors: source.errors })
  return source
}

// Builds a module, resolving its imports from `importer` (its own path but where given) and visiting each.
async function moduleOf(run, state, { key, kind, importer = key }, visit) {
  const { projectRoot, platform, host } = run
  let source = { contents: '', loader: 'js' }
  if (kind === 'file') source = await loaded(run, state, key)
  else if (kind === 'asset') source = { contents: assetSource(state, key, { urlPath: nameOf(projectRoot, key), platform, host, assetRegistryPath: run.assetRegistryPath }), loader: 'js' }
  const resolveAll = ({ imports }) => imports.map((imported) => ({ ...imported, resolution: resolveImport(state, { importer, specifier: imported.specifier, kind: imported.kind, aliases: run.aliases, platform, imports: source.pluginData?.imports, mapped: source.pluginData?.aliases }) }))
  let built = await buildOf(run, key, source)
  let resolved = resolveAll(built)
  // An import of nothing, not known to be optional: built again, esbuild telling whether it is.
  if (resolved.some(({ specifier, resolution }) => resolution === null && !built.optional.has(specifier))) {
    built = await buildOf(run, key, source, new Set(resolved.filter(({ resolution }) => resolution !== null).map(({ specifier }) => specifier)))
    resolved = resolveAll(built)
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
  return recordOf(run, key, built, deps.map(run.idOf), indices)
}

// A module's record, the one of the build before where its build, id, deps and their indices are the same
// (its factory, and its definition, serialize()'s, made once): a build's are those of the one before but
// an edit's.
const RECORDS = new WeakMap()
function recordOf(run, key, built, deps, indices) {
  const id = run.idOf(key)
  const at = JSON.stringify(indices)
  const kept = RECORDS.get(built)
  if (kept !== undefined && kept.at === at && kept.record.id === id && kept.record.deps.length === deps.length && kept.record.deps.every((each, i) => each === deps[i])) return kept.record
  const record = { id, key, name: nameOf(run.projectRoot, key), deps, factory: factoryOf(built, indices), lines: built.lines, piece: built.piece }
  RECORDS.set(built, { at, record })
  return record
}

// Builds a module with esbuild as CommonJS, each import left a require call; kept while its source is the
// same, and in run.store across runs. With `resolvable`, the other imports go to esbuild, which fails on
// each but in a try block; those it leaves are `optional`.
async function buildOf(run, key, source, resolvable = null) {
  const kept = run.builds.get(key)
  if (resolvable === null && kept !== undefined && kept.contents === source.contents && kept.loader === source.loader) return kept.built
  const parts = [key, source.loader, run.define ?? {}, run.minify ?? false, run.supported, run.projectRoot, resolvable === null ? null : [...resolvable].toSorted()]
  const anew = () => buildAnew(run, key, source, resolvable)
  const made = run.store == null ? await anew() : await run.store.build(parts, source.contents, anew)
  const optional = resolvable === null ? [] : made.imports.map(({ specifier }) => specifier).filter((specifier) => !resolvable.has(specifier))
  const built = { ...made, optional: new Set(optional) }
  run.builds.set(key, { contents: source.contents, loader: source.loader, built })
  return built
}

async function buildAnew(run, key, source, resolvable) {
  const { esbuild, projectRoot } = run
  // Absolute, as esbuild takes stdin's file from its resolveDir. Not .mjs or .mts: esbuild takes those for
  // Node's ES modules, an import of one getting the whole module.exports, not Babel's (Metro's) exports.default.
  const sourcefile = key === EMPTY ? EMPTY : key.replace(/\.m([jt])s$/u, '.m$1s.$1s')
  // A JSON file wrapped as Metro does, `module.exports =` it: esbuild would build it as an entry with no exports.
  const { contents, loader } = source.loader === 'json' ? { contents: (await esbuild.transform(source.contents, { loader: 'json', format: 'cjs', sourcefile, logLevel: 'silent' })).code, loader: 'js' } : source
  const common = { bundle: true, write: false, format: 'cjs', platform: 'neutral', absWorkingDir: projectRoot, outfile: resolve(projectRoot, OUTFILE), metafile: true, sourcemap: 'external', define: run.define ?? {}, minify: run.minify ?? false, supported: run.supported, logLevel: 'silent' }
  const stdin = { contents, loader, sourcefile, resolveDir: key === EMPTY ? projectRoot : dirname(key) }
  let result
  try {
    result = await esbuild.build({ ...common, stdin, ...(resolvable === null ? { external: ['*'] } : { plugins: [checking(resolvable, projectRoot)] }) })
  } catch (error) {
    if (Array.isArray(error?.errors) && sourcefile !== key) {
      for (const { location } of error.errors) if (location !== null && resolve(projectRoot, location.file) === sourcefile) location.file = nameOf(projectRoot, key)
    }
    throw error
  }
  const text = (ext) => result.outputFiles.find(({ path }) => path.endsWith(ext)).text
  const imports = Object.values(result.metafile.inputs).flatMap((input) => input.imports).filter((imported) => imported.external).map(({ path, kind }) => ({ specifier: path, kind }))
  const code = text('.js')
  // Its map names the file as it is named, where esbuild named it `sourcefile` (with no map before it).
  const map = JSON.parse(text('.map'))
  if (sourcefile !== key) map.sources = map.sources.map((each) => (resolve(projectRoot, each) === sourcefile ? each.slice(0, key.length - sourcefile.length) : each))
  return { code, piece: pieceOf(map), lines: lineCount(code), imports }
}

// Leaves each import that resolves as it is, and the rest to esbuild, which may find none (optional) but no file.
const checking = (resolvable, projectRoot) => ({
  name: 'metro-module',
  setup(build) {
    build.onResolve({ filter: ANY }, ({ path }) => (resolvable.has(path) ? { path, external: true } : undefined))
    build.onLoad({ filter: ANY }, ({ path }) => ({ errors: [{ text: `esbuild resolved ${relative(projectRoot, path)} where Metro resolves nothing` }] }))
  },
})

// The factory: its first line has the module's `use strict` and a `require` taking each specifier to its
// module's id in the dependency map; then the module's code, each line and column kept: the directive
// blanked with spaces, and a hashbang, which esbuild keeps and is no JS inside a function, emptied.
const STRICT = '"use strict";'
function factoryOf({ code }, indices) {
  const strict = code.startsWith(STRICT)
  const body = strict ? ' '.repeat(STRICT.length) + code.slice(STRICT.length) : code.startsWith('#!') ? code.slice(code.indexOf('\n')) : code
  const require = `var _$$_AT = ${JSON.stringify(indices)}; var require = function (name) { if (!Object.prototype.hasOwnProperty.call(_$$_AT, name)) { var error = new Error("Cannot find module '" + name + "'"); error.code = "MODULE_NOT_FOUND"; throw error } return _$$_REQUIRE(_dependencyMap[_$$_AT[name]], name) };`
  return `${FACTORY} {${strict ? STRICT : ''}${require}\n${body}}`
}

// `__d(...)`, as Metro defines a module; with `inverse`, as an update does.
export const defineCall = (record, inverse) => `__d(${record.factory},${record.id},${JSON.stringify(record.deps)},${JSON.stringify(record.name)}${inverse === undefined ? '' : `,${JSON.stringify(inverse)}`});\n`

// A polyfill or metro-runtime's require: a script given the global object, as Metro wraps one.
async function scriptOf(run, state, path) {
  const source = await loaded(run, state, path)
  const { code, map } = await run.esbuild.transform(source.contents, { loader: source.loader, sourcefile: posixRelative(run.projectRoot, path), sourcemap: 'external', define: run.define ?? {}, minify: run.minify ?? false, supported: run.supported, logLevel: 'silent' })
  return { text: `(function (global) {\n${code}})(${GLOBAL});\n`, lines: lineCount(code), piece: pieceOf(JSON.parse(map)) }
}

// Each record's definition (defineCall()'s), once: a record is the build before's where it is the same.
const DEFINED = new WeakMap()
const definedOf = (record) => {
  if (!DEFINED.has(record)) DEFINED.set(record, defineCall(record))
  return DEFINED.get(record)
}

// The bundle and its map, { js(), map() }, each made once, as it is first asked for: the prelude, the
// scripts, each module (its definition and map once of its record: definedOf(), concatMapsJson()), each
// run. A client that asks for the bundle may never ask for its map (a debugger's, symbolication's).
function serialize({ prelude, scripts, modules, runs }) {
  // By id: the same bundle of the same modules, whatever order they were built in.
  let sorted = null
  const ordered = () => (sorted ??= [...modules.values()].toSorted((a, b) => a.id - b.id))
  let js = null
  let map = null
  const jsOf = () => {
    const parts = prelude === null ? [] : [`${prelude}\n`]
    for (const script of scripts) parts.push(script.text)
    for (const record of ordered()) parts.push(definedOf(record))
    parts.push(runs.map((id) => `__r(${id});\n`).join(''))
    return parts.join('')
  }
  const mapOf = () => {
    const pieces = prelude === null ? [] : [{ lines: lineCount(`${prelude}\n`), piece: null }]
    for (const script of scripts) pieces.push(...wrapped(script))
    for (const record of ordered()) pieces.push(...wrapped(record))
    pieces.push({ lines: runs.length, piece: null })
    return concatMapsJson(pieces.filter(({ lines }) => lines > 0))
  }
  return { js: () => (js ??= jsOf()), map: () => (map ??= mapOf()) }
}

// esbuild's errors, else the error as one, located in the module where they have no location.
function errorsOf(error, key, projectRoot) {
  const location = key === EMPTY ? null : { file: nameOf(projectRoot, key), line: 1, column: 0, lineText: '' }
  if (Array.isArray(error?.errors)) return error.errors.map((each) => ({ ...each, location: each.location ?? location }))
  return [{ text: error?.message ?? String(error), location }]
}
