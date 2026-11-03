// rn.config.json's babel: Babel plugins switched off (false: never run) or on (true: run on every
// file). On, a plugin of the Babel config runs even where rn would skip it or have esbuild lower its
// syntax first; one the config lacks is added after the config's plugins, in the order named. A plugin
// is named by the key Babel gives it loaded ("transform-classes") or by what Babel loads it from (its
// package, "@babel/plugin-transform-classes", or a path); named twice, the later holds.

import { createRequire } from 'node:module'
import { join } from 'node:path'

// Marks a plugin switched on, in the options babelPlugins() maps its key to (load.js reads it).
export const FORCED = Symbol('rn: switched on in rn.config.json')

// `entries`, [[name, on]] in order, by key: { off, on } (Sets of keys); `added`, the ones on in order,
// each { key, name, plugin }: the plugin loaded by `core` with `options` (cwd, root, caller, envName,
// as the config's are), or null where Babel finds no module of that name (then a key alone); and
// `errors`, of names Babel can't load: a plugin that throws without its options, which `config` (the
// Babel config's options, of a file at its root) has none of to load it with.
export function switchesOf(core, entries, options, config) {
  let items = null
  // The Babel config's own plugins, as it names them, and their options.
  const configItems = () => (items ??= core.loadPartialConfigSync(config)?.options.plugins ?? [])
  const byKey = new Map()
  const errors = []
  for (const [name, on] of entries) {
    const { plugin, error } = loaded(core, name, options, configItems)
    if (error !== null) errors.push(error)
    const key = plugin?.key ?? name
    byKey.delete(key)
    byKey.set(key, { key, name, on, plugin })
  }
  const all = [...byKey.values()]
  const keys = (on) => new Set(all.filter((each) => each.on === on).map(({ key }) => key))
  return { off: keys(false), on: keys(true), added: all.filter(({ on }) => on), errors }
}

// -> { plugin, error }: the plugin of `name` as Babel loads it; of one that throws without its
// options, as the Babel config has it (by the module it names, as written or resolved), of them.
function loaded(core, name, options, configItems) {
  const load = (plugin) => core.loadOptionsSync({ ...options, babelrc: false, configFile: false, plugins: [plugin] }).plugins[0] ?? null
  try {
    return { plugin: load(name), error: null }
  } catch (error) {
    // No module of that name: a key, of a plugin the Babel config has.
    if (error.code === 'MODULE_NOT_FOUND') return { plugin: null, error: null }
    let resolved = null
    try {
      resolved = createRequire(join(options.cwd, 'package.json')).resolve(name)
    } catch {
      // Babel's name for it alone, as written in the config.
    }
    const item = configItems().find(({ file }) => file !== undefined && (file.request === name || file.resolved === resolved))
    if (item !== undefined) {
      try {
        return { plugin: load([item.value, item.options]), error: null }
      } catch {
        // As without them.
      }
    }
    const why = error.message.replace(/^\[BABEL\][^:]*: /u, '').replace(/\s*\(While processing:[^)]*\)\s*$/u, '')
    return { plugin: null, error: `rn.config.json's babel names ${name}, which Babel can't load without its options (${why}), and the Babel config has no plugin of it to take them from: name it by its key, as --profile shows it` }
  }
}
