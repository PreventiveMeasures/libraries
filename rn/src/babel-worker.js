// Babel's transforms, off the main thread: each worker loads the project's
// @babel/core and its config once, and transforms what it is sent.

import { once } from 'node:events'
import { createRequire } from 'node:module'
import { availableParallelism } from 'node:os'
import { isAbsolute, relative } from 'node:path'
import { MessageChannel, Worker, parentPort, workerData } from 'node:worker_threads'

// (corePath, options, profile) => async (source, filename, without = []) =>
// { code, imports }, by the @babel/core at corePath, with options (all but
// the filename) for each file, its config's plugins of the keys in without
// left out; with options.refresh, react-refresh's Babel plugin at that path
// for each file outside node_modules, as Metro's transformer adds it for Fast
// Refresh. `imports`, the specifiers of the file's import and export-from
// declarations (IMPORTS). Where profile is newProfile()'s, the time of each
// transform is added to it, and that of each plugin: its visitors' and
// hooks', by its key.
export function babelWorkers(corePath, options, profile = null) {
  const max = availableParallelism() >= 4 ? 2 : 1
  const workers = []
  const pick = () => {
    const idle = workers.find(({ busy }) => busy === 0)
    if (idle !== undefined || workers.length >= max) return idle ?? workers.reduce((a, b) => (b.busy < a.busy ? b : a))
    const info = { worker: new Worker(new URL(import.meta.url), { workerData: { babel: { corePath, options, profile: profile !== null } } }), busy: 0, pending: new Set() }
    // A worker that dies leaves the pool, failing what it was given, which
    // would wait forever; one more is made where needed.
    let failure
    info.worker.on('error', (error) => (failure = error))
    info.worker.on('exit', (code) => {
      workers.splice(workers.indexOf(info), 1)
      for (const reject of info.pending) reject(failure ?? new Error(`Babel's worker exited with code ${code}`))
    })
    workers.push(info)
    return info
  }
  return async (source, filename, without = []) => {
    const info = pick()
    const { port1, port2 } = new MessageChannel()
    const { promise: failed, reject } = Promise.withResolvers()
    // Busy, a worker keeps the process alive; idle, it doesn't.
    if (info.busy++ === 0) info.worker.ref()
    info.pending.add(reject)
    try {
      info.worker.postMessage({ port: port1, source, filename, without }, [port1])
      const [{ code, imports, error, loc, spent }] = await Promise.race([once(port2, 'message'), failed])
      // Babel's error, with where in the file Babel says, if it does.
      if (error !== undefined) throw Object.assign(new Error(error), loc === undefined ? {} : { loc })
      if (spent !== undefined) addSpent(profile, spent)
      return { code, imports }
    } finally {
      if (--info.busy === 0) info.worker.unref()
      info.pending.delete(reject)
      port2.close()
    }
  }
}

// Babel's own work, outside its plugins, by what it is.
const OWN = ['config', 'parsing', 'scopes', 'printing']

// { files, ms, plugins, own }, which babelWorkers adds to: plugins a
// Map<key, { files, calls, ms }>, `files` those a plugin's visitors (or its
// parser or printer) ran in, not all it is in; own one by each of OWN.
export function newProfile() {
  return { files: 0, ms: 0, plugins: new Map(), own: new Map() }
}

function addSpent(profile, { ms, plugins, own }) {
  profile.files++
  profile.ms += ms
  for (const [map, entries] of [[profile.plugins, plugins], [profile.own, own]]) {
    for (const [key, calls, time, worked] of entries) {
      const sum = map.get(key) ?? { files: 0, calls: 0, ms: 0 }
      map.set(key, { files: sum.files + (worked ? 1 : 0), calls: sum.calls + calls, ms: sum.ms + time })
    }
  }
}

