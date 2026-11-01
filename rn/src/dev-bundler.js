// The bundles a dev server serves: one for each entry, platform, dev and
// minify asked for (the last `maxBuilds` of them), each built again once a
// file changes, each file's transform kept in memory while its source is the
// same, with its source map. A dev bundle in Metro's module format, for Fast
// Refresh (modules.js), where metro-runtime's require is given (`runtime`);
// else, as rn-bundle builds a bundle, on an esbuild context, as Metro's
// serializer has it (serializer.js).

import { isAbsolute, relative, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'

import { createBundler, metroResolverOf } from './bundle.js'
import { defaults, diskHost } from './defaults.js'
import { moduleName } from './hot.js'
import { concatMaps, indexMappings } from './mappings.js'
import { createModuleBundler, defineCall } from './modules.js'
import { prelude } from './serializer.js'
const NAMESPACED = /^metro-[a-z]+:/u
const decoder = new TextDecoder()

export const inside = (root, path) => {
  const rel = relative(root, path)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

// `targetOptions({ platform, dev })` -> the options bundle() takes for the
// project's files: jsx, stripFlow, babel..., aliases, define. `onBuild({
// request, outcome, ms })` after each build.
// Of Metro's config: `resolver` and `blockList` as bundle() takes them,
// `polyfills` a list or a function of the platform to one, `runBeforeMain`
// null or a function of the entry's path to the modules run before it,
// `assetRegistryPath`, and `minifyRefusal`, where its minifier's options are
// not done, the error each minified bundle fails with.
export function createDevBundler({ projectRoot, esbuild, targetOptions, host = diskHost, assetExts = defaults.assetExts, resolver = {}, blockList = null, polyfills = [], runBeforeMain = null, assetRegistryPath = null, minifyRefusal = null, runtime = null, maxBuilds = 8, onBuild = () => {} }) {
  const config = { projectRoot, esbuild, targetOptions, host, assetExts, resolver, blockList, polyfills, runBeforeMain, assetRegistryPath, runtime, onBuild, caches: new Map(), ids: new Map() }
  const builds = new Map()
  let version = 0

  // Built anew where a file changed since; one build of each at a time.
  const outcomeOf = (build) => {
    if (build.last?.version === version) return build.last
    if (build.pending?.version === version) return build.pending.promise
    const at = version
    const promise = build.chain.then(() => run(config, build, at))
    build.chain = promise.catch(() => {})
    build.pending = { version: at, promise }
    return promise
  }

  // Disposed once its builds asked for are done.
  const drop = async (build) => {
    await build.chain
    try {
      await (await build.bundler).dispose()
    } catch {
      // Never opened.
    }
  }
  // The least recently asked for, out at once, disposed after.
  const evict = (limit) => {
    const dropped = []
    while (builds.size > limit) {
      const [key, build] = builds.entries().next().value
      builds.delete(key)
      dropped.push(drop(build))
    }
    return Promise.all(dropped)
  }

  // -> an outcome: { ok: true, js, map, assets, files, index() }, and in
  // the module format `modules` and `entryId`; { ok: false, errors, files };
  // null where the request names no entry here. A `shallow` request, a
  // module's, as an update names it: its module of the last build of a
  // bundle that has it, alone.
  const get = (request) => {
    if (request.shallow) return moduleOutcome(builds, request, projectRoot)
    if (request.minify && minifyRefusal !== null) return { ok: false, version, errors: [{ text: minifyRefusal, location: null }], files: new Set() }
    const entry = entryOf(config, request)
    if (entry === null) return null
    const key = [entry.path, request.platform, request.dev, request.minify].join('\0')
    const build = builds.get(key) ?? { request, entryPath: entry.path, bundler: open(config, request, entry), last: null, good: null, pending: null, chain: Promise.resolve() }
    builds.delete(key)
    builds.set(key, build)
    // Its build on its chain before another request may evict it.
    const outcome = outcomeOf(build)
    void evict(maxBuilds)
    return outcome
  }

  const files = () => new Set([...builds.values()].flatMap((build) => [...(build.last?.files ?? [])]))

  return {
    get,
    // A file changed: each build is stale.
    changed() {
      version++
    },
    // -> [{ request, before, after, good }] of each bundle served, built
    // anew, `good` its last build that didn't fail before; of the entry its
    // request names now, where a file added or removed (an `index.ios.js`)
    // makes that another, whose `good` is null.
    async refresh() {
      const out = []
      for (const [key, build] of [...builds]) {
        if (build.last === null) continue
        const { last: before, good } = build
        const entry = entryOf(config, build.request)
        if (entry === null || entry.path === build.entryPath) {
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
    asset(httpServerLocation, name, type) {
      for (const build of builds.values()) {
        const found = build.last?.ok ? build.last.assets.find((data) => data.httpServerLocation === httpServerLocation && data.name === name && data.type === type) : undefined
        if (found !== undefined) return found
      }
      return null
    },
    // A source a bundle was built from, else null.
    readSource(path) {
      return files().has(path) ? decoder.decode(host.readFile(path)) : null
    },
    dispose: () => evict(0),
  }
}

// The entry a request names, as Metro resolves it from the project root,
// and only there.
function entryOf({ projectRoot, host, assetExts, resolver, blockList }, { entryFile, platform }) {
  const resolution = metroResolverOf({ host, assetExts, resolver, blockList })(`${projectRoot}${sep}.`, entryFile, { platform })
  return resolution?.type === 'sourceFile' && inside(projectRoot, resolution.filePath) ? { path: resolution.filePath } : null
}

function open({ projectRoot, esbuild, targetOptions, host, assetExts, resolver, blockList, polyfills, runBeforeMain, assetRegistryPath, runtime, caches, ids }, { platform, dev, minify }, entry) {
  const target = `${platform}\0${dev}\0${minify}`
  if (!caches.has(target)) caches.set(target, { files: new Map(), modules: new Map() })
  const options = targetOptions({ platform, dev })
  const common = {
    ...options,
    entry: entry.path,
    platform,
    esbuild,
    host,
    projectRoot,
    assetExts,
    minify,
    cache: caches.get(target).files,
    resolver,
    blockList,
    polyfills: typeof polyfills === 'function' ? polyfills(platform) : polyfills,
    runBeforeMain: runBeforeMain?.(entry.path) ?? null,
    assetRegistryPath,
    prelude: prelude(options.define?.__DEV__ ?? String(dev), dev ? 'development' : 'production'),
  }
  if (dev && runtime !== null) return createModuleBundler({ ...common, runtime, ids, builds: caches.get(target).modules })
  return createBundler({ ...common, outfile: 'rn-serve.bundle.js', sourcemap: true })
}

async function run({ projectRoot, onBuild }, build, at) {
  if (build.last?.version === at) return build.last
  const bundler = await build.bundler
  const start = performance.now()
  try {
    const result = await bundler.rebuild()
    const { outputFiles, assets, files } = result
    const text = (ext) => outputFiles.find(({ path }) => path.endsWith(ext)).text
    const built = result.modules === undefined ? { js: text('.js'), map: text('.map') } : { js: result.js, map: result.map, modules: result.modules, entryId: result.entryId, scripts: result.scripts }
    build.last = withIndex({ ok: true, version: at, ...built, assets, files: new Set(files) }, projectRoot)
    build.good = build.last
  } catch (error) {
    if (!Array.isArray(error?.errors)) throw error
    build.last = { ok: false, version: at, errors: error.errors, files: new Set(error.files ?? []) }
  }
  onBuild({ request: build.request, outcome: build.last, ms: Math.round(performance.now() - start) })
  return build.last
}

// A module of the last build of a bundle for the request's platform, dev and
// minify that has it, by its path, as an update names it, as an outcome: its
// definition and map.
function moduleOutcome(builds, { entryFile, platform, dev, minify }, projectRoot) {
  const name = moduleName(entryFile)
  for (const build of [...builds.values()].toReversed()) {
    if (build.request.platform !== platform || build.request.dev !== dev || build.request.minify !== minify || build.last?.modules === undefined) continue
    for (const record of build.last.modules.values()) {
      if (record.name !== name) continue
      const map = JSON.stringify(concatMaps([{ lines: 1, piece: null }, { lines: record.lines, piece: record.piece }, { lines: 1, piece: null }]))
      return withIndex({ ok: true, version: build.last.version, js: defineCall(record), map, assets: [], files: new Set() }, projectRoot)
    }
  }
  return null
}

// The outcome's source map, indexed when first asked for.
function withIndex(outcome, projectRoot) {
  let index = null
  return {
    ...outcome,
    index() {
      if (index !== null) return index
      const map = JSON.parse(outcome.map)
      const sources = map.sources.map((source) => (NAMESPACED.test(source) ? undefined : resolve(projectRoot, source)))
      index = { ...indexMappings(map.mappings), sources }
      return index
    },
  }
}
