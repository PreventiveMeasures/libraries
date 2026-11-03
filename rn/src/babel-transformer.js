// Transforms a file with the project's @babel/core and config, in one of babelWorkers()'s
// workers or on the main thread.

import { createRequire } from 'node:module'
import { join } from 'node:path'

import { switchesOf } from './babel-switches.js'
import { esModuleOf } from './es-module.js'
import { babelrcFinder } from './babelrc.js'
import { workletsGate } from './worklets.js'

const COMMONJS = 'transform-modules-commonjs'
const BLOCK_SCOPING = 'transform-block-scoping'
const LET = /\b(?:let|const)\b/u

// -> { transform, fingerprint }: transform({ source, filename, without }) gives { code, imports, module?,
// uncacheable?, spent? } or { error, loc? }; fingerprint is null without `fingerprintOf`. The options are
// Babel's, plus cli.js's projectBabel() ones: ownPlugins, keepPlugins, inlineRequires, fingerprinter, etc.
export function transformerOf({ corePath, options, profile, fingerprintOf = null }) {
  const { ownPlugins = [], keepPlugins = false, inlineRequires = null, fingerprinter: _fingerprinter, oneBuild = false, switches = [], ...given } = options
  const core = createRequire(corePath)(corePath)
  memoizeHelpers(core)
  const cwd = given.cwd ?? process.cwd()
  const loadPlugin = (plugin) => core.loadOptionsSync({ babelrc: false, configFile: false, cwd: given.cwd, plugins: [plugin] }).plugins[0]
  // Metro's inline-requires, run after all of the config's plugins, its presets' included.
  const inlining = inlineRequires === null ? null : loadPlugin([gatedInlining(createRequire(inlineRequires.plugin)(inlineRequires.plugin).inlineRequiresPlugin), inlineRequires.options])
  // rn.config.json's switches, loaded with the config in loadConfig() so the fingerprint covers them.
  let switchedNow = null
  const switchedOf = () => (switchedNow ??= switchesOf(core, switches, { cwd: given.cwd, root: given.root, caller: given.caller, envName: given.envName }, { ...given, filename: join(cwd, 'index.js') }))
  // A plugin switched off keeps only the syntax it enables (its manipulateOptions): no visitor or override.
  const syntaxes = new WeakMap()
  const syntaxOf = (plugin) => {
    if (!syntaxes.has(plugin)) syntaxes.set(plugin, plugin.manipulateOptions === undefined ? null : loadPlugin(() => ({ name: `${plugin.key}:syntax`, manipulateOptions: plugin.manipulateOptions })))
    return syntaxes.get(plugin)
  }
  // Within one build, Babel's .babelrc lookup is skipped where it would find nothing.
  const finds = oneBuild && given.babelrc !== false ? babelrcFinder() : null
  const configOf = (filename) => {
    const plugins = [...(given.plugins ?? []), IMPORTS]
    // In the project's own files alone, as Metro's transformer has Fast Refresh's.
    if (!filename.includes('node_modules')) plugins.push(...ownPlugins)
    return core.loadOptionsSync({ ...given, filename, ...(finds?.(filename) === false && { babelrc: false }), plugins })
  }
  const profiler = profile ? profilerOf(corePath) : null
  // keepPlugins (--self-test's second build) runs every plugin in full.
  const gate = keepPlugins ? () => {} : resolverGate(core, cwd, () => profiler?.skip())
  const quiet = keepPlugins ? () => false : workletsGate({ cwd, envName: given.envName })
  const listOf = lister()
  // The config's plugins, less those switched off and, unless switched on, those in `without` or quiet;
  // then those switched on that the config lacks, in order.
  const run = (source, filename, without) => {
    const switched = switchedOf()
    if (switched.errors.length > 0) throw new Error(switched.errors[0])
    const start = performance.now()
    const config = configOf(filename)
    profiler?.time('config', start)
    const plugins = config.plugins.flatMap((plugin) => {
      if (switched.off.has(plugin.key)) return syntaxOf(plugin) ?? []
      return switched.on.has(plugin.key) || (!without.includes(plugin.key) && !quiet(plugin, source)) ? [plugin] : []
    })
    const own = new Set(config.plugins.map(({ key }) => key))
    for (const { key, name, plugin } of switched.added) {
      if (own.has(key)) continue
      if (plugin === null) throw new Error(`rn.config.json's babel switches on ${name}: the Babel config has no plugin of that key for this file, and Babel finds no plugin of that name`)
      plugins.push(plugin)
    }
    if (inlining !== null && !inlineRequires.blockList.includes(filename)) plugins.push(inlining)
    plugins.forEach(gate)
    // The AST kept for lowered().
    const babelOptions = { ...config, plugins: listOf(plugins), ast: true }
    const result = core.transformSync(source, profiler?.timing(babelOptions) ?? babelOptions)
    // No metadata where a plugin before IMPORTS stops the traversal.
    const { imports, namesCommonJs, module = null } = result.metadata.rnBundle ?? { imports: [], namesCommonJs: false }
    // An ES module built without CommonJS (--esm) that uses `module` or `exports` unbound is rebuilt with it.
    if (namesCommonJs && without.includes(COMMONJS) && !switched.on.has(COMMONJS)) return run(source, filename, without.filter((key) => key !== COMMONJS))
    // The block-scoping plugin run, else the config's (skipped where it had nothing to do), unless switched off.
    const blockScoping = switched.off.has(BLOCK_SCOPING) ? null : ([...plugins, ...config.plugins].find(({ key }) => key === BLOCK_SCOPING) ?? null)
    // An ES module that names `module` or `exports` is CommonJS too: its exports aren't only those it declares.
    const esModule = module === null ? {} : { module: { ...module, ...(namesCommonJs && { commonJs: true }) } }
    return { code: lowered(core, config, result, given.sourceMaps, blockScoping), imports: [...imports], ...esModule, ...(result.externalDependencies?.size > 0 && { uncacheable: true }) }
  }
  const transform = ({ source, filename, without }) => {
    const start = profiler?.start()
    try {
      return { ...run(source, filename, without), ...(profiler && { spent: profiler.spent(start) }) }
    } catch (error) {
      return { error: error.message, ...(error.loc && { loc: { line: error.loc.line, column: error.loc.column } }) }
    }
  }
  // Loads the config before the first file, as for a file at the root; its errors are each file's.
  const loadConfig = () => {
    try {
      switchedOf()
      configOf(join(cwd, 'index.js'))
    } catch {}
  }
  if (fingerprintOf !== null) return { transform, fingerprint: fingerprintOf({ load: loadConfig, corePath, cwd, options }) }
  loadConfig()
  return { transform, fingerprint: null }
}

