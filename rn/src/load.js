// Loads each file for esbuild: strips Flow, then, with Babel, has esbuild lower what Babel's preset
// throws on or a config plugin would lower the same way, and runs the Babel config without those
// plugins, chaining source maps. With `esm` (a Set of files kept CommonJS), esbuild links the rest.

import { Buffer } from 'node:buffer'
import { extname, relative } from 'node:path'

import { RESOLVER, resolverOf } from './module-resolver.js'

// JS is read as JSX, as @react-native/babel-preset does: react-native's own .js files contain JSX.
const LOADERS = new Map([['.js', 'jsx'], ['.cjs', 'jsx'], ['.mjs', 'jsx'], ['.jsx', 'jsx'], ['.ts', 'ts'], ['.cts', 'ts'], ['.mts', 'ts'], ['.tsx', 'tsx'], ['.json', 'json']])
// Lowered by esbuild before Babel, as @react-native/babel-preset throws on static blocks, `using` and
// auto-accessors (lowered with decorators). Decorators are lowered only to detect them, since esbuild
// drops a field's decorators when it lowers the field.
const BEFORE_BABEL = { 'class-static-blocks': false, using: false, decorators: false }
// Also lowered by esbuild when the Babel config has this plugin without options; Babel then skips it.
// Not arrows: esbuild loses `this` in arrows in class fields.
const LOWERS = new Map([
  ['transform-async-to-generator', { 'async-await': false }],
  ['transform-async-generator-functions', { 'async-generator': false, 'for-await': false }],
  ['transform-export-namespace-from', { 'export-star-as': false }],
])
// Skipped in Babel: esbuild's output has no numeric separators, Flow, `export v from`, static blocks or
// `using`. Flow's strip-types plugin stays for JS, as it also drops fields without a value.
const INERT = [
  'transform-numeric-separator',
  'syntax-numeric-separator',
  'syntax-flow',
  'syntax-flow-parser',
  'syntax-hermes-parser',
  'transform-flow-enums',
  'proposal-export-default-from',
  'syntax-export-default-from',
  'transform-class-static-block',
  'syntax-class-static-block',
  'transform-explicit-resource-management',
  'proposal-explicit-resource-management',
  'syntax-explicit-resource-management',
]
// Also skipped for TS, which esbuild turns into JS with fields without a value dropped.
const INERT_TS = ['transform-typescript', 'syntax-typescript', 'transform-flow-strip-types']
// A call with type arguments: `>`, then only whitespace or comments, then `(` or a backtick.
const MAYBE_TYPE_ARGUMENTS = /(?<!=)>(?:\s|\/\/.*|\/\*[\s\S]*?\*\/)*[(`]/u
// Options of Babel's TS plugin that change which fields and imports it keeps, plus `instances`
// (cli.js's pluginsByKey() for a plugin configured more than once).
const TS_OPTIONS = ['onlyRemoveTypeImports', 'allowDeclareFields', 'jsxPragma', 'jsxPragmaFrag', 'instances']
// With `esm`, esbuild links modules instead of the config's CommonJS plugin. A module using free
// `module` or `exports` is still made CommonJS by Babel's worker, which sees scope (babel-transformer.js).
const COMMONJS = 'transform-modules-commonjs'
const MODULE_SYNTAX = /\b(?:import|export)\b/u
const BLOCK_SCOPING = 'transform-block-scoping'
// transform-classes turns a class into a let.
const BLOCK_SCOPED = /\b(?:let|const|class)\b/u
const MODULE = /^(?:import(?!\s*\()|export)\b/mu
// Appended to TSX with JSX so esbuild keeps React's import, which the JSX left to Babel (classic
// runtime) uses, as Babel's TS plugin does.
const USE_REACT = 'typeof React;\n'

// Returns { contents, loader } or { errors }. With `keepPlugins` (--self-test), Babel keeps the plugins
// it would skip as having nothing to do (INERT, idle(), module-resolver), though not LOWERS.
export async function loadFile(options, path, contents) {
  const loader = LOADERS.get(extname(path)) ?? 'jsx'
  if (options.babel !== null && loader !== 'json') return await throughBabel(options, path, contents, loader)
  const { esbuild, projectRoot, stripFlow } = options
  if (stripFlow === null || loader !== 'jsx' || !(await hasFlow(esbuild, contents))) return { contents, loader }
  let stripped
  try {
    stripped = stripFlow(contents, path)
  } catch (error) {
    // flow-parser's errors have a location for esbuild to show.
    const location = error?.loc === undefined ? null : { file: relative(projectRoot, path), ...lineOf(error, contents) }
    return { errors: [{ text: `Can't strip Flow types from ${relative(projectRoot, path)}: ${error.message}`, location }] }
  }
  // Flow that is code (`enum`, `component`) isn't stripped.
  const left = await parseErrors(esbuild, stripped, loader, path)
  if (left !== null) return { errors: left.map((error) => ({ ...error, text: `Flow syntax flow-remove-types doesn't strip: ${error.text}` })) }
  return { contents: stripped, loader }
}