// A table of the time each plugin took, most first, then Babel's own, by
// what it is, and the rest. Keys that are paths, of plugins with no name,
// are made relative to root.
export function profileReport({ files, ms, plugins, own }, root) {
  const line = (...cells) => cells.map((cell, i) => String(cell).padStart([8, 6, 7, 9, 0][i])).join('  ')
  const row = (time, ...cells) => line(Math.round(time), ms > 0 ? ((100 * time) / ms).toFixed(1) : '0.0', ...cells)
  const sorted = [...plugins].toSorted(([, a], [, b]) => b.ms - a.ms)
  const owned = OWN.map((name) => [name, own.get(name) ?? { files: 0, calls: 0, ms: 0 }])
  const rest = ms - [...sorted, ...owned].reduce((sum, [, entry]) => sum + entry.ms, 0)
  return [
    `Babel: ${files} files, ${Math.round(ms)} ms, summed over its workers`,
    line('ms', '%', 'files', 'calls', 'plugin'),
    ...sorted.map(([key, plugin]) => row(plugin.ms, plugin.files, plugin.calls, isAbsolute(key) ? relative(root, key) : key)),
    line('ms', '%', 'files', 'calls', 'Babel, outside plugins'),
    ...owned.map(([name, entry]) => row(entry.ms, entry.files, entry.calls, name)),
    row(rest, '', '', 'traversal, and the rest'),
    '',
  ].join('\n')
}

