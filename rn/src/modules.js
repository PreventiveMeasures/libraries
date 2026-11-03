// A dev server's bundle in Metro's module format, for Fast Refresh: each module built alone by esbuild as
// CommonJS, its imports left as require calls, and defined by `__d(factory, id, deps, name)`.
// Ported from Metro's baseJSBundle and wrapModule (MIT, Copyright (c) Meta Platforms, Inc. and affiliates).

import { dirname, relative, resolve } from 'node:path'

import { ANY, loadCached, lowersLetOf, supportedOf, trustedOf, withDefaults } from './bundle.js'
import { EMPTY, newState, posixRelative, resolutionOf } from './build-host.js'
import { concatMapsJson, pieceOf } from './mappings.js'
import { GLOBAL } from './serializer.js'

const FACTORY = 'function (global, _$$_REQUIRE, _$$_IMPORT_DEFAULT, _$$_IMPORT_ALL, module, exports, _dependencyMap)'
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
  const { runtime, injected = [], ids = new Map(), builds = new Map() } = options
  const idOf = (key) => {
    if (!ids.has(key)) ids.set(key, ids.size)
    return ids.get(key)
  }
  // With `esm`, Babel leaves import and export to esbuild, which makes each module CommonJS, but `commonJs`'s.
  const run = { ...withDefaults(options), injected, builds, idOf }
  // Its resolver, kept in memory across its watcher-caused builds (build-host.js's resolutionOf()).
  run.resolution = resolutionOf(run)
  const supported = lowersLetOf(run).catch(() => false).then((lowersLet) => ({ ...supportedOf(run.babel, lowersLet), 'dynamic-import': false }))
  return {
    // `changes`, a watcher's since the build before ({ path, event }); null, a full build, which resolves and
    // reads anew what a watcher-caused one keeps of the build before. `at`, a dev bundler's version of it.
    async rebuild(onProgress = null, changes = null, at = null) {
      const read = new Set()
      try {
        const state = newState({ ...run, changes }, read)
        return await graphOf({ ...run, onProgress, supported: await supported, trusted: changes !== null, at }, state, [runtime, ...run.polyfills])
      } catch (error) {
        throw Object.assign(new Error(error?.message ?? String(error)), { errors: errorsOf(error, null), files: [...read] })
      }
    },
    dispose: async () => {},
  }
}

// Builds each module from the entry, and each script; then the bundle.
async function graphOf(run, state, scripts) {
  const { projectRoot, entry, idOf } = run
  const entryPath = resolve(projectRoot, entry)
  state.read.add(entryPath)
  let entryKey
  try {
    entryKey = run.host.realpath(entryPath)
  } catch {
    throw Object.assign(new Error('no entry'), { errors: [{ text: `Could not resolve "${entry}"`, location: null }] })
  }
  const pending = new Map()
  const errors = []
  let done = 0
  // Located in the module where they have no location.
  const fail = (key) => (error) => {
    errors.push(...errorsOf(error, key === EMPTY ? null : { file: nameOf(projectRoot, key), line: 1, column: 0, lineText: '' }))
    return null
  }
  // Builds a module once by its key, telling the progress of those built of those found, as Metro does.
  const visit = (found) => {
    if (!pending.has(found.key)) pending.set(found.key, moduleOf(run, state, found, visit).catch(fail(found.key)).finally(() => run.onProgress?.(++done, pending.size)))
  }
  visit({ key: entryKey, kind: 'file' })
  // Those to run before the entry, then rn's own, whose imports resolve as the entry's.
  const fromEntry = (specifiers) => specifiers.map((specifier) => state.resolveImport(entryKey, specifier, 'import-statement')).filter((found) => found !== null)
  const before = [...fromEntry(state.before), ...fromEntry(run.injected).map((found) => ({ ...found, importer: entryKey }))]
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
  const runs = [...before.map(({ key }) => key), entryKey].map(idOf)
  const bundled = serialize(run.prelude, built, modules, runs)
  // `scripts`, which no update can define anew, as they are; js and map made as a client first asks for each.
  const result = { modules, entryId: idOf(entryKey), scripts: built.map(({ text }) => text).join(''), assets: state.assets(), files: [...state.read], bundled }
  return Object.defineProperties(result, { js: { get: bundled.js, enumerable: true }, map: { get: bundled.map, enumerable: true } })
}