const lineOf = (error, contents) => ({ line: error.loc.line, column: error.loc.column, lineText: contents.split('\n')[error.loc.line - 1] })

async function throughBabel(options, path, contents, loader) {
  const { projectRoot, babel, babelPlugins, esm = false, keepPlugins } = options
  let source = { code: contents, without: [] }
  // module-resolver's aliases, when the bundle maps them itself (resolverOf()).
  let aliases = null
  try {
    // @react-native/babel-preset's codegen reads a native component's props from its types.
    if (!contents.includes('codegenNativeComponent')) {
      const plugins = (await babelPlugins?.(path)) ?? new Map()
      source = (loader === 'ts' || loader === 'tsx' ? await typescript(options, plugins, contents, loader, path) : await javascript(options, plugins, contents, path)) ?? source
      const resolver = keepPlugins ? 'babel' : resolverOf(plugins.get(RESOLVER), contents, plugins, path, projectRoot, source.code)
      if (resolver !== 'babel') {
        source = { ...source, without: [...source.without, RESOLVER] }
        aliases = resolver
      }
    }
  } catch (error) {
    if (!Array.isArray(error?.errors)) throw error
    return { errors: error.errors }
  }
  try {
    const commonJs = esm !== false && !esm.has(path) ? [COMMONJS] : []
    const without = keepPlugins ? [...source.without.filter((key) => !INERT.includes(key) && !INERT_TS.includes(key)), ...commonJs] : [...source.without, ...commonJs, ...idle(source.code)]
    const transformed = await babel(source.code, path, without)
    const { code, imports = [], uncacheable = false } = typeof transformed === 'string' ? { code: transformed } : transformed
    // Babel's output for TS still loads as TS, so esbuild treats exports of missing names as types.
    // pluginData passes the imports' specifiers and module-resolver's aliases on for the bundle to map
    // its requires by; `uncacheable` is for loadCached().
    const pluginData = { ...(imports.length > 0 && { imports }), ...(aliases !== null && { aliases }) }
    return { contents: code, loader: loader === 'ts' || loader === 'tsx' ? 'ts' : 'js', ...(Object.keys(pluginData).length > 0 && { pluginData }), ...(uncacheable && { uncacheable }) }
  } catch (error) {
    // Reported in the file itself, not at the import; with a line only if Babel saw the original source.
    const at = error.loc !== undefined && source.code === contents ? lineOf(error, contents) : {}
    return { errors: [{ text: `Babel: ${error.message.replace(`${path}: `, '')}`, location: { file: relative(projectRoot, path).replaceAll('\\', '/'), ...at } }] }
  }
}

async function parseErrors(esbuild, code, loader, path) {
  try {
    await esbuild.transform(code, { loader, sourcefile: path, logLevel: 'silent' })
    return null
  } catch (error) {
    return error.errors
  }
}

