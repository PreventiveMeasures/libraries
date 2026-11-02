// A file's transform by the project's @babel/core and its config, as
// babelWorkers() has it done: in a worker of its, or in band, on the main
// thread.

import { createRequire } from 'node:module'
import { join } from 'node:path'

import { fingerprintOf, readsOf, withDependencies } from './load-cache.js'
import { babelrcFinder } from './babelrc.js'
import { workletsGate } from './worklets.js'

// The key of the config's plugin that makes modules CommonJS.
const COMMONJS = 'transform-modules-commonjs'

// ({ corePath, options, profile }) -> (message) => its answer, of the
// @babel/core at corePath and the config, which it loads as it is called:
// of { source, filename, without }, { code, imports, uncacheable?, spent? }
// or { error, loc? }; of { fingerprint: true }, { fingerprint, ...inputs }
// (babelWorkers()).
export function transformerOf({ corePath, options: { refresh = null, keepPlugins = false, inlineRequires = null, fingerprint: fingerprinted = false, oneBuild = false, ...given }, profile }) {
  const core = createRequire(corePath)(corePath)
  memoizeHelpers(core)
  const cwd = given.cwd ?? process.cwd()
  const imports = importsOf()
  const inlining = inliningOf(core, inlineRequires, given.cwd)
  // As Metro's transformer has it, a file in node_modules has no component to edit.
  const finds = oneBuild && given.babelrc !== false ? babelrcFinder() : null
  const optionsOf = (filename) => ({ ...given, filename, ...(finds?.(filename) === false && { babelrc: false }), plugins: [...(given.plugins ?? []), imports.plugin, ...(refresh === null || filename.includes('node_modules') ? [] : [[refresh, { skipEnvCheck: true }]])] })
  const profiler = profile ? profilerOf(corePath) : null
  const gateResolver = resolverGate(core, cwd, () => profiler?.skip())
  // Reanimated's plugin, left out of a file it leaves as it is (but with
  // keepPlugins, as --self-test builds again).
  const quiet = keepPlugins ? null : workletsGate({ cwd, envName: given.envName })
  const listOf = lister()
  // The options transformSync takes for the file of source: the config's, as
  // Babel loads them for it, its plugins, loaded, as they are, but those of
  // the keys in without, and Reanimated's where quiet, and the inlining one.
  const optionsFor = (filename, source, without) => {
    const start = performance.now()
    const config = core.loadOptionsSync(optionsOf(filename))
    profiler?.time('config', start)
    const plugins = listOf([...config.plugins.filter((plugin) => !without.includes(plugin.key) && !quiet?.(plugin, source)), ...inlining(filename)])
    // module-resolver traverses, as its plugin does, with keepPlugins.
    if (!keepPlugins) plugins.forEach(gateResolver)
    return { ...config, plugins }
  }
  // Sync: one file at a time. Its AST given back too, for lowerLeft().
  const transform = (source, options) => core.transformSync(source, { ...(profiler?.timing(options) ?? options), ast: true })
  const lowerLeft = lowerer(core, optionsOf, given)
  // The config loaded at once, as a file at the project's root has it,
  // before the first file is sent: its plugins and presets loaded, which
  // Babel then has of each file. Its errors are each file's, as it fails.
  const loadConfig = () => {
    try {
      core.loadOptionsSync(optionsOf(join(cwd, 'index.js')))
    } catch {}
  }
  // With options.fingerprint, what the config reads or looks for as it
  // loads too, for the fingerprint, of the modules loaded by now, with the
  // config: before any file, which a plugin may require more for. Asked, its
  // inputs too, which a run after may make it of again (load-cache.js).
  const reads = fingerprinted ? readsOf(loadConfig) : loadConfig()
  const inputs = fingerprinted ? { options: { refresh, keepPlugins, inlineRequires, ...given }, modules: withDependencies(Object.keys(createRequire(corePath).cache), cwd), reads: [...reads] } : null
  const fingerprint = fingerprinted ? fingerprintOf(inputs.modules, inputs.options, reads) : null
  return ({ source, filename, without, fingerprint: asked = false }) => {
    if (asked) return { fingerprint, ...inputs }
    const start = profiler?.start()
    imports.clear()
    try {
      let result = transform(source, optionsFor(filename, source, without))
      // An ES module without the config's CommonJS plugin (load.js's, of
      // --esm) that names `module` or `exports` unbound: made CommonJS
      // after all, which binds them.
      if (without.includes(COMMONJS) && imports.namesCommonJs()) {
        imports.clear()
        result = transform(source, optionsFor(filename, source, without.filter((key) => key !== COMMONJS)))
      }
      const { code } = lowerLeft(result, filename)
      return { code, imports: imports.list(), ...(result.externalDependencies?.size > 0 && { uncacheable: true }), ...(profiler && { spent: profiler.spent(start) }) }
    } catch (error) {
      return { error: error.message, ...(error.loc && { loc: { line: error.loc.line, column: error.loc.column } }) }
    }
  }
}

