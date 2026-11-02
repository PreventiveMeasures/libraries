// Babel's transforms, off the main thread: each worker loads the project's
// @babel/core and its config once, and transforms what it is sent.

import { once } from 'node:events'
import { createRequire } from 'node:module'
import { availableParallelism } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { MessageChannel, Worker, parentPort, workerData } from 'node:worker_threads'

import { Unconverted, babelFile } from './oxc-babel.js'

// (corePath, options, profile) => async (source, filename, without = [],
// lowered = false) => { code, imports }, by the @babel/core at corePath, with
// options (all but the filename) for each file, its config's plugins of the
// keys in without left out; with options.refresh, react-refresh's Babel
// plugin at that path for each file outside node_modules, as Metro's
// transformer adds it for Fast Refresh; with options.oxc, oxc-parser at that
// path parses each `lowered` source (esbuild's output: JS and JSX) in place
// of Babel's parser, to the AST Babel's would make (OXC). `imports`, the
// specifiers of the file's import and export-from declarations (IMPORTS).
// Where profile is newProfile()'s, the time of each transform is added to
// it, and that of each plugin: its visitors' and hooks', by its key.
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
  return async (source, filename, without = [], lowered = false) => {
    const info = pick()
    const { port1, port2 } = new MessageChannel()
    const { promise: failed, reject } = Promise.withResolvers()
    // Busy, a worker keeps the process alive; idle, it doesn't.
    if (info.busy++ === 0) info.worker.ref()
    info.pending.add(reject)
    try {
      info.worker.postMessage({ port: port1, source, filename, without, lowered }, [port1])
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

// Babel's parser options that oxc-parser's AST, made Babel's (oxc-babel.js),
// is the same of, or that only take more code (which oxc-parser then fails
// on, leaving it to Babel).
const OXC_OPTIONS = new Set([
  'sourceType',
  'sourceFileName',
  'plugins',
  'createImportExpressions',
  'allowReturnOutsideFunction',
  'allowAwaitOutsideFunction',
  'allowImportExportEverywhere',
  'allowSuperOutsideMethod',
  'allowUndeclaredExports',
  'allowNewTargetOutsideFunction',
  'allowYieldOutsideFunction',
  'errorRecovery',
])
// Babel's parser plugins that make another AST of JS.
const NOT_OXC = new Set(['estree', 'typescript', 'flowComments', 'placeholders', 'v8intrinsic'])

// Babel's parser options of a file -> babelFile()'s, and whether it has JSX;
// null where oxc-parser's AST isn't Babel's of it: Babel's flow plugin reads
// `f<T>(x)` as a call where the file says @flow, or `all` says so.
function oxcOptions(parserOpts, code) {
  if (Object.keys(parserOpts).some((key) => !OXC_OPTIONS.has(key) && parserOpts[key] !== undefined)) return null
  const sourceType = parserOpts.sourceType ?? 'module'
  if (sourceType !== 'module' && sourceType !== 'script' && sourceType !== 'unambiguous') return null
  let jsx = false
  let flow = false
  for (const plugin of parserOpts.plugins ?? []) {
    const [name, options] = Array.isArray(plugin) ? plugin : [plugin, {}]
    if (NOT_OXC.has(name) || (name === 'flow' && options?.all === true)) return null
    jsx ||= name === 'jsx'
    flow ||= name === 'flow'
  }
  if (flow && code.includes('@flow')) return null
  return { sourceType, flow, jsx, importExpressions: parserOpts.createImportExpressions === true }
}

if (workerData?.babel !== undefined) {
  const { corePath, options: { refresh = null, oxc = null, ...given }, profile } = workerData.babel
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
  // oxc-parser in place of Babel's parser, for esbuild's output where no
  // plugin of the config parses: by raw transfer, without which its AST, made
  // Babel's, is no quicker (Babel parses then), and with the errors it finds
  // in a pass of its own, which Babel's parser throws on too. A file it fails
  // on, Babel parses, failing with its own error.
  const oxcParser = oxc === null ? null : createRequire(import.meta.url)(oxc)
  const parser = oxcParser?.rawTransferSupported?.() === true ? oxcParser : null
  // The source of the file being transformed, where oxc-parser parses it.
  let oxcSource = null
  const OXC = {
    name: 'rn-bundle-oxc-parser',
    parserOverride(code, parserOpts) {
      if (code !== oxcSource) return undefined
      const options = oxcOptions(parserOpts, code)
      if (options === null) return undefined
      const start = performance.now()
      try {
        const { program, comments, errors } = parser.parseSync(parserOpts.sourceFileName ?? 'file.js', code, {
          lang: options.jsx ? 'jsx' : 'js',
          sourceType: options.sourceType,
          preserveParens: true,
          showSemanticErrors: true,
          experimentalRawTransfer: true,
        })
        return errors.length > 0 ? undefined : babelFile(program, comments, code, options)
      } catch (error) {
        if (error instanceof Unconverted) return undefined
        throw error
      } finally {
        if (profile) time('parsing', start)
      }
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
  // Sync: a worker transforms one file at a time.
  const transform = (source, filename, without, lowered) => {
    // The config's plugins, loaded, which transformSync takes as they are.
    const start = performance.now()
    const config = core.loadOptionsSync(optionsOf(filename))
    if (profile) time('config', start)
    const plugins = config.plugins.filter(({ key }) => !without.includes(key))
    plugins.forEach(gateResolver)
    // Babel takes no two plugins' parsers.
    oxcSource = parser !== null && lowered && plugins.every(({ parserOverride }) => parserOverride === undefined) ? source : null
    const parsing = oxcSource === null ? plugins : [...plugins, OXC]
    try {
      if (!profile) return core.transformSync(source, { ...config, plugins: parsing })
      plugins.forEach(timeHooks)
      for (const { key } of plugins) spent.set(key, [0, 0, false])
      // Timed as the config's own visitor wrapper, if any, makes it.
      const wrap = config.wrapPluginVisitorMethod
      return core.transformSync(source, { ...config, plugins: parsing, wrapPluginVisitorMethod: (key, phase, fn) => timed(key, wrap === undefined ? fn : wrap(key, phase, fn)) })
    } finally {
      oxcSource = null
    }
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
  parentPort.on('message', ({ port, source, filename, without, lowered }) => {
    const start = performance.now()
    spent = new Map()
    own = new Map()
    imports = new Set()
    try {
      const { code } = lowerLeft(transform(source, filename, without, lowered), filename)
      const entries = (map) => [...map].map(([key, [calls, ms, worked]]) => [key, calls, ms, worked])
      port.postMessage({ code, imports: [...imports], ...(profile && { spent: { ms: performance.now() - start, plugins: entries(spent), own: entries(own) } }) })
    } catch (error) {
      port.postMessage({ error: error.message, ...(error.loc && { loc: { line: error.loc.line, column: error.loc.column } }) })
    }
    port.close()
  })
}
