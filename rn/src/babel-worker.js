// Babel's transforms, off the main thread: each worker loads the project's
// @babel/core and its config once, and transforms what it is sent; asked,
// gives a fingerprint of what its output is of (load-cache.js).

import { once } from 'node:events'
import { createRequire, enableCompileCache } from 'node:module'
import { availableParallelism } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { MessageChannel, Worker, parentPort, workerData } from 'node:worker_threads'

import { fingerprintOf, readsOf } from './load-cache.js'

// How many workers Babel runs in where nothing says: 2, of 4 CPUs or more,
// else 1; not Metro's getMaxWorkers of the CPUs (6 of 8, 8 of 12), which
// made a build slower. The main thread loads, resolves and hands out each
// file, about a sixth of a file's work, which the workers don't share, and
// each worker loads Babel and compiles its code anew (CPU and some 300 MB
// of each): workers the main thread can't keep busy cost that for nothing,
// and the threads, as many more as the CPUs' fast cores, slow it.
export function defaultWorkers(cores = availableParallelism()) {
  return cores >= 4 ? 2 : 1
}

// The files each worker has waiting before one more is made.
const BACKLOG = 8

// (corePath, options, profile, max) => async (source, filename, without = []) =>
// { code, imports }, by the @babel/core at corePath, with options (all but
// the filename) for each file, its config's plugins of the keys in without
// left out; with options.refresh, react-refresh's Babel plugin at that path
// for each file outside node_modules, as Metro's transformer adds it for Fast
// Refresh; with options.keepPlugins, module-resolver as its plugin has it
// (gateResolver()); with options.inlineRequires, metroOptions()'s, each
// file's requires inlined after its config's plugins, as Metro's transform
// worker inlines them (inlining()). `imports`, the specifiers of the file's import and
// export-from declarations (IMPORTS); `uncacheable` where a plugin's output
// is of files it names (its addExternalDependency), which may change. With
// options.fingerprint, the function's fingerprint() -> (a promise of) {
// fingerprint, options, modules, reads }: what its output is of but a
// file's own config and its source (load-cache.js's fingerprintOf()), as
// its workers have it once they load the config, and what it is a digest
// of. Where profile is newProfile()'s, the time of each
// transform is added to it, and that of each plugin: its visitors' and
// hooks', by its key. At most `max` workers (defaultWorkers() where null),
// one more made only as files wait: as each has BACKLOG of them or more. One
// starting costs some 300 ms of CPU, loading Babel and the config, which a
// few files, done by one in less, don't make up for.
export function babelWorkers(corePath, options, profile = null, max = null) {
  const most = max ?? defaultWorkers()
  const workers = []
  const pick = () => {
    const least = workers.reduce((a, b) => (a === undefined || b.busy < a.busy ? b : a), undefined)
    if (least !== undefined && (least.busy < BACKLOG || workers.length >= most)) return least
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
  // One made at once, which loads @babel/core and the config as the build
  // starts, not as its first file waits for it; idle, it keeps the process
  // alive no more than one made for a file.
  pick().worker.unref()
  // -> a worker's answer to the message.
  const ask = async (message) => {
    const info = pick()
    const { port1, port2 } = new MessageChannel()
    const { promise: failed, reject } = Promise.withResolvers()
    // Busy, a worker keeps the process alive; idle, it doesn't.
    if (info.busy++ === 0) info.worker.ref()
    info.pending.add(reject)
    try {
      info.worker.postMessage({ port: port1, ...message }, [port1])
      const [answer] = await Promise.race([once(port2, 'message'), failed])
      return answer
    } finally {
      if (--info.busy === 0) info.worker.unref()
      info.pending.delete(reject)
      port2.close()
    }
  }
  const transform = async (source, filename, without = []) => {
    const { code, imports, uncacheable, error, loc, spent } = await ask({ source, filename, without })
    // Babel's error, with where in the file Babel says, if it does.
    if (error !== undefined) throw Object.assign(new Error(error), loc === undefined ? {} : { loc })
    if (spent !== undefined) addSpent(profile, spent)
    return { code, imports, ...(uncacheable && { uncacheable }) }
  }
  let fingerprint = null
  return Object.assign(transform, { fingerprint: () => (fingerprint ??= ask({ fingerprint: true }).then((answer) => answer.fingerprint == null ? Promise.reject(new Error('no fingerprint: not asked for one')) : answer)) })
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

// Metro's inline-requires plugin, but on Program's exit only where the
// program has what it inlines: a top-level declaration of a var of an
// inlineable call (require, or one of its inlineableCalls) of a module named,
// or of a member expression of one, its object or its computed property
// (which Metro 0.78 on inlines not, of no property name, but its member
// alias takes in either), but not of its ignoredRequires nor @babel/runtime's,
// as it takes them. Elsewhere it crawls the program's scopes and walks it
// for none, to no change: there, it is left out.
export function gatedInlining(plugin) {
  return (api, options) => {
    const instance = plugin(api, options)
    const program = instance.visitor.Program
    const calls = new Set(['require', ...(options?.inlineableCalls ?? [])])
    const ignored = new Set(options?.ignoredRequires ?? [])
    // The module an inlineable call names, as the plugin reads it: of a
    // string, or of require.resolve's; else null.
    const moduleOf = (node) => {
      if (node?.type !== 'CallExpression' || node.callee.type !== 'Identifier' || !calls.has(node.callee.name) || node.arguments.length === 0) return null
      const [first] = node.arguments
      if (first.type === 'StringLiteral') return first.value
      const resolve = first.type === 'CallExpression' && first.callee.type === 'MemberExpression' && first.callee.object.type === 'Identifier' && calls.has(first.callee.object.name)
      return resolve && first.callee.property.type === 'Identifier' && first.callee.property.name === 'resolve' && first.arguments[0]?.type === 'StringLiteral' ? first.arguments[0].value : null
    }
    const inlinable = ({ init }) => {
      const name = moduleOf(init) ?? (init?.type === 'MemberExpression' ? (moduleOf(init.object) ?? moduleOf(init.property)) : null)
      return name !== null && !ignored.has(name) && !name.startsWith('@babel/runtime/')
    }
    const exit = program.exit
    program.exit = function (path, state) {
      if (path.node.body.some((statement) => statement.type === 'VariableDeclaration' && statement.declarations.some(inlinable))) return exit.call(this, path, state)
      return undefined
    }
    return instance
  }
}

if (workerData?.babel !== undefined) {
  const { corePath, options: { refresh = null, keepPlugins = false, inlineRequires = null, fingerprint: fingerprinted = false, ...given }, profile } = workerData.babel
  // A thread's own, as the bin's: @babel/core and the config's plugins compiled once.
  enableCompileCache()
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
  // As Metro's transform worker inlines requires, after its Babel
  // transformer, by its metro-transform-plugins: a module required at the
  // top, of a name (a var of its require call, or of a member of it, or
  // destructured) each use of which can take a call, required where used, not before the
  // module runs, and not at all where unused; not those of nonInlinedRequires
  // (React's, react-native) or of @babel/runtime, nor an interop's (Babel's
  // default and namespace imports), nor in a file of its blockList. After
  // the config's plugins, its presets' too (which run after its plugins),
  // the last, which does it all on Program's exit, after each other plugin's:
  // as a pass of its own after Babel, but on Babel's tree.
  const inlinePlugin = inlineRequires === null ? null : core.loadOptionsSync({ babelrc: false, configFile: false, cwd: given.cwd, plugins: [[gatedInlining(createRequire(inlineRequires.plugin)(inlineRequires.plugin).inlineRequiresPlugin), inlineRequires.options]] }).plugins[0]
  const inlining = (filename) => (inlinePlugin === null || inlineRequires.blockList.includes(filename) ? [] : [inlinePlugin])
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
  // exit for the source of each import and export declaration and the first
  // argument of each call of one of its transformFunctions or of import(),
  // which, a string, it maps by its resolvePath and replaces (its
  // mapPathString). With no `root` and no `resolvePath` of its own, as its
  // options, normalized by its pre hook for the file, have them, it changes
  // nothing where no string in the file names an alias: there each
  // instance's traversal is left out, else done by a walk of the file's
  // nodes, as Babel has them as it would start (with what other plugins
  // added by then), each such string mapped by its module's own resolvePath,
  // where the plugin is its module's. A traversal left out is its time, not
  // a call of it (timed()).
  const RESOLVER = 'module-resolver'
  const gated = new WeakSet()
  // Its module's resolvePath, where the plugin's Program visitor is its
  // module's: as the project resolves the module, as its Babel config does.
  const resolvePathOf = (enter) => {
    try {
      const resolver = createRequire(join(given.cwd ?? process.cwd(), 'package.json'))('babel-plugin-module-resolver')
      const its = resolver.default({ types: core.types }).visitor.Program.enter
      return (Array.isArray(its) ? its[0] : its) === enter && typeof resolver.resolvePath === 'function' ? resolver.resolvePath : null
    } catch {
      return null
    }
  }
  // Whether a call is of one of the patterns, as module-resolver's matchesPattern has it.
  const transforms = ({ callee }, patterns) =>
    core.types.isImport(callee) || patterns.some((pattern) => (core.types.isMemberExpression(callee) ? core.types.matchesPattern(callee, pattern) : core.types.isIdentifier(callee) && !pattern.includes('.') && callee.name === pattern))
  // -> null where no string in the node names an alias, else the nodes
  // module-resolver maps a string of: [node, key, index].
  const sitesOf = (node, { alias, transformFunctions }) => {
    let named = false
    const sites = []
    core.types.traverseFast(node, (child) => {
      named ||= child.type === 'StringLiteral' && alias.some(([regExp]) => regExp.test(child.value))
      if (core.types.isImportDeclaration(child) || core.types.isExportDeclaration(child)) sites.push([child, 'source'])
      else if (child.type === 'CallExpression' && transforms(child, transformFunctions)) sites.push([child, 'arguments', 0])
    })
    return named ? sites : null
  }
  // As module-resolver's mapPathString maps each, each node of it visited once.
  const resolve = (sites, pass, resolvePath) => {
    const visited = pass.moduleResolverVisited
    for (const [owner, key, index] of sites) {
      if (visited.has(owner)) continue
      visited.add(owner)
      const node = index === undefined ? owner[key] : owner[key][index]
      if (!core.types.isStringLiteral(node)) continue
      const modulePath = resolvePath(node.value, pass.file.opts.filename, pass.opts)
      if (!modulePath || node.pathResolved) continue
      const replacement = core.types.stringLiteral(modulePath)
      core.types.inheritsComments(replacement, node)
      core.types.removeComments(node)
      replacement.pathResolved = true
      if (index === undefined) owner[key] = replacement
      else owner[key][index] = replacement
    }
  }
  const aliasesAlone = (options) => options?.root?.length === 0 && options.customResolvePath === undefined && Array.isArray(options.alias) && options.alias.every(([regExp]) => regExp instanceof RegExp) && Array.isArray(options.transformFunctions) && options.transformFunctions.every((pattern) => typeof pattern === 'string')
  const gate = (fn, resolvePath) =>
    function (path, ...rest) {
      // `this`, the instance's pass, with its options for the file.
      const options = this?.normalizedOpts
      if (!aliasesAlone(options)) return fn.call(this, path, ...rest)
      const sites = sitesOf(path.node, options)
      if (sites === null) skipped = true
      else if (resolvePath === null || !(this.moduleResolverVisited instanceof Set)) return fn.call(this, path, ...rest)
      else resolve(sites, this, resolvePath)
      return undefined
    }
  const gateResolver = (plugin) => {
    const program = plugin.visitor?.Program
    if (plugin.key !== RESOLVER || gated.has(plugin) || program === undefined) return
    gated.add(plugin)
    const resolvePath = resolvePathOf(program.enter?.[0])
    // Its own, not the Program visitor its instances share.
    const phases = Object.entries(program).map(([phase, fns]) => [phase, (phase === 'enter' || phase === 'exit') && Array.isArray(fns) ? fns.map((fn) => gate(fn, resolvePath)) : fns])
    plugin.visitor = { ...plugin.visitor, Program: Object.fromEntries(phases) }
  }
  // The options transformSync takes for the file: the config's, as Babel
  // loads them for it, its plugins, loaded, as they are, but those of the
  // keys in without, and the inlining one.
  const optionsFor = (filename, without) => {
    const start = performance.now()
    const config = core.loadOptionsSync(optionsOf(filename))
    if (profile) time('config', start)
    const plugins = [...config.plugins.filter(({ key }) => !without.includes(key)), ...inlining(filename)]
    // module-resolver traverses, as its plugin does, with keepPlugins.
    if (!keepPlugins) plugins.forEach(gateResolver)
    return { ...config, plugins }
  }
  // Sync: a worker transforms one file at a time. Its AST given back too,
  // for lowerLeft().
  const transform = (source, options) => {
    if (!profile) return core.transformSync(source, { ...options, ast: true })
    options.plugins.forEach(timeHooks)
    for (const { key } of options.plugins) spent.set(key, [0, 0, false])
    // Timed as the config's own visitor wrapper, if any, makes it.
    const wrap = options.wrapPluginVisitorMethod
    return core.transformSync(source, { ...options, ast: true, wrapPluginVisitorMethod: (key, phase, fn) => timed(key, wrap === undefined ? fn : wrap(key, phase, fn)) })
  }
  // What the config's other plugins leave of let and const after its block
  // scoping plugin, as code they insert once it has run (Reanimated's
  // worklets), that plugin lowers again: Metro's output has none there, and
  // esbuild, told so, adds none after Babel (bundle.js). Only where the
  // output declares one: the words alone, in a string, a comment or a
  // property's name (`exports.const`), are most of those that have them, and
  // a pass of Babel's over the file again (some 5 ms) prints it as it was,
  // but for the layout of Babel's helpers, which esbuild prints anew.
  const LET = /\b(?:let|const)\b/u
  const KEYS = core.types.VISITOR_KEYS
  const declaresLet = (node) => node !== null && typeof node === 'object' && (Array.isArray(node) ? node.some(declaresLet) : (node.type === 'VariableDeclaration' && (node.kind === 'let' || node.kind === 'const')) || (KEYS[node.type] ?? []).some((key) => declaresLet(node[key])))
  const lowerLeft = (result, filename) => {
    if (result === null || !LET.test(result.code) || !declaresLet(result.ast.program)) return result
    const config = core.loadOptionsSync(optionsOf(filename))
    const blockScoping = config?.plugins.find(({ key }) => key === 'transform-block-scoping')
    if (blockScoping === undefined) return result
    // Parsed as the config parses (a return outside a function, if it takes one).
    const parsing = { sourceType: config.sourceType ?? 'unambiguous', ...(config.parserOpts && { parserOpts: config.parserOpts }) }
    return core.transformSync(result.code, { babelrc: false, configFile: false, cwd: given.cwd, filename, compact: false, ...parsing, plugins: [blockScoping], ...(given.sourceMaps && { sourceMaps: given.sourceMaps, inputSourceMap: true }) })
  }
  // The config loaded at once, as a file at the project's root has it,
  // before the first file is sent: its plugins and presets loaded, which
  // Babel then has of each file. Its errors are each file's, as it fails.
  const loadConfig = () => {
    try {
      core.loadOptionsSync(optionsOf(join(given.cwd ?? process.cwd(), 'index.js')))
    } catch {}
  }
  // With options.fingerprint, what the config reads or looks for as it
  // loads too, for the fingerprint, of the modules loaded by now, with the
  // config: before any file, which a plugin may require more for. Asked, its
  // inputs too, which a run after may make it of again (load-cache.js).
  const reads = fingerprinted ? readsOf(loadConfig) : loadConfig()
  const inputs = fingerprinted ? { options: { refresh, keepPlugins, inlineRequires, ...given }, modules: Object.keys(createRequire(corePath).cache), reads: [...reads] } : null
  const fingerprint = fingerprinted ? fingerprintOf(inputs.modules, inputs.options, reads) : null
  parentPort.on('message', ({ port, source, filename, without, fingerprint: asked = false }) => {
    if (asked) {
      port.postMessage({ fingerprint, ...inputs })
      port.close()
      return
    }
    const start = performance.now()
    spent = new Map()
    own = new Map()
    imports = new Set()
    try {
      const result = transform(source, optionsFor(filename, without))
      const { code } = lowerLeft(result, filename)
      const entries = (map) => [...map].map(([key, [calls, ms, worked]]) => [key, calls, ms, worked])
      port.postMessage({ code, imports: [...imports], ...(result.externalDependencies?.size > 0 && { uncacheable: true }), ...(profile && { spent: { ms: performance.now() - start, plugins: entries(spent), own: entries(own) } }) })
    } catch (error) {
      port.postMessage({ error: error.message, ...(error.loc && { loc: { line: error.loc.line, column: error.loc.column } }) })
    }
    port.close()
  })
}
