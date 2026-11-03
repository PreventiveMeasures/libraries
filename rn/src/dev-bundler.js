// The bundles a dev server serves, one per entry, platform, dev and minify asked for (the last `maxBuilds`),
// each rebuilt once a file changes, each file's transform kept in memory while its source is the same. A dev
// bundle is in Metro's module format (modules.js) where metro-runtime's require is given, else as rn-bundle's.

import { isAbsolute, relative, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'

import { createBundler, metroResolverOf, utf8 } from './bundle.js'
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
  const config = { projectRoot, esbuild, targetOptions, host, metro, runtime, injected, onBuild, caches: new Map(), ids: new Map() }
  const builds = new Map()
  let version = 0

  // Rebuilds where a file changed since, one build of each bundle at a time.
  const outcomeOf = (build) => {
    if (build.last?.version === version) return build.last
    if (build.pending?.version === version) return build.pending.promise
    const at = version
    const promise = build.chain.then(() => run(config, build, at))
    build.chain = promise.catch(() => {})
    build.pending = { version: at, promise }
    return promise
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
    const [transformRefusal, inlineRequires] = await Promise.all([metro.transformRefusal, metro.inlineRequires].map((ask) => ask(entryPath, { platform: request.platform, dev: request.dev })))
    if (transformRefusal !== null) return refused(version, transformRefusal)
    const key = [entryPath, request.platform, request.dev, request.minify].join('\0')
    const build = builds.get(key) ?? { request, entryPath, ...open(config, request, entryPath, inlineRequires), last: null, good: null, pending: null, chain: Promise.resolve(), waiting: new Set() }
    builds.delete(key)
    builds.set(key, build)
    // Its build on its chain before another request may evict it.
    build.waiting.add(onProgress)
    const outcome = Promise.resolve(outcomeOf(build)).finally(() => build.waiting.delete(onProgress))
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
    asset(httpServerLocation, name, type) {
      for (const build of builds.values()) {
        const found = build.last?.ok ? build.last.assets.find((data) => data.httpServerLocation === httpServerLocation && data.name === name && data.type === type) : undefined
        if (found !== undefined) return found
      }
      return null
    },
    // A file a bundle was built from, its bytes, else null.
    sourceFile: (path) => (files().has(path) ? host.readFile(path) : null),
    // A source a bundle was built from, as text; else null, as where it isn't UTF-8.
    readSource: (path) => (files().has(path) ? utf8(host.readFile(path)) : null),
    dispose: () => evict(0),
  }
}

// A build, disposed of once those asked for are done.
async function drop(build) {
  await build.chain
  try {
    await (await build.bundler).dispose()
  } catch {
    // Never opened.
  }
}

// The entry a request names, as Metro resolves it from the project root, and only there.
function entryOf({ projectRoot, host, metro }, { entryFile, platform, dev }) {
  const resolution = metroResolverOf({ host, assetExts: metro.assetExts, resolver: { ...metro.resolver, dev }, blockList: metro.blockList })(`${projectRoot}${sep}.`, entryFile, { platform })
  return resolution?.type === 'sourceFile' && inside(projectRoot, resolution.filePath) ? resolution.filePath : null
}

// Its files are cached per platform, dev, minify and inline requires, which make them; with `esm`, so are
// those left CommonJS, which a file's cached build depends on. Returns { bundler, store }.
function open({ projectRoot, esbuild, targetOptions, host, metro, runtime, injected, caches, ids }, { platform, dev, minify }, entryPath, inlineRequires) {
  const target = `${platform}\0${dev}\0${minify}\0${JSON.stringify(inlineRequires)}`
  if (!caches.has(target)) caches.set(target, { files: new Map(), modules: new Map(), commonJs: new Set() })
  const cached = caches.get(target)
  const options = targetOptions({ platform, dev, inlineRequires })
  const common = {
    ...options,
    entry: entryPath,
    platform,
    esbuild,
    host,
    projectRoot,
    minify,
    cache: cached.files,
    commonJs: cached.commonJs,
    assetExts: metro.assetExts,
    resolver: { ...metro.resolver, dev },
    blockList: metro.blockList,
    polyfills: metro.polyfills(platform),
    runBeforeMain: metro.runBeforeMain?.(entryPath) ?? null,
    assetRegistryPath: metro.assetRegistryPath,
    prelude: prelude(options.define?.__DEV__ ?? String(dev), dev ? 'development' : 'production'),
  }
  const bundler = dev && runtime !== null ? createModuleBundler({ ...common, runtime, injected, ids, builds: cached.modules }) : createBundler({ ...common, outfile: 'rn-serve.bundle.js', sourcemap: true })
  return { bundler, store: options.store ?? null }
}

async function run({ projectRoot, onBuild }, build, at) {
  const bundler = await build.bundler
  const start = performance.now()
  build.store?.start()
  try {
    const result = await bundler.rebuild((done, total) => {
      for (const onProgress of build.waiting) onProgress?.(done, total)
    })
    const { outputFiles, assets, files } = result
    const text = (ext) => outputFiles.find(({ path }) => path.endsWith(ext)).text
    const built = result.modules === undefined ? { js: text('.js'), map: text('.map') } : { js: result.js, map: result.map, modules: result.modules, entryId: result.entryId, scripts: result.scripts }
    build.last = withIndex({ ok: true, version: at, ...built, assets, files: new Set(files) }, projectRoot)
    build.good = build.last
  } catch (error) {
    if (!Array.isArray(error?.errors)) throw error
    build.last = { ok: false, version: at, errors: error.errors, files: new Set(error.files ?? []) }
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

// The outcome, its source map indexed when first asked for.
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
