// rn.config.json's babel: Babel plugins switched off (false: never run) or on (true: run on every
// file). On, a plugin of the Babel config runs even where rn would skip it or have esbuild lower its
// syntax first; one the config lacks is added after the config's plugins, in the order named. A plugin
// is named by the key Babel gives it loaded ("transform-classes") or by what Babel loads it from (its
// package, "@babel/plugin-transform-classes", or a path); named twice, the later holds.

import { createRequire } from 'node:module'
import { join } from 'node:path'

// Marks a plugin switched on, in the options babelPlugins() maps its key to (load.js reads it).
export const FORCED = Symbol('rn: switched on in rn.config.json')

// `entries` ([[name, on]] in order) by key: { off, on } (Sets of keys), `added` (those on, in order, each
// { key, name, plugin }) and `errors`. A plugin is loaded by `core` with `options` (cwd, root, caller,
// envName, as the config's are), null where no module has that name (a key alone). One that throws
// without its options takes them from `config` (the Babel config's, of a file at its root), else errs.
export function switchesOf(core, entries, options, config) {
  const load = (plugin) => core.loadOptionsSync({ ...options, babelrc: false, configFile: false, plugins: [plugin] }).plugins[0] ?? null
  // The Babel config's own plugins, as it names them, and their options.
  let items = null
  const errors = []
  const loaded = (name) => {
    try {
      return load(name)
    } catch (error) {
      // No module of that name: a key, of a plugin the Babel config has.
      if (error.code === 'MODULE_NOT_FOUND') return null
      // As the config names it, written or resolved.
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
