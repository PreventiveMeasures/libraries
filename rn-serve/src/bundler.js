// The bundler of a bundle rn-serve has esbuild build whole (a release one, or a dev one where the app has no
// metro-runtime): bundle.js's build on one esbuild context, whose builds a watcher causes take each file
// unchanged from memory and keep the resolutions their changes leave.

import { buildOptions, linking, lowersLetOf, metroGraph, withDefaults } from '@preventive/rn/src/bundle.js'
import { resolutionOf } from './resolution.js'

// bundle() on one esbuild context: each full rebuild resolves and reads every file anew, but `cache`'s; a
// watcher-caused one keeps the resolutions its changes leave (resolution.js's resolutionOf()), and takes
// each file `cache` has from it (keptOf()). options.changedAt(path): the dev bundler's version of the last
// change its watcher saw of the file, or of a directory it is in.
export async function createBundler(options) {
  const run = withDefaults(options)
  run.resolution = resolutionOf(run)
  run.kept = (path) => keptOf(run, path)
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

// Of a watcher-caused build (options.trusted), a file as options.cache has it, unread: a change the watcher
// sees lets the file go from the cache (dev-bundler.js's changed()). Not one a build read before a change of
// it the watcher saw (options.changedAt()): a load under way as it changes keeps what it read before. Else
// undefined, the file read.
export function keptOf(options, path) {
  const hit = options.trusted ? options.cache?.get(path) : undefined
  const since = options.changedAt?.(path) ?? null
  return hit === undefined || (since !== null && !(hit.at >= since)) ? undefined : hit.result
}
