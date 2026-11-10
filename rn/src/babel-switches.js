// rn.config.json's `babel`: plugins switched off (never run) or on (run on every file, even where rn would
// skip it or have esbuild lower its syntax; added after the config's plugins if it lacks them). A plugin is
// named by its key ("transform-classes") or by its package or path; named twice, the later wins.

import { createRequire } from 'node:module'
import { join } from 'node:path'

// Set in a switched-on plugin's options by babelPlugins(), for load.js.
export const FORCED = Symbol('rn: switched on in rn.config.json')

// [[name, on]] -> { off, on } (Sets of keys), `added` (those on, in order) and `errors`. A plugin that
// fails to load without options takes them from its entry in the Babel config (`config`), if any.
export function switchesOf(core, entries, options, config) {
  const load = (plugin) => core.loadOptionsSync({ ...options, babelrc: false, configFile: false, plugins: [plugin] }).plugins[0] ?? null
  // The Babel config's own plugin entries, with their options.
  let items = null
  const errors = []
  const loaded = (name) => {
    try {
      return load(name)
    } catch (error) {
      // No module of that name: it is a plugin key.
      if (error.code === 'MODULE_NOT_FOUND') return null
      // The config's entry for it, by name as written or as resolved.
      let resolved = null
      try {
        resolved = createRequire(join(options.cwd, 'package.json')).resolve(name)
      } catch {}
      items ??= core.loadPartialConfigSync(config)?.options.plugins ?? []
      const item = items.find(({ file }) => file !== undefined && (file.request === name || file.resolved === resolved))
      try {
        if (item !== undefined) return load([item.value, item.options])
      } catch {}
      const why = error.message.replace(/^\[BABEL\][^:]*: /u, '').replace(/\s*\(While processing:[^)]*\)\s*$/u, '')
      errors.push(`rn.config.json's babel names ${name}, which Babel can't load without its options (${why}), and the Babel config has no plugin of it to take them from: name it by its key, as --profile shows it`)
      return null
    }
  }
  const byKey = new Map()
  for (const [name, on] of entries) {
    const plugin = loaded(name)
    const key = plugin?.key ?? name
    byKey.delete(key)
    byKey.set(key, { key, name, on, plugin })
  }
  const all = [...byKey.values()]
  const keys = (on) => new Set(all.filter((each) => each.on === on).map(({ key }) => key))
  return { off: keys(false), on: keys(true), added: all.filter(({ on }) => on), errors }
}