// A file loaded as bundle() loads it, with its map; throws its errors.
async function loaded(run, state, path) {
  state.read.add(path)
  const source = trustedOf(run, path) ?? (await loadCached({ ...run, sourcemap: true }, path, run.host.readFile(path)))
  if (source.errors !== undefined) throw Object.assign(new Error('load'), { errors: source.errors })
  return source
}

// Builds a module, resolving its imports from `importer` (its own path but where given) and visiting each.
async function moduleOf(run, state, { key, kind, importer = key }, visit) {
  const { idOf } = run
  const source = kind === 'file' ? await loaded(run, state, key) : { contents: kind === 'asset' ? state.assetSource(key) : '', loader: 'js' }
  const resolveAll = ({ imports }) => imports.map(({ specifier, kind: how }) => ({ specifier, found: state.resolveImport(importer, specifier, how, source.pluginData) }))
  let built = await buildOf(run, key, source)
  let resolved = resolveAll(built)
  // An import of nothing, not known to be optional: built again, esbuild telling whether it is.
  if (resolved.some(({ specifier, found }) => found === null && !built.optional.has(specifier))) {
    built = await buildOf(run, key, source, new Set(resolved.filter(({ found }) => found !== null).map(({ specifier }) => specifier)))
    resolved = resolveAll(built)
  }
  const deps = []
  const indices = {}
  for (const { specifier, found } of resolved) {
    if (found === null || Object.hasOwn(indices, specifier)) continue
    visit(found)
    indices[specifier] = deps.length
    deps.push(found.key)
  }
  return recordOf(run, key, built, deps.map(idOf), indices)
}

// The build before's record where its build, id, deps and their indices are the same, so that serialize()
// defines each module once: an edit's build has new records for its modules alone.
const RECORDS = new WeakMap()
function recordOf(run, key, built, deps, indices) {
  const id = run.idOf(key)
  const at = JSON.stringify(indices)
  const kept = RECORDS.get(built)
  if (kept !== undefined && kept.at === at && kept.record.id === id && kept.record.deps.length === deps.length && kept.record.deps.every((each, i) => each === deps[i])) return kept.record
  const record = { id, key, name: nameOf(run.projectRoot, key), deps, factory: factoryOf(built.code, indices), lines: built.lines, piece: built.piece }
  RECORDS.set(built, { at, record })
  return record
}

// Builds a module with esbuild as CommonJS, each import left a require call; kept while its source is the
// same, and in run.store across runs. With `resolvable`, the other imports go to esbuild, which fails on
// each but in a try block; those it leaves are `optional`.
async function buildOf(run, key, source, resolvable = null) {
  const kept = run.builds.get(key)
  if (resolvable === null && kept?.contents === source.contents && kept.loader === source.loader) return kept.built
  const anew = () => buildAnew(run, key, source, resolvable)
  const parts = [key, source.loader, run.define, run.minify, run.supported, run.projectRoot, resolvable === null ? null : [...resolvable].toSorted()]
  const made = run.store === null ? await anew() : await run.store.build(parts, source.contents, anew)
  const built = { ...made, optional: new Set(resolvable === null ? [] : made.imports.map(({ specifier }) => specifier).filter((specifier) => !resolvable.has(specifier))) }
  run.builds.set(key, { contents: source.contents, loader: source.loader, built })
  return built
}

