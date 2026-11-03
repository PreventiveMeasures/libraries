// rn.config.json's babel: Babel plugins switched off (false: never run) or on (true: run on every
// file). On, a plugin of the Babel config runs even where rn would skip it or have esbuild lower its
// syntax first; one the config lacks is added after the config's plugins, in the order named. A plugin
// is named by the key Babel gives it loaded ("transform-classes") or by what Babel loads it from (its
// package, "@babel/plugin-transform-classes"); named twice, the later holds.

// Marks a plugin switched on, in the options babelPlugins() maps its key to (load.js reads it).
export const FORCED = Symbol('rn: switched on in rn.config.json')

// `entries`, [[name, on]] in order, by key: { off, on } (Sets of keys), and `added`, the ones on in
// order, each { key, name, plugin }: the plugin loaded by `core` with `options` (cwd, root, caller,
// envName, as the config's are), or null where Babel finds none by that name (then a key alone).
export function switchesOf(core, entries, options) {
  const byKey = new Map()
  for (const [name, on] of entries) {
    let plugin = null
    try {
      plugin = core.loadOptionsSync({ ...options, babelrc: false, configFile: false, plugins: [name] }).plugins[0] ?? null
    } catch {
      // Not a plugin Babel finds: a key, of a plugin the Babel config has.
    }
    const key = plugin?.key ?? name
    byKey.delete(key)
    byKey.set(key, { key, name, on, plugin })
  }
  const all = [...byKey.values()]
  const keys = (on) => new Set(all.filter((each) => each.on === on).map(({ key }) => key))
  return { off: keys(false), on: keys(true), added: all.filter(({ on }) => on) }
}