if (workerData?.babel !== undefined) {
  const { corePath, options: { refresh = null, ...given }, profile } = workerData.babel
  const core = createRequire(corePath)(corePath)
  // The specifiers of the file's import and export-from declarations, but
  // types', as Metro's transformer records where each is (its
  // importLocationsPlugin): the require call Babel's CommonJS makes of one,
  // Metro resolves as an ESM import (bundle.js).
  let imports = new Set()
  const IMPORTS = {
    name: 'rn-bundle-imports',
    visitor: {
      'ImportDeclaration|ExportNamedDeclaration|ExportAllDeclaration'({ node }) {
        if (node.source != null && node.loc != null && (node.importKind ?? node.exportKind) !== 'type') imports.add(node.source.value)
      },
    },
  }
  // As Metro's transformer has it, a file in node_modules has no component to edit.
  const optionsOf = (filename) => ({ ...given, filename, plugins: [...(given.plugins ?? []), IMPORTS, ...(refresh === null || filename.includes('node_modules') ? [] : [[refresh, { skipEnvCheck: true }]])] })
  // By plugin key, the calls and own time of its visitors and hooks, in the
  // file being transformed: a call's own, not that of a plugin it calls.
  let spent = new Map()
  let inner = 0
  // Plugin calls, and Babel's own work timed, under way.
  let depth = 0
  // Each call counted, its file one the plugin worked in where it does:
  // a visitor's, a parser's or printer's, not a pre or post hook's.
  const add = (map, key, ms, works = true, calls = 1) => {
    const [counted, time, worked] = map.get(key) ?? [0, 0, false]
    map.set(key, [counted + calls, time + ms, worked || works])
  }
  // Whether the call under way was a gated visitor's that didn't run (gate()).
  let skipped = false
  const timed = (key, fn, works = true) =>
    function (...args) {
      const start = performance.now()
      const before = inner
      depth++
      try {
        return fn.apply(this, args)
      } finally {
        depth--
        const elapsed = performance.now() - start
        add(spent, key, elapsed - (inner - before), works && !skipped, skipped ? 0 : 1)
        skipped = false
        inner = before + elapsed
      }
    }
  // By each of OWN, Babel's own work in the file, outside a plugin's call: in
  // one, a plugin's (a scope it crawls, code it parses or prints).
  let own = new Map()
  const time = (name, start) => add(own, name, performance.now() - start)
  const timeOwn = (name, object, method) => {
    const fn = object[method]
    object[method] = function (...args) {
      if (depth > 0) return fn.apply(this, args)
      const start = performance.now()
      depth++
      try {
        return fn.apply(this, args)
      } finally {
        depth--
        time(name, start)
      }
    }
  }
  if (profile) {
    // What @babel/core calls, of its own dependencies, as it calls it.
    const ofCore = createRequire(corePath)
    timeOwn('parsing', ofCore('@babel/parser'), 'parse')
    timeOwn('scopes', ofCore('@babel/traverse').Scope.prototype, 'crawl')
    timeOwn('printing', ofCore('@babel/generator'), 'default')
  }
  const hooked = new WeakSet()
  const timeHooks = (plugin) => {
    if (hooked.has(plugin)) return
    hooked.add(plugin)
    for (const hook of ['pre', 'post', 'parserOverride', 'generatorOverride']) if (typeof plugin[hook] === 'function') plugin[hook] = timed(plugin.key, plugin[hook], hook.endsWith('Override'))
  }
  // babel-plugin-module-resolver traverses each file on Program's enter and
  // exit, but rewrites nothing where no string in it names an alias, as its
  // options, normalized by its pre hook for the file, have each, with no
  // `root` and no `resolvePath` of its own: each instance's traversals run
  // only where one does, checked by a walk of the file's nodes as each would
  // start, with what other plugins added by then. A walk alone is its time,
  // not a call of it (timed()).
  const RESOLVER = 'module-resolver'
  const gated = new WeakSet()
  const names = (node, options) => {
    if (options?.root?.length !== 0 || options.customResolvePath !== undefined || !Array.isArray(options.alias) || !options.alias.every(([regExp]) => regExp instanceof RegExp)) return true
    let named = false
    core.types.traverseFast(node, (child) => {
      named ||= child.type === 'StringLiteral' && options.alias.some(([regExp]) => regExp.test(child.value))
    })
    return named
  }
  const gate = (fn) =>
    function (path, ...rest) {
      // `this`, the instance's pass, with its options for the file.
      if (names(path.node, this?.normalizedOpts)) return fn.call(this, path, ...rest)
      skipped = true
      return undefined
    }
  const gateResolver = (plugin) => {
    const program = plugin.visitor?.Program
    if (plugin.key !== RESOLVER || gated.has(plugin) || program === undefined) return
    gated.add(plugin)
    // Its own, not the Program visitor its instances share.
    const phases = Object.entries(program).map(([phase, fns]) => [phase, (phase === 'enter' || phase === 'exit') && Array.isArray(fns) ? fns.map(gate) : fns])
    plugin.visitor = { ...plugin.visitor, Program: Object.fromEntries(phases) }
  }
  // Sync: a worker transforms one file at a time.
  const transform = (source, filename, without) => {
    // The config's plugins, loaded, which transformSync takes as they are.
    const start = performance.now()
    const config = core.loadOptionsSync(optionsOf(filename))
    if (profile) time('config', start)
    const plugins = config.plugins.filter(({ key }) => !without.includes(key))
    plugins.forEach(gateResolver)
    if (!profile) return core.transformSync(source, { ...config, plugins })
    plugins.forEach(timeHooks)
    for (const { key } of plugins) spent.set(key, [0, 0, false])
    // Timed as the config's own visitor wrapper, if any, makes it.
    const wrap = config.wrapPluginVisitorMethod
    return core.transformSync(source, { ...config, plugins, wrapPluginVisitorMethod: (key, phase, fn) => timed(key, wrap === undefined ? fn : wrap(key, phase, fn)) })
  }
  // What the config's other plugins leave of let and const after its block
  // scoping plugin, as code they insert once it has run (Reanimated's
  // worklets), that plugin lowers again: Metro's output has none there, and
  // esbuild, told so, adds none after Babel (bundle.js).
  const LET = /\b(?:let|const)\b/u
  const lowerLeft = (result, filename) => {
    if (result === null || !LET.test(result.code)) return result
    const config = core.loadOptionsSync(optionsOf(filename))
    const blockScoping = config?.plugins.find(({ key }) => key === 'transform-block-scoping')
    if (blockScoping === undefined) return result
    // Parsed as the config parses (a return outside a function, if it takes one).
    const parsing = { sourceType: config.sourceType ?? 'unambiguous', ...(config.parserOpts && { parserOpts: config.parserOpts }) }
    return core.transformSync(result.code, { babelrc: false, configFile: false, cwd: given.cwd, filename, compact: false, ...parsing, plugins: [blockScoping], ...(given.sourceMaps && { sourceMaps: given.sourceMaps, inputSourceMap: true }) })
  }
  parentPort.on('message', ({ port, source, filename, without }) => {
    const start = performance.now()
    spent = new Map()
    own = new Map()
    imports = new Set()
    try {
      const { code } = lowerLeft(transform(source, filename, without), filename)
      const entries = (map) => [...map].map(([key, [calls, ms, worked]]) => [key, calls, ms, worked])
      port.postMessage({ code, imports: [...imports], ...(profile && { spent: { ms: performance.now() - start, plugins: entries(spent), own: entries(own) } }) })
    } catch (error) {
      port.postMessage({ error: error.message, ...(error.loc && { loc: { line: error.loc.line, column: error.loc.column } }) })
    }
    port.close()
  })
}