async function buildAnew({ esbuild, projectRoot, define, minify, supported }, key, source, resolvable) {
  // Absolute, as esbuild takes stdin's file from its resolveDir. Not .mjs or .mts: esbuild takes those for
  // Node's ES modules, an import of one getting the whole module.exports, not Babel's (Metro's) exports.default.
  const sourcefile = key === EMPTY ? EMPTY : key.replace(/\.m([jt])s$/u, '.m$1s.$1s')
  // A JSON file wrapped as Metro does, `module.exports =` it: esbuild would build it as an entry with no exports.
  const { contents, loader } = source.loader === 'json' ? { contents: (await esbuild.transform(source.contents, { loader: 'json', format: 'cjs', sourcefile, logLevel: 'silent' })).code, loader: 'js' } : source
  const options = { bundle: true, write: false, format: 'cjs', platform: 'neutral', absWorkingDir: projectRoot, outfile: resolve(projectRoot, OUTFILE), metafile: true, sourcemap: 'external', define, minify, supported, logLevel: 'silent' }
  const stdin = { contents, loader, sourcefile, resolveDir: key === EMPTY ? projectRoot : dirname(key) }
  // Its messages and map name the file as it is named, where esbuild named it `sourcefile` (with no map before it).
  const isSourcefile = (file) => resolve(projectRoot, file) === sourcefile
  const result = await esbuild.build({ ...options, stdin, ...(resolvable === null ? { external: ['*'] } : { plugins: [checking(resolvable, projectRoot)] }) }).catch((error) => {
    for (const { location } of sourcefile === key ? [] : (error.errors ?? [])) if (location !== null && isSourcefile(location.file)) location.file = nameOf(projectRoot, key)
    throw error
  })
  const text = (ext) => result.outputFiles.find(({ path }) => path.endsWith(ext)).text
  const imports = Object.values(result.metafile.inputs).flatMap((input) => input.imports).filter((imported) => imported.external).map(({ path, kind }) => ({ specifier: path, kind }))
  const code = text('.js')
  const map = JSON.parse(text('.map'))
  if (sourcefile !== key) map.sources = map.sources.map((each) => (isSourcefile(each) ? each.slice(0, key.length - sourcefile.length) : each))
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
function factoryOf(code, indices) {
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
  const { code, map } = await run.esbuild.transform(source.contents, { loader: source.loader, sourcefile: posixRelative(run.projectRoot, path), sourcemap: 'external', define: run.define, minify: run.minify, supported: run.supported, logLevel: 'silent' })
  return { text: `(function (global) {\n${code}})(${GLOBAL});\n`, lines: lineCount(code), piece: pieceOf(JSON.parse(map)) }
}

// Each record's definition, made once (recordOf() keeps records across builds).
const DEFINED = new WeakMap()
const definedOf = (record) => {
  if (!DEFINED.has(record)) DEFINED.set(record, defineCall(record))
  return DEFINED.get(record)
}

// The bundle and its map, { js(), map() }, each made once as first asked for (a client may never ask for the
// map): the prelude, the scripts, each module by id (the same bundle whatever order they were built in), each run.
function serialize(prelude, scripts, modules, runs) {
  let sorted = null
  const ordered = () => (sorted ??= [...modules.values()].toSorted((a, b) => a.id - b.id))
  const head = prelude === null ? [] : [`${prelude}\n`]
  let js = null
  let map = null
  return {
    js: () => (js ??= [...head, ...scripts.map(({ text }) => text), ...ordered().map((record) => definedOf(record)), runs.map((id) => `__r(${id});\n`).join('')].join('')),
    map: () => (map ??= concatMapsJson([...head.map((text) => ({ lines: lineCount(text), piece: null })), ...scripts.flatMap(wrapped), ...ordered().flatMap(wrapped), { lines: runs.length, piece: null }])),
  }
}

// esbuild's errors, else the error as one, at `location` where they have none.
const errorsOf = (error, location) => (Array.isArray(error?.errors) ? error.errors.map((each) => ({ ...each, location: each.location ?? location })) : [{ text: error?.message ?? String(error), location }])