// Memoizes File#availableHelper(name, versionRange), which transform-runtime calls for each helper a
// file uses, parsing both semver ranges anew each time (~1% of Babel's work).
export function memoizeHelpers(core) {
  const proto = core.File?.prototype
  const available = proto?.availableHelper
  if (typeof available !== 'function' || MEMOIZED.has(proto)) return
  MEMOIZED.add(proto)
  const known = new Map()
  proto.availableHelper = function (name, versionRange) {
    if (versionRange !== undefined && typeof versionRange !== 'string') return available.call(this, name, versionRange)
    const key = `${name}\0${versionRange}`
    if (!known.has(key)) known.set(key, available.call(this, name, versionRange))
    return known.get(key)
  }
}
const MEMOIZED = new WeakSet()

// Records in a file's metadata its import and export-from specifiers (not type-only ones), as Metro's
// importLocationsPlugin does, for bundle.js to resolve as ESM imports; whether an ES module uses
// `module` or `exports` unbound, which esbuild won't bind; and its esModuleOf() record.
const IMPORTS = {
  name: 'rn-bundle-imports',
  visitor: {
    Program: {
      enter(path, { file }) {
        file.metadata.rnBundle = { imports: new Set(), namesCommonJs: path.node.sourceType === 'module' && (path.scope.hasGlobal('module') || path.scope.hasGlobal('exports')), module: esModuleOf(path.node) }
      },
      // Again with types (and Flow enums) stripped, unless an earlier exit made it CommonJS (the config's
      // own CommonJS plugin, before a preset's): then the entry's record stays.
      exit(path, { file }) {
        file.metadata.rnBundle.module = esModuleOf(path.node) ?? file.metadata.rnBundle.module
      },
    },
    'ImportDeclaration|ExportNamedDeclaration|ExportAllDeclaration'({ node }, { file }) {
      if (node.source != null && node.loc != null && (node.importKind ?? node.exportKind) !== 'type') file.metadata.rnBundle.imports.add(node.source.value)
    },
  },
}

