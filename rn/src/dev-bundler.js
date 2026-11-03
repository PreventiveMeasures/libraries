// The bundles a dev server serves, one per entry, platform, dev and minify asked for (the last `maxBuilds`),
// each rebuilt once a file changes, each file's transform kept in memory while its source is the same. A dev
// bundle is in Metro's module format (modules.js) where metro-runtime's require is given, else as rn-bundle's.

import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'

import { metroResolverOf } from './build-host.js'
import { createBundler, utf8 } from './bundle.js'
import { defaults, diskHost } from './defaults.js'
import { moduleName } from './hot.js'
import { concatMaps, indexMappings } from './mappings.js'
import { createModuleBundler, defineCall, wrapped } from './modules.js'
import { prelude } from './serializer.js'
const NAMESPACED = /^metro-[a-z]+:/u
const NO_METRO = Object.freeze({ assetExts: defaults.assetExts, resolver: {}, blockList: null, polyfills: () => [], runBeforeMain: null, assetRegistryPath: null, minifyRefusal: null, transformRefusal: () => null, inlineRequires: () => Promise.resolve(null) })
// A build refused, for what of the Metro config it doesn't do.
const refused = (version, text) => ({ ok: false, version, errors: [{ text, location: null }], files: new Set() })

export const inside = (root, path) => {
  const rel = relative(root, path)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

// targetOptions({ platform, dev, inlineRequires }) gives bundle()'s options for the project's files, and
// onBuild({ request, outcome, ms, cached }) follows each build, `cached` its store's tally or null.
// `metro` is metroOptions()'s config, Metro's defaults where not given; `injected`, createModuleBundler()'s.
export function createDevBundler({ projectRoot, esbuild, targetOptions, host = diskHost, metro = NO_METRO, runtime = null, injected = [], maxBuilds = 8, onBuild = () => {} }) {
  // `edits`: the version of each path's last change the watcher saw.
  const config = { projectRoot, esbuild, targetOptions, host, metro, runtime, injected, onBuild, caches: new Map(), ids: new Map(), edits: new Map() }
  const builds = new Map()
  let version = 0

  // Its outcome of the files as they are: built anew where one changed since, after its builds before.
  const outcomeOf = (build) => {
    if (build.version !== version) {
      const at = version
      build.version = at
      build.outcome = build.outcome
        .catch(() => {})
        .then(() => run(config, build, at))
        .finally(uncovered)
    }
    return build.outcome
  }

  // Evicts the least recently asked for at once, disposing of them after.
  const evict = (limit) => {
    const dropped = []
    while (builds.size > limit) {
      const [key, build] = builds.entries().next().value
      builds.delete(key)
      dropped.push(drop(build))
    }
    return Promise.all(dropped)
  }

  // An outcome: { ok: true, js, map, assets, files, index() }, with `modules` and `entryId` in the module
  // format, or { ok: false, errors, files }; null where the request names no entry here. A `shallow`
  // request is a module's, from the last build.
  const get = async (request, { onProgress = null } = {}) => {
    if (request.shallow) return moduleOutcome(builds, request, projectRoot)
    if (request.minify && metro.minifyRefusal !== null) return refused(version, metro.minifyRefusal)
    const entryPath = entryOf(config, request)
    if (entryPath === null) return null
    // As Metro asks the config for each bundle.
    const target = { platform: request.platform, dev: request.dev }
    const [transformRefusal, inlineRequires] = await Promise.all([metro.transformRefusal(entryPath, target), metro.inlineRequires(entryPath, target)])
    if (transformRefusal !== null) return refused(version, transformRefusal)
    const key = [entryPath, request.platform, request.dev, request.minify].join('\0')
    // Its `changes`, a watcher's since its last build started; null, a full build: its first, or one asked for.
    const build = builds.get(key) ?? { request, entryPath, ...open(config, request, entryPath, inlineRequires), last: null, good: null, version: null, outcome: Promise.resolve(), waiting: new Set(), changes: null }
    builds.delete(key)
    builds.set(key, build)
    // Its build on its chain before another request may evict it.
    build.waiting.add(onProgress)
    const outcome = outcomeOf(build).finally(() => build.waiting.delete(onProgress))
    void evict(maxBuilds)
    return outcome
  }

  // Those each build read, and its last good one: watched while a build fails, as its app runs those.
  const files = () => new Set([...builds.values()].flatMap((build) => [...(build.last?.files ?? []), ...(build.good?.files ?? [])]))
  const uncovered = () => unwatched(config.caches, files())

  return {
    get,
    // A file changed, as a watcher saw it (`path`, its `event`, fs.watch()'s): each build is stale, and the
    // next builds again what the change may make another: the file, and each under it (a directory), let go
    // from the files kept in memory, and its resolutions (build-host.js's resolutionOf()) of the change. Of
    // no path (a reload `r` asks for), each builds all anew, resolving and reading each file again.
    changed(path = null, event = null) {
      version++
      for (const build of builds.values()) {
        if (path === null) build.changes = null
        else build.changes?.push({ path, event })
      }
      if (path === null) return
      config.edits.set(path, version)
      forget(config.caches, path)
    },
    // Rebuilds each bundle served: [{ request, before, after, good }], `good` its last build that didn't
    // fail. Where a file added or removed (an `index.ios.js`) makes the request name another entry, `good` is null.
    async refresh() {
      const out = []
      for (const [key, build] of [...builds]) {
        if (build.last === null) continue
        const { last: before, good } = build
        const entryPath = entryOf(config, build.request)
        if (entryPath === null || entryPath === build.entryPath) {
          out.push({ request: build.request, before, after: await outcomeOf(build), good })
          continue
        }
        builds.delete(key)
        await drop(build)
        out.push({ request: build.request, before, after: await get(build.request), good: null })
      }
      return out
    },
    // The files each bundle's last build read.
    files,
    // The asset a bundle built at `/assets/...`, else null.
    asset: (httpServerLocation, name, type) => [...builds.values()].flatMap(({ last }) => (last?.ok ? last.assets : [])).find((data) => data.httpServerLocation === httpServerLocation && data.name === name && data.type === type) ?? null,
    // A file a bundle was built from, its bytes, else null.
    sourceFile: (path) => (files().has(path) ? host.readFile(path) : null),
    // A source a bundle was built from, as text; else null, as where it isn't UTF-8.
    readSource: (path) => (files().has(path) ? utf8(host.readFile(path)) : null),
    dispose: () => evict(0),
  }
}

// The files kept in memory that no build read (`watched`, the dev bundler's files()) let go: the watcher sees
// no change of them, which a watcher-caused build would take unread (bundle.js's trustedOf()).
function unwatched(caches, watched) {
  for (const { files: kept } of caches.values()) for (const path of kept.keys()) if (!watched.has(path)) kept.delete(path)
}

// The version of the last change the watcher saw of `path`, or of a directory it is in; 0 of none.
function changedAt(edits, path) {
  let at = 0
  for (let each = path; ; each = dirname(each)) {
    at = Math.max(at, edits.get(each) ?? 0)
    if (dirname(each) === each) return at
  }
}

// The file at `path`, and each under it (a directory), let go from the files each target keeps in memory.
function forget(caches, path) {
  const under = `${path}${sep}`
  for (const { files: kept } of caches.values()) {
    kept.delete(path)
    for (const key of kept.keys()) if (key.startsWith(under)) kept.delete(key)
  }
}

// A build, disposed of once those asked for are done.
async function drop(build) {
  await build.outcome.catch(() => {})
  try {
    await (await build.bundler).dispose()
  } catch {
    // Never opened.
  }
}

// Metro's resolver options, as the config has them for `dev`.
const resolving = (metro, dev) => ({ assetExts: metro.assetExts, resolver: { ...metro.resolver, dev }, blockList: metro.blockList })

// The entry a request names, as Metro resolves it from the project root, and only there.
function entryOf({ projectRoot, host, metro }, { entryFile, platform, dev }) {
  const resolution = metroResolverOf({ host, ...resolving(metro, dev) })(`${projectRoot}${sep}.`, entryFile, { platform })
  return resolution?.type === 'sourceFile' && inside(projectRoot, resolution.filePath) ? resolution.filePath : null
}

// Its files are cached per platform, dev, minify and inline requires, which make them; with `esm`, so are
// those left CommonJS, which a file's cached build depends on. Returns { bundler, store }.
function open({ projectRoot, esbuild, targetOptions, host, metro, runtime, injected, caches, ids, edits }, { platform, dev, minify }, entryPath, inlineRequires) {
  const target = `${platform}\0${dev}\0${minify}\0${JSON.stringify(inlineRequires)}`
  if (!caches.has(target)) caches.set(target, { files: new Map(), modules: new Map(), commonJs: new Set() })
  const cached = caches.get(target)
  const options = targetOptions({ platform, dev, inlineRequires })
  const common = {
    ...options,
    ...resolving(metro, dev),
    entry: entryPath,
    platform,
    esbuild,
    host,
    projectRoot,
    minify,
    minifySyntax: !dev,
    cache: cached.files,
    changedAt: (path) => changedAt(edits, path),
    commonJs: cached.commonJs,
    polyfills: metro.polyfills(platform),
    runBeforeMain: metro.runBeforeMain?.(entryPath),
    assetRegistryPath: metro.assetRegistryPath,
    prelude: prelude(options.define?.__DEV__ ?? String(dev), dev ? 'development' : 'production'),
  }
  const bundler = dev && runtime !== null ? createModuleBundler({ ...common, runtime, injected, ids, builds: cached.modules }) : createBundler({ ...common, outfile: 'rn-serve.bundle.js', sourcemap: true })
  return { bundler, store: options.store }
}

async function run({ projectRoot, onBuild }, build, at) {
  const bundler = await build.bundler
  const start = performance.now()
  build.store?.start()
  // Those seen since: a change seen as it builds is the next build's.
  const { changes } = build
  build.changes = []
  try {
    const result = await bundler.rebuild(
      (done, total) => {
        for (const onProgress of build.waiting) onProgress?.(done, total)
      },
      changes,
      at,
    )
    // Not js or map: a module bundler's are getters, each made when a client first asks for it.
    const { outputFiles, modules, entryId, scripts, assets, files, bundled = null } = result
    const text = (ext) => outputFiles.find(({ path }) => path.endsWith(ext)).text
    const built = modules === undefined ? { js: text('.js'), map: text('.map') } : { modules, entryId, scripts }
    build.last = withIndex({ ok: true, version: at, ...built, assets, files: new Set(files) }, projectRoot, bundled)
    build.good = build.last
  } catch (error) {
    if (!Array.isArray(error?.errors)) throw error
    build.last = { ok: false, version: at, errors: error.errors, files: new Set(error.files) }
  }
  onBuild({ request: build.request, outcome: build.last, ms: Math.round(performance.now() - start), cached: build.store?.finish().tally ?? null })
  return build.last
}

// The module an update names by its path, as an outcome of its definition and map, from the last build
// that has it of a bundle for the request's platform, dev and minify.
function moduleOutcome(builds, { entryFile, platform, dev, minify }, projectRoot) {
  const name = moduleName(entryFile)
  for (const { request, last } of [...builds.values()].toReversed()) {
    if (request.platform !== platform || request.dev !== dev || request.minify !== minify || last?.modules === undefined) continue
    const record = [...last.modules.values()].find((each) => each.name === name)
    if (record !== undefined) return withIndex({ ok: true, version: last.version, js: defineCall(record), map: JSON.stringify(concatMaps(wrapped(record))), assets: [], files: new Set() }, projectRoot)
  }
  return null
}

// The outcome, its source map indexed when first asked for; of `bundled` (a module bundler's, { js(),
// map() }), its js and its map as it makes each, when first asked for.
function withIndex(outcome, projectRoot, bundled = null) {
  let index = null
  const indexOf = () => {
    const map = JSON.parse(made.map)
    return { ...indexMappings(map.mappings), sources: map.sources.map((source) => (NAMESPACED.test(source) ? undefined : resolve(projectRoot, source))) }
  }
  const made = { ...outcome, index: () => (index ??= indexOf()) }
  return bundled === null ? made : Object.defineProperties(made, { js: { get: bundled.js, enumerable: true }, map: { get: bundled.map, enumerable: true } })
}