// The comments a file opens with (before any code, so before any string).
const LEADING_COMMENTS = /^(?:#![^\n]*)?(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/u

// With @flow in its leading comments, `f<T>(x)` is a call, not `(f < T) > x`, as in
// @react-native/babel-preset.
const isFlow = (code) => /@flow\b/u.test(LEADING_COMMENTS.exec(code)[0])

const hasFlow = async (esbuild, code) => isFlow(code) || (await parseErrors(esbuild, code, 'jsx')) !== null

// The JS source for Babel, and the plugins Babel can skip.
async function javascript(options, plugins, contents, path) {
  const { esbuild, stripFlow } = options
  let code = contents
  if (stripFlow !== null && (await hasFlow(esbuild, contents))) {
    try {
      code = stripFlow(contents, path)
    } catch (error) {
      // Left for Babel to report.
      if (!(error instanceof SyntaxError)) throw error
    }
  }
  // flow-remove-types leaves Flow that is code (`component`, `hook`, `enum`) but drops the @flow pragma
  // that the config's Flow parser (@react-native/babel-preset's) needs: leave such a file to Babel as is,
  // as Metro does.
  if (code !== contents && (await parseErrors(esbuild, code, 'jsx', path)) !== null) return { code: contents, without: [] }
  return (await downgrade(options, plugins, code, path)) ?? { code, without: [] }
}

// null leaves the file to Babel as is: when esbuild can't parse it, would misread a Flow call with type
// arguments, would drop JSX pragma comments Babel reads, or would lower decorators, whose semantics
// (legacy or not) the Babel config picks.
async function downgrade(options, plugins, contents, path) {
  if ((isFlow(contents) && MAYBE_TYPE_ARGUMENTS.test(contents)) || contents.includes('@jsx')) return null
  const { supported, without } = lowering(plugins, INERT)
  let code
  try {
    code = await lower(options, contents, 'jsx', path, { supported })
  } catch (error) {
    // Parse errors have a location; errors in options don't.
    if (!Array.isArray(error?.errors) || !error.errors.every(({ location }) => location)) throw error
    return null
  }
  return decorated(code) ? null : { code, without }
}

// Strips TS as @react-native/babel-preset's TS plugin does: drops fields without a value and unused
// imports (but React in TSX with JSX); ignores tsconfig, as Metro does. null leaves the file to Babel
// when the config's TS plugin keeps things otherwise or the file has JSX pragmas, which esbuild drops.
async function typescript(options, plugins, contents, loader, path) {
  const plugin = plugins.get('transform-typescript')
  if (contents.includes('@jsx') || TS_OPTIONS.some((option) => plugin?.[option] !== undefined)) return null
  const tsconfigRaw = (useDefineForClassFields) => ({ compilerOptions: { useDefineForClassFields } })
  const { supported, without } = lowering(plugins, [...INERT, ...INERT_TS])
  const code = await lower(options, contents, loader, path, { supported, tsconfigRaw: tsconfigRaw(false) })
  if (!decorated(code)) return { code, without }
  // Decorated: strip types only, and leave the classes to the Babel config.
  return { code: await lower(options, contents, loader, path, { tsconfigRaw: tsconfigRaw(true) }), without: [] }
}

// What esbuild lowers before Babel given the config's plugins, and which of them Babel can then skip.
function lowering(plugins, inert) {
  const supported = { ...BEFORE_BABEL }
  const without = inert.filter((key) => plugins.has(key))
  for (const [key, features] of LOWERS) {
    const options = plugins.get(key)
    if (options === undefined || Object.keys(options).length > 0) continue
    Object.assign(supported, features)
    without.push(key)
  }
  return { supported, without }
}

// The plugins with nothing to do in `code` (the worker re-lowers what other plugins add). Block scoping
// only in a (strict) module, unless codegen writes const. Never transform-classes: another plugin may
// add a class, whose helpers must then be imported as the config imports them.
function idle(code) {
  return [
    ...(MODULE_SYNTAX.test(code) ? [] : [COMMONJS]),
    ...(MODULE.test(code) && !BLOCK_SCOPED.test(code) && !code.includes('codegenNativeComponent') ? [BLOCK_SCOPING] : []),
  ]
}

// esbuild emits this helper only when it lowers decorators.
const decorated = (code) => code.includes('__decoratorStart(')

// With `sourcemap`, the code ends with its map to `contents` as an inline comment, which Babel reads.
async function lower({ esbuild, sourcemap }, contents, loader, path, options) {
  const transform = (source) => esbuild.transform(source, { loader, jsx: 'preserve', sourcefile: path, logLevel: 'silent', ...options, ...(sourcemap && { sourcemap: 'external' }) })
  const mapped = ({ code, map }) => (sourcemap ? `${code}//# sourceMappingURL=data:application/json;charset=utf-8;base64,${Buffer.from(map).toString('base64')}\n` : code)
  if (loader !== 'tsx') return mapped(await transform(contents))
  const lowered = await transform(`${contents}\n;${USE_REACT}`)
  // No JSX (it parses as plain JS): drop React's import, as Babel's TS plugin does.
  if ((await parseErrors(esbuild, lowered.code, 'js', path)) === null) return mapped(await transform(contents))
  return mapped({ ...lowered, code: lowered.code.endsWith(USE_REACT) ? lowered.code.slice(0, -USE_REACT.length) : lowered.code })
}