// Metro's inline-requires plugin, its Program exit run only where a top-level var is initialized by an
// inlineable call (or a member of one) of a module it doesn't ignore: elsewhere it would crawl the
// program's scopes and walk it for no change.
export function gatedInlining(plugin) {
  return (api, options) => {
    const instance = plugin(api, options)
    const calls = new Set(['require', ...(options.inlineableCalls ?? [])])
    const ignored = new Set(options.ignoredRequires ?? [])
    const isResolve = (callee) => callee.type === 'MemberExpression' && callee.object.type === 'Identifier' && calls.has(callee.object.name) && callee.property.type === 'Identifier' && callee.property.name === 'resolve'
    // The string module name of require(name) or require(require.resolve(name)), else null.
    const moduleOf = (node) => {
      if (node?.type !== 'CallExpression' || node.callee.type !== 'Identifier' || !calls.has(node.callee.name)) return null
      const [first] = node.arguments
      const name = first?.type === 'CallExpression' && isResolve(first.callee) ? first.arguments[0] : first
      return name?.type === 'StringLiteral' ? name.value : null
    }
    // Also a member's object or computed property: Metro 0.78+ won't inline the latter, but its
    // member aliasing may still act on it.
    const inlinable = ({ init }) => {
      const name = moduleOf(init) ?? (init?.type === 'MemberExpression' ? (moduleOf(init.object) ?? moduleOf(init.property)) : null)
      return name !== null && !ignored.has(name) && !name.startsWith('@babel/runtime/')
    }
    const program = instance.visitor.Program
    const { exit } = program
    program.exit = function (path, state) {
      return path.node.body.some((statement) => statement.type === 'VariableDeclaration' && statement.declarations.some(inlinable)) ? exit.call(this, path, state) : undefined
    }
    return instance
  }
}

