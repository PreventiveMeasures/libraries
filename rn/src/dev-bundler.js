// The bundles a dev server serves: one esbuild context for each entry,
// platform, dev and minify asked for (the last `maxBuilds` of them), each
// built again once a file changes, each file's transform kept in memory
// while its source is the same. As rn-bundle builds a bundle, as Metro's
// serializer has it (serializer.js), with its source map.

import { isAbsolute, relative, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'

import { createBundler } from './bundle.js'
import { defaults, diskHost } from './defaults.js'
import { indexMappings } from './mappings.js'
import { createMetroResolver } from './resolve.js'
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
export function createDevBundler({ projectRoot, esbuild, targetOptions, host = diskHost, assetExts = defaults.assetExts, polyfills = [], maxBuilds = 8, onBuild = () => {} }) {
  const config = { projectRoot, esbuild, targetOptions, host, assetExts, polyfills, onBuild, caches: new Map() }
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

  const drop = async (build) => {
    await build.chain
    try {
      await (await build.bundler).dispose()
    } catch {
      // Never opened.
    }
  }
  const evict = async (limit) => {
    while (builds.size > limit) {
      const [key, build] = builds.entries().next().value
      builds.delete(key)
      await drop(build)
    }
  }

  // -> an outcome: { ok: true, js, map, assets, files, index() }, { ok:
  // false, errors, files }; null where the request names no entry here.
  const get = async (request) => {
    const entry = entryOf(config, request)
    if (entry === null) return null
    const key = [entry.path, request.platform, request.dev, request.minify].join('\0')
    const build = builds.get(key) ?? { request, entryPath: entry.path, bundler: open(config, request, entry), last: null, pending: null, chain: Promise.resolve() }
    builds.delete(key)
    builds.set(key, build)
    await evict(maxBuilds)
    return outcomeOf(build)
  }

  const files = () => new Set([...builds.values()].flatMap((build) => [...(build.last?.files ?? [])]))

  return {
    get,
    // A file changed: each build is stale.
    changed() {
      version++
    },
    // -> [{ request, before, after }] of each bundle served, built anew; of
    // the entry its request names now, where a file added or removed (an
    // `index.ios.js`) makes that another.
    async refresh() {
      const out = []
      for (const [key, build] of [...builds]) {
        if (build.last === null) continue
        const before = build.last
        const entry = entryOf(config, build.request)
        if (entry === null || entry.path === build.entryPath) {
          out.push({ request: build.request, before, after: await outcomeOf(build) })
          continue
        }
        builds.delete(key)
        await drop(build)
        out.push({ request: build.request, before, after: await get(build.request) })
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
function entryOf({ projectRoot, host, assetExts }, { entryFile, platform }) {
  const resolution = createMetroResolver({ host, assetExts })(`${projectRoot}${sep}.`, entryFile, { platform })
  return resolution?.type === 'sourceFile' && inside(projectRoot, resolution.filePath) ? { path: resolution.filePath } : null
}

function open({ projectRoot, esbuild, targetOptions, host, assetExts, polyfills, caches }, { platform, dev, minify }, entry) {
  const target = `${platform}\0${dev}`
  if (!caches.has(target)) caches.set(target, new Map())
  const options = targetOptions({ platform, dev })
  return createBundler({
    ...options,
    entry: entry.path,
    platform,
    outfile: 'rn-serve.bundle.js',
    esbuild,
    host,
    projectRoot,
    assetExts,
    sourcemap: true,
    minify,
    cache: caches.get(target),
    polyfills,
    prelude: prelude(options.define?.__DEV__ ?? String(dev), dev ? 'development' : 'production'),
  })
}

async function run({ projectRoot, onBuild }, build, at) {
  if (build.last?.version === at) return build.last
  const bundler = await build.bundler
  const start = performance.now()
  try {
    const { outputFiles, assets, files } = await bundler.rebuild()
    const text = (ext) => outputFiles.find(({ path }) => path.endsWith(ext)).text
    build.last = withIndex({ ok: true, version: at, js: text('.js'), map: text('.map'), assets, files: new Set(files) }, projectRoot)
  } catch (error) {
    if (!Array.isArray(error?.errors)) throw error
    build.last = { ok: false, version: at, errors: error.errors, files: new Set(error.files ?? []) }
  }
  onBuild({ request: build.request, outcome: build.last, ms: Math.round(performance.now() - start) })
  return build.last
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
