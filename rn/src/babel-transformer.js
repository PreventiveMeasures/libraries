// Transforms a file with the project's @babel/core and config, in one of babelWorkers()'s
// workers or on the main thread.

import { createRequire } from 'node:module'
import { join } from 'node:path'

import { fingerprintOf, readsOf, withDependencies } from './load-cache.js'
import { babelrcFinder } from './babelrc.js'
import { workletsGate } from './worklets.js'

const COMMONJS = 'transform-modules-commonjs'

// -> (message) => { code, imports, uncacheable?, spent? } or { error, loc? } for { source, filename,
// without }, and the fingerprint with its inputs for { fingerprint: true }. The options are Babel's,
// plus refresh, keepPlugins, inlineRequires, fingerprint and oneBuild (cli.js's projectBabel()).
export function transformerOf({ corePath, options: { refresh = null, keepPlugins = false, inlineRequires = null, fingerprint: fingerprinted = false, oneBuild = false, ...given }, profile }) {
  const core = createRequire(corePath)(corePath)
  memoizeHelpers(core)
  const cwd = given.cwd ?? process.cwd()
  const imports = importsOf()
  // Metro's inline-requires, run after all of the config's plugins, its presets' included.
  const inlining = inlineRequires === null ? null : core.loadOptionsSync({ babelrc: false, configFile: false, cwd: given.cwd, plugins: [[gatedInlining(createRequire(inlineRequires.plugin)(inlineRequires.plugin).inlineRequiresPlugin), inlineRequires.options]] }).plugins[0]
  // Within one build, Babel's .babelrc lookup is skipped where it would find nothing.
  const finds = oneBuild && given.babelrc !== false ? babelrcFinder() : null
  const optionsOf = (filename) => {
    const plugins = [...(given.plugins ?? []), imports.plugin]
    // As Metro's transformer has it, no Fast Refresh in node_modules.
    if (refresh !== null && !filename.includes('node_modules')) plugins.push([refresh, { skipEnvCheck: true }])
    return { ...given, filename, ...(finds?.(filename) === false && { babelrc: false }), plugins }
  }
  const profiler = profile ? profilerOf(corePath) : null
  const gateResolver = resolverGate(core, cwd, () => profiler?.skip())
  // keepPlugins (--self-test's second build) runs every plugin in full.
  const quiet = keepPlugins ? null : workletsGate({ cwd, envName: given.envName })
  const listOf = lister()
  // The config's plugins for the file, but those keyed in `without` and Reanimated's where quiet.
  const optionsFor = (filename, source, without) => {
    const start = performance.now()
    const config = core.loadOptionsSync(optionsOf(filename))
    profiler?.time('config', start)
    const plugins = config.plugins.filter((plugin) => !without.includes(plugin.key) && !quiet?.(plugin, source))
    if (inlining !== null && !inlineRequires.blockList.includes(filename)) plugins.push(inlining)
    if (!keepPlugins) plugins.forEach(gateResolver)
    return { ...config, plugins: listOf(plugins) }
  }
  // Keeps the AST for lowerLeft().
  const transform = (source, options) => core.transformSync(source, { ...(profiler?.timing(options) ?? options), ast: true })
  const lowerLeft = lowerer(core, optionsOf, given)
  // Loads the config's plugins and presets before the first file, as for a file at the root.
  // Its errors are each file's, as that fails.
  const loadConfig = () => {
    try {
      core.loadOptionsSync(optionsOf(join(cwd, 'index.js')))
    } catch {}
  }
  // Of the modules loaded and the files read with the config, before any file; given back with
  // its inputs, which a later run checks to reuse it (load-cache.js).
  let fingerprint = { fingerprint: null }
  if (fingerprinted) {
    const reads = readsOf(loadConfig)
    const options = { refresh, keepPlugins, inlineRequires, ...given }
    const modules = withDependencies(Object.keys(createRequire(corePath).cache), cwd)
    fingerprint = { fingerprint: fingerprintOf(modules, options, reads), options, modules, reads: [...reads] }
  } else {
    loadConfig()
  }
  return ({ source, filename, without, fingerprint: asked = false }) => {
    if (asked) return fingerprint
    const start = profiler?.start()
    imports.clear()
    try {
      let result = transform(source, optionsFor(filename, source, without))
      // An ES module built without CommonJS (load.js, for --esm) that uses `module` or `exports`
      // unbound is built again with it, which binds them.
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

// Memoizes File#availableHelper(name, versionRange), which transform-runtime calls for each helper a
// file uses, parsing both semver ranges anew each time (~1% of Babel's work).
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

// Records a file's import and export-from specifiers (not type-only ones), as Metro's importLocationsPlugin
// does: Metro resolves the requires Babel's CommonJS makes of them as ESM imports (bundle.js). Also whether
// an ES module uses `module` or `exports` unbound, which Babel's CommonJS binds and esbuild would not.
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

// Metro's inline-requires plugin, whose Program exit only runs where a top-level var is initialized by an
// inlineable call (require or one of inlineableCalls) of a module it doesn't ignore, or by a member of
// one. Elsewhere it would crawl the program's scopes and walk it for no change.
export function gatedInlining(plugin) {
  return (api, options) => {
    const instance = plugin(api, options)
    const program = instance.visitor.Program
    const calls = new Set(['require', ...(options?.inlineableCalls ?? [])])
    const ignored = new Set(options?.ignoredRequires ?? [])
    // The string module name of require(name) or require(require.resolve(name)), else null.
    const moduleOf = (node) => {
      if (node?.type !== 'CallExpression' || node.callee.type !== 'Identifier' || !calls.has(node.callee.name)) return null
      const [first] = node.arguments
      if (first?.type === 'StringLiteral') return first.value
      const { callee, arguments: args } = first?.type === 'CallExpression' ? first : {}
      const resolves = callee?.type === 'MemberExpression' && callee.object.type === 'Identifier' && calls.has(callee.object.name) && callee.property.type === 'Identifier' && callee.property.name === 'resolve'
      return resolves && args[0]?.type === 'StringLiteral' ? args[0].value : null
    }
    // Also a member's object or computed property: Metro 0.78+ won't inline the latter, but its
    // member aliasing may still act on it.
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

// Times, in the file being transformed, each plugin's visitors and hooks by key (each call net of the
// plugin calls it makes), and Babel's own work outside plugins by babel-worker.js's OWN names.
function profilerOf(corePath) {
  // By key: [calls, own ms, whether it worked in the file (a visitor, parser or printer ran)].
  let spent = new Map()
  let own = new Map()
  // The time of finished nested calls, and how deep in timed calls we are.
  let inner = 0
  let depth = 0
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
  const time = (name, start) => add(own, name, performance.now() - start)
  // Within a plugin's call, the work is the plugin's.
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
  // @babel/core's own dependencies, as it requires them.
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
    // The options transformSync takes, with each plugin timed.
    timing: (options) => {
      options.plugins.forEach(timeHooks)
      for (const { key } of options.plugins) spent.set(key, [0, 0, false])
      // Inside the config's own visitor wrapper, if any.
      const wrap = options.wrapPluginVisitorMethod
      return { ...options, wrapPluginVisitorMethod: (key, phase, fn) => timed(key, wrap === undefined ? fn : wrap(key, phase, fn)) }
    },
    skip: () => (skipped = true),
    spent: (start) => ({ ms: performance.now() - start, plugins: entries(spent), own: entries(own) }),
  }
}

// babel-plugin-module-resolver walks each file on Program enter and exit to map the strings of imports,
// exports and calls of its transformFunctions. Without `root` or a custom resolvePath, it changes only
// strings naming an alias: files with none skip the walk (calling skip()), others get a fast walk.
function resolverGate(core, cwd, skip) {
  const t = core.types
  const gated = new WeakSet()
  // The resolvePath of the project's module-resolver, if the plugin's Program visitor is that module's.
  const resolvePathOf = (enter) => {
    try {
      const resolver = createRequire(join(cwd, 'package.json'))('babel-plugin-module-resolver')
      const its = resolver.default({ types: t }).visitor.Program.enter
      return (Array.isArray(its) ? its[0] : its) === enter && typeof resolver.resolvePath === 'function' ? resolver.resolvePath : null
    } catch {
      return null
    }
  }
  // As module-resolver's matchesPattern.
  const transforms = ({ callee }, patterns) => t.isImport(callee) || patterns.some((pattern) => (t.isMemberExpression(callee) ? t.matchesPattern(callee, pattern) : t.isIdentifier(callee) && !pattern.includes('.') && callee.name === pattern))
  // The [node, key, index?] sites whose string module-resolver maps; null where no string names an alias.
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
  // As module-resolver's mapPathString, visiting each node once.
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
      // `this` is the plugin pass, its options normalized for the file by the plugin's pre hook.
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
    // A Program visitor of its own, not the one its instances share.
    const phases = Object.entries(program).map(([phase, fns]) => [phase, (phase === 'enter' || phase === 'exit') && Array.isArray(fns) ? fns.map((fn) => gate(fn, resolvePath)) : fns])
    plugin.visitor = { ...plugin.visitor, Program: Object.fromEntries(phases) }
  }
}

// The same array for the same list of plugins: as transformSync loads its options again, Babel reuses
// the plugins it loaded for an array it has seen.
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

// Runs the config's block-scoping plugin again where other plugins (Reanimated's worklets) left let or
// const after it ran: Metro's output has none, and esbuild is told to add none (bundle.js). The AST is
// checked, since most matches of the words are in strings, comments or property names.
function lowerer(core, optionsOf, given) {
  const LET = /\b(?:let|const)\b/u
  const KEYS = core.types.VISITOR_KEYS
  const declaresLet = (node) => node !== null && typeof node === 'object' && (Array.isArray(node) ? node.some(declaresLet) : (node.type === 'VariableDeclaration' && (node.kind === 'let' || node.kind === 'const')) || (KEYS[node.type] ?? []).some((key) => declaresLet(node[key])))
  return (result, filename) => {
    if (result === null || !LET.test(result.code) || !declaresLet(result.ast.program)) return result
    const config = core.loadOptionsSync(optionsOf(filename))
    const blockScoping = config?.plugins.find(({ key }) => key === 'transform-block-scoping')
    if (blockScoping === undefined) return result
    // Parsed as the config parses, e.g. allowing a return outside a function.
    const parsing = { sourceType: config.sourceType ?? 'unambiguous', ...(config.parserOpts && { parserOpts: config.parserOpts }) }
    return core.transformSync(result.code, { babelrc: false, configFile: false, cwd: given.cwd, filename, compact: false, ...parsing, plugins: [blockScoping], ...(given.sourceMaps && { sourceMaps: given.sourceMaps, inputSourceMap: true }) })
  }
}