// Times, in the file being transformed, each plugin's visitors and hooks by key (each call net of the
// plugin calls it makes), and Babel's own work outside plugins by babel-worker.js's OWN names.
function profilerOf(corePath) {
  // By key: [calls, own ms, whether it worked in the file (a visitor, parser or printer ran)].
  let plugins = new Map()
  let own = new Map()
  const add = (map, key, ms, works = true, calls = 1) => {
    const [counted, time, worked] = map.get(key) ?? [0, 0, false]
    map.set(key, [counted + calls, time + ms, worked || works])
  }
  // The time of finished nested calls, and how deep in timed calls we are.
  let inner = 0
  let depth = 0
  // fn's call, then count(its time net of the timed calls it made).
  const measure = (fn, self, args, count) => {
    const start = performance.now()
    const before = inner
    depth++
    try {
      return fn.apply(self, args)
    } finally {
      depth--
      const elapsed = performance.now() - start
      count(elapsed - (inner - before))
      inner = before + elapsed
    }
  }
  // Whether the call under way was a gated visitor's that didn't run (resolverGate()).
  let skipped = false
  const timed = (key, fn, works = true) =>
    function (...args) {
      return measure(fn, this, args, (ms) => {
        add(plugins, key, ms, works && !skipped, skipped ? 0 : 1)
        skipped = false
      })
    }
  // Within a plugin's call, the work is the plugin's.
  const timeOwn = (name, object, method) => {
    const fn = object[method]
    object[method] = function (...args) {
      return depth > 0 ? fn.apply(this, args) : measure(fn, this, args, (ms) => add(own, name, ms))
    }
  }
  // @babel/core's own dependencies, as it requires them.
  const ofCore = createRequire(corePath)
  timeOwn('parsing', ofCore('@babel/parser'), 'parse')
  timeOwn('scopes', ofCore('@babel/traverse').Scope.prototype, 'crawl')
  timeOwn('printing', ofCore('@babel/generator'), 'default')
  const hooked = new WeakSet()
  return {
    start: () => {
      plugins = new Map()
      own = new Map()
      return performance.now()
    },
    time: (name, start) => add(own, name, performance.now() - start),
    // The options transformSync takes, with each plugin timed, inside the config's own visitor wrapper if any.
    timing: (options) => {
      for (const plugin of options.plugins) {
        plugins.set(plugin.key, [0, 0, false])
        if (hooked.has(plugin)) continue
        hooked.add(plugin)
        for (const hook of ['pre', 'post', 'parserOverride', 'generatorOverride']) if (typeof plugin[hook] === 'function') plugin[hook] = timed(plugin.key, plugin[hook], hook.endsWith('Override'))
      }
      const wrap = options.wrapPluginVisitorMethod
      return { ...options, wrapPluginVisitorMethod: (key, phase, fn) => timed(key, wrap === undefined ? fn : wrap(key, phase, fn)) }
    },
    skip: () => {
      skipped = true
    },
    spent: (start) => ({ ms: performance.now() - start, plugins, own }),
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
      // Babel makes the visitor its instances share take arrays.
      const its = resolver.default({ types: t }).visitor.Program.enter
      return (Array.isArray(its) ? its[0] : its) === enter && typeof resolver.resolvePath === 'function' ? resolver.resolvePath : null
    } catch {
      return null
    }
  }
  // As module-resolver's matchesPattern.
  const transforms = ({ callee }, patterns) => t.isImport(callee) || patterns.some((pattern) => (t.isMemberExpression(callee) ? t.matchesPattern(callee, pattern) : t.isIdentifier(callee) && !pattern.includes('.') && callee.name === pattern))
  // The [node, container, key] sites whose string module-resolver maps; null where no string names an alias.
  const sitesOf = (node, { alias, transformFunctions }) => {
    let named = false
    const sites = []
    t.traverseFast(node, (child) => {
      named ||= child.type === 'StringLiteral' && alias.some(([regExp]) => regExp.test(child.value))
      if (t.isImportDeclaration(child) || t.isExportDeclaration(child)) sites.push([child, child, 'source'])
      if (child.type === 'CallExpression' && transforms(child, transformFunctions)) sites.push([child, child.arguments, 0])
    })
    return named ? sites : null
  }
  // As module-resolver's mapPathString, visiting each node once.
  const resolve = (sites, pass, resolvePath) => {
    for (const [owner, container, key] of sites) {
      if (pass.moduleResolverVisited.has(owner)) continue
      pass.moduleResolverVisited.add(owner)
      const node = container[key]
      if (!t.isStringLiteral(node)) continue
      const modulePath = resolvePath(node.value, pass.file.opts.filename, pass.opts)
      if (!modulePath || node.pathResolved) continue
      const replacement = t.stringLiteral(modulePath)
      t.inheritsComments(replacement, node)
      t.removeComments(node)
      replacement.pathResolved = true
      container[key] = replacement
    }
  }
  const aliasesAlone = (options) => options?.root?.length === 0 && options.customResolvePath === undefined && Array.isArray(options.alias) && options.alias.every(([regExp]) => regExp instanceof RegExp) && Array.isArray(options.transformFunctions) && options.transformFunctions.every((pattern) => typeof pattern === 'string')
  const gate = (fn, resolvePath) =>
    function (path, ...rest) {
      // `this` is the plugin pass, its options normalized for the file by the plugin's pre hook.
      const options = this.normalizedOpts
      if (!aliasesAlone(options)) return fn.call(this, path, ...rest)
      const sites = sitesOf(path.node, options)
      if (sites === null) {
        skip()
      } else if (resolvePath === null || !(this.moduleResolverVisited instanceof Set)) {
        return fn.call(this, path, ...rest)
      } else {
        resolve(sites, this, resolvePath)
      }
    }
  return (plugin) => {
    const program = plugin.visitor.Program
    if (plugin.key !== 'module-resolver' || gated.has(plugin) || program === undefined) return
    gated.add(plugin)
    const resolvePath = resolvePathOf(program.enter?.[0])
    const gating = (fns) => fns?.map((fn) => gate(fn, resolvePath))
    // A Program visitor of its own, not the one its instances share.
    plugin.visitor = { ...plugin.visitor, Program: { ...program, enter: gating(program.enter), exit: gating(program.exit) } }
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

// The code, with the config's block-scoping plugin run again where other plugins (Reanimated's worklets)
// left let or const after it ran: Metro's output has none, and esbuild is told to add none (bundle.js).
// The AST is checked, since most matches of the words are in strings, comments or property names.
function lowered(core, config, result, sourceMaps, blockScoping) {
  if (blockScoping === null || !LET.test(result.code) || !declaresLet(core.types.VISITOR_KEYS, result.ast.program)) return result.code
  // Parsed as the config parses, e.g. allowing a return outside a function.
  const parsing = { sourceType: config.sourceType ?? 'unambiguous', ...(config.parserOpts && { parserOpts: config.parserOpts }) }
  return core.transformSync(result.code, { babelrc: false, configFile: false, cwd: config.cwd, filename: config.filename, compact: false, ...parsing, plugins: [blockScoping], ...(sourceMaps && { sourceMaps, inputSourceMap: true }) }).code
}

function declaresLet(keys, node) {
  if (Array.isArray(node)) return node.some((each) => declaresLet(keys, each))
  if (node == null) return false
  if (node.type === 'VariableDeclaration' && (node.kind === 'let' || node.kind === 'const')) return true
  return (keys[node.type] ?? []).some((key) => declaresLet(keys, node[key]))
}