// @babel/core's File#availableHelper(name, versionRange), which
// transform-runtime asks of each helper a file uses: semver's intersects()
// of two ranges it parses anew each time, some 1% of Babel's work. Of the
// helper's name and the range alone (Babel's helpers, of their versions),
// each answer is had once.
export function memoizeHelpers(core) {
  const proto = core.File?.prototype
  const available = proto?.availableHelper
  if (typeof available !== 'function' || MEMOIZED.has(available)) return
  const known = new Map()
  const memoized = function (name, versionRange) {
    if (typeof name !== 'string' || (versionRange !== undefined && typeof versionRange !== 'string')) return available.call(this, name, versionRange)
    const key = `${name}\0${versionRange}`
    if (!known.has(key)) known.set(key, available.call(this, name, versionRange))
    return known.get(key)
  }
  MEMOIZED.add(memoized)
  proto.availableHelper = memoized
}
const MEMOIZED = new WeakSet()

// The specifiers of the file's import and export-from declarations, but
// types', as Metro's transformer records where each is (its
// importLocationsPlugin): the require call Babel's CommonJS makes of one,
// Metro resolves as an ESM import (bundle.js); and whether the file is an
// ES module that names `module` or `exports` unbound, as its scope has
// them as Babel parsed it (not in a comment, a string, a property's name,
// nor of a binding of its own), which Babel's CommonJS binds to its own and
// esbuild, linking ES modules, leaves unbound. -> { plugin, clear(), list(),
// namesCommonJs() }.
function importsOf() {
  let imports = new Set()
  let namesCommonJs = false
  const plugin = {
    name: 'rn-bundle-imports',
    visitor: {
      Program(path) {
        namesCommonJs = path.node.sourceType === 'module' && (path.scope.hasGlobal('module') || path.scope.hasGlobal('exports'))
      },
      'ImportDeclaration|ExportNamedDeclaration|ExportAllDeclaration'({ node }) {
        if (node.source != null && node.loc != null && (node.importKind ?? node.exportKind) !== 'type') imports.add(node.source.value)
      },
    },
  }
  const clear = () => {
    imports = new Set()
    namesCommonJs = false
  }
  return { plugin, clear, list: () => [...imports], namesCommonJs: () => namesCommonJs }
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
// as a pass of its own after Babel, but on Babel's tree. -> (filename) =>
// the plugins to add for the file.
function inliningOf(core, inlineRequires, cwd) {
  const plugin = inlineRequires === null ? null : core.loadOptionsSync({ babelrc: false, configFile: false, cwd, plugins: [[gatedInlining(createRequire(inlineRequires.plugin)(inlineRequires.plugin).inlineRequiresPlugin), inlineRequires.options]] }).plugins[0]
  return (filename) => (plugin === null || inlineRequires.blockList.includes(filename) ? [] : [plugin])
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

// The time of each plugin's visitors and hooks, by its key, and of Babel's
// own work, by what it is (babel-worker.js's OWN), in the file being
// transformed. -> { start() (its start, the file's times anew), time(name,
// start), timing(options) (the options transformSync takes, timed), skip()
// (the call under way a gated visitor's that didn't run), spent(start) }.
function profilerOf(corePath) {
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
  // Whether the call under way was a gated visitor's that didn't run (resolverGate()).
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
  // What @babel/core calls, of its own dependencies, as it calls it.
  const ofCore = createRequire(corePath)
  timeOwn('parsing', ofCore('@babel/parser'), 'parse')
  timeOwn('scopes', ofCore('@babel/traverse').Scope.prototype, 'crawl')
  timeOwn('printing', ofCore('@babel/generator'), 'default')
  const hooked = new WeakSet()
  const timeHooks = (plugin) => {
    if (hooked.has(plugin)) return
    hooked.add(plugin)
    for (const hook of ['pre', 'post', 'parserOverride', 'generatorOverride']) if (typeof plugin[hook] === 'function') plugin[hook] = timed(plugin.key, plugin[hook], hook.endsWith('Override'))
  }
  const entries = (map) => [...map].map(([key, [calls, ms, worked]]) => [key, calls, ms, worked])
  return {
    start: () => {
      spent = new Map()
      own = new Map()
      return performance.now()
    },
    time,
    timing: (options) => {
      options.plugins.forEach(timeHooks)
      for (const { key } of options.plugins) spent.set(key, [0, 0, false])
      // Timed as the config's own visitor wrapper, if any, makes it.
      const wrap = options.wrapPluginVisitorMethod
      return { ...options, wrapPluginVisitorMethod: (key, phase, fn) => timed(key, wrap === undefined ? fn : wrap(key, phase, fn)) }
    },
    skip: () => (skipped = true),
    spent: (start) => ({ ms: performance.now() - start, plugins: entries(spent), own: entries(own) }),
  }
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
// a call of it: skip() is called. -> (plugin) => void, of a plugin of the
// config's, its Program visitor gated where it is module-resolver.
function resolverGate(core, cwd, skip) {
  const t = core.types
  const gated = new WeakSet()
  // Its module's resolvePath, where the plugin's Program visitor is its
  // module's: as the project resolves the module, as its Babel config does.
  const resolvePathOf = (enter) => {
    try {
      const resolver = createRequire(join(cwd, 'package.json'))('babel-plugin-module-resolver')
      const its = resolver.default({ types: t }).visitor.Program.enter
      return (Array.isArray(its) ? its[0] : its) === enter && typeof resolver.resolvePath === 'function' ? resolver.resolvePath : null
    } catch {
      return null
    }
  }
  // Whether a call is of one of the patterns, as module-resolver's matchesPattern has it.
  const transforms = ({ callee }, patterns) => t.isImport(callee) || patterns.some((pattern) => (t.isMemberExpression(callee) ? t.matchesPattern(callee, pattern) : t.isIdentifier(callee) && !pattern.includes('.') && callee.name === pattern))
  // -> null where no string in the node names an alias, else the nodes
  // module-resolver maps a string of: [node, key, index].
  const sitesOf = (node, { alias, transformFunctions }) => {
    let named = false
    const sites = []
    t.traverseFast(node, (child) => {
      named ||= child.type === 'StringLiteral' && alias.some(([regExp]) => regExp.test(child.value))
      if (t.isImportDeclaration(child) || t.isExportDeclaration(child)) sites.push([child, 'source'])
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
      if (!t.isStringLiteral(node)) continue
      const modulePath = resolvePath(node.value, pass.file.opts.filename, pass.opts)
      if (!modulePath || node.pathResolved) continue
      const replacement = t.stringLiteral(modulePath)
      t.inheritsComments(replacement, node)
      t.removeComments(node)
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
      if (sites === null) skip()
      else if (resolvePath === null || !(this.moduleResolverVisited instanceof Set)) return fn.call(this, path, ...rest)
      else resolve(sites, this, resolvePath)
      return undefined
    }
  return (plugin) => {
    const program = plugin.visitor?.Program
    if (plugin.key !== 'module-resolver' || gated.has(plugin) || program === undefined) return
    gated.add(plugin)
    const resolvePath = resolvePathOf(program.enter?.[0])
    // Its own, not the Program visitor its instances share.
    const phases = Object.entries(program).map(([phase, fns]) => [phase, (phase === 'enter' || phase === 'exit') && Array.isArray(fns) ? fns.map((fn) => gate(fn, resolvePath)) : fns])
    plugin.visitor = { ...plugin.visitor, Program: Object.fromEntries(phases) }
  }
}

// One array of each list of plugins, the same for each file of it: as
// transformSync loads its options again, Babel takes the plugins of one
// it has had for loaded, their descriptors cached by the array. ->
// (plugins) => the list's array.
function lister() {
  const ids = new WeakMap()
  let count = 0
  const idOf = (plugin) => (ids.has(plugin) ? ids.get(plugin) : ids.set(plugin, count++).get(plugin))
  const lists = new Map()
  return (plugins) => {
    const key = plugins.map(idOf).join()
    return lists.get(key) ?? lists.set(key, plugins).get(key)
  }
}

// What the config's other plugins leave of let and const after its block
// scoping plugin, as code they insert once it has run (Reanimated's
// worklets), that plugin lowers again: Metro's output has none there, and
// esbuild, told so, adds none after Babel (bundle.js). Only where the
// output declares one: the words alone, in a string, a comment or a
// property's name (`exports.const`), are most of those that have them, and
// a pass of Babel's over the file again (some 5 ms) prints it as it was,
// but for the layout of Babel's helpers, which esbuild prints anew. ->
// (result, filename) => the result, lowered where it needs to be.
function lowerer(core, optionsOf, given) {
  const LET = /\b(?:let|const)\b/u
  const KEYS = core.types.VISITOR_KEYS
  const declaresLet = (node) => node !== null && typeof node === 'object' && (Array.isArray(node) ? node.some(declaresLet) : (node.type === 'VariableDeclaration' && (node.kind === 'let' || node.kind === 'const')) || (KEYS[node.type] ?? []).some((key) => declaresLet(node[key])))
  return (result, filename) => {
    if (result === null || !LET.test(result.code) || !declaresLet(result.ast.program)) return result
    const config = core.loadOptionsSync(optionsOf(filename))
    const blockScoping = config?.plugins.find(({ key }) => key === 'transform-block-scoping')
    if (blockScoping === undefined) return result
    // Parsed as the config parses (a return outside a function, if it takes one).
    const parsing = { sourceType: config.sourceType ?? 'unambiguous', ...(config.parserOpts && { parserOpts: config.parserOpts }) }
    return core.transformSync(result.code, { babelrc: false, configFile: false, cwd: given.cwd, filename, compact: false, ...parsing, plugins: [blockScoping], ...(given.sourceMaps && { sourceMaps: given.sourceMaps, inputSourceMap: true }) })
  }
}
