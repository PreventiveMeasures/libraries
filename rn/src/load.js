// Each file as esbuild loads it: Flow stripped, then, with Babel, lowered by
// esbuild where Babel's preset throws and where the config's plugins lower
// alike, then run through the project's Babel config but for those plugins;
// with `sourcemap`, each step's map carried to the next. With `esm`, a Set of
// the files left CommonJS, Babel leaves the rest's import and export to
// esbuild, which links the modules.

import { Buffer } from 'node:buffer'
import { extname, relative } from 'node:path'

// JS read as JSX, as @react-native/babel-preset reads it: react-native's own
// .js files have JSX, and JSX reads plain JS as JS does.
const LOADERS = new Map([['.js', 'jsx'], ['.cjs', 'jsx'], ['.mjs', 'jsx'], ['.jsx', 'jsx'], ['.ts', 'ts'], ['.cts', 'ts'], ['.mts', 'ts'], ['.tsx', 'tsx'], ['.json', 'json']])
// Lowered by esbuild before Babel, where @react-native/babel-preset throws on
// them: static blocks, `using`, and auto-accessors, which esbuild lowers with
// decorators. Decorators, only to detect them: esbuild drops a field's
// decorators where it lowers the field.
const BEFORE_BABEL = { 'class-static-blocks': false, using: false, decorators: false }
// Lowered by esbuild before Babel too, where the project's Babel config has
// the plugin of this key, with no options, which lowers it alike: the plugin
// is then left out of Babel. Not arrows: esbuild loses `this` in those of
// class fields.
const LOWERS = new Map([
  ['transform-async-to-generator', { 'async-await': false }],
  ['transform-async-generator-functions', { 'async-generator': false, 'for-await': false }],
  ['transform-export-namespace-from', { 'export-star-as': false }],
])
// Left out of Babel too, with nothing to do on esbuild's output: esbuild
// prints no numeric separators, parses no Flow and no `export v from`, and
// lowers static blocks and `using`. Flow's plugin that strips types stays for
// JS: it drops fields with no value too.
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
// And for TS, which esbuild makes JS with its fields with no value dropped.
const INERT_TS = ['transform-typescript', 'syntax-typescript', 'transform-flow-strip-types']
// A call with type arguments needs a `>`, then only space or comments, then
// `(` or a backtick.
const MAYBE_TYPE_ARGUMENTS = /(?<!=)>(?:\s|\/\/.*|\/\*[\s\S]*?\*\/)*[(`]/u
// Options of Babel's TS plugin that change which fields and imports it keeps.
const TS_OPTIONS = ['onlyRemoveTypeImports', 'allowDeclareFields', 'jsxPragma', 'jsxPragmaFrag']
// With `esm`, the config's plugin that makes modules CommonJS is left out:
// esbuild links them, as it does without Babel. But not in a module that may
// name `module` or `exports`, which Babel's CommonJS binds to its own, and
// esbuild leaves unbound in an ES module.
const COMMONJS = 'transform-modules-commonjs'
const MODULE_SYNTAX = /\b(?:import|export)\b/u
const COMMONJS_NAMES = /\b(?:module|exports)\b/u
// Left out of Babel where the file gives them nothing to do (their output
// the same): transform-classes where it has no class, as
// @react-native/babel-preset would leave it, were it given the source (Babel
// gives a preset none), else it looks at each `export default`;
// transform-modules-commonjs where it has no import or export, a script to
// Babel; transform-block-scoping in a module (strict, so of no block function
// to lower, as in a script) with no let, const or class (transform-classes
// makes one a let), but where @react-native/babel-plugin-codegen writes const.
// Its lowering of what other plugins add, Babel's worker does again.
const CLASSES = 'transform-classes'
const BLOCK_SCOPING = 'transform-block-scoping'
const BLOCK_SCOPED = /\b(?:let|const|class)\b/u
const MODULE = /^(?:import(?!\s*\()|export)\b/mu
// babel-plugin-module-resolver, with aliases alone (no `root`, no
// `resolvePath` of its own), rewrites a string specifier one of them
// matches, and leaves the rest: Babel is without it in a file that has no
// string any of them matches (unaliased()).
const RESOLVER = 'module-resolver'
// By module-resolver's options, the RegExps of a string its aliases match,
// as its normalizeAlias has each: a key that starts with `^` or ends with `$`
// a RegExp, each apart (its groups, of its backreferences, its own); the
// others the specifier each is and those under it, in one.
const ALIASES = new WeakMap()
// Appended to TSX with JSX so that esbuild keeps React's import, which JSX,
// left to Babel, uses (the classic runtime), as Babel's TS plugin keeps it.
const USE_REACT = 'typeof React;\n'

// The file's contents as esbuild loads them: { contents, loader } or { errors }.
export async function loadFile({ esbuild, projectRoot, stripFlow, babel, babelPlugins, sourcemap = false, esm = false }, path, contents) {
  const loader = LOADERS.get(extname(path)) ?? 'jsx'
  if (babel !== null && loader !== 'json') {
    let source = { code: contents, without: [] }
    try {
      // @react-native/babel-preset's codegen reads a native component's props
      // off its types, in each file that names codegenNativeComponent.
      if (!contents.includes('codegenNativeComponent')) {
        const plugins = (await babelPlugins?.(path)) ?? new Map()
        source = (loader === 'ts' || loader === 'tsx' ? await typescript(esbuild, plugins, contents, loader, path, sourcemap) : await javascript({ esbuild, stripFlow, sourcemap }, plugins, contents, path)) ?? source
        if (unaliased(plugins.get(RESOLVER), contents)) source = { ...source, without: [...source.without, RESOLVER] }
      }
    } catch (error) {
      if (!Array.isArray(error?.errors)) throw error
      return { errors: error.errors }
    }
    const esModule = esm !== false && !esm.has(path) && !(MODULE_SYNTAX.test(source.code) && COMMONJS_NAMES.test(source.code))
    try {
      const without = [...source.without, ...(esModule ? [COMMONJS] : []), ...idle(source.code)]
      const transformed = await babel(source.code, path, without)
      const { code, imports = [] } = typeof transformed === 'string' ? { code: transformed } : transformed
      // TS, as Babel makes it JS, loaded as TS by esbuild, which then takes an
      // export of what it finds no export of for a type's, as it takes TS.
      // The specifiers of its imports, for the require calls made of them.
      return { contents: code, loader: loader === 'ts' || loader === 'tsx' ? 'ts' : 'js', ...(imports.length > 0 && { pluginData: { imports } }) }
    } catch (error) {
      // In the file Babel failed on, not at the import esbuild loaded it by;
      // at Babel's line where it had the file as it is, not esbuild's output.
      const at = error.loc !== undefined && source.code === contents ? { line: error.loc.line, column: error.loc.column, lineText: contents.split('\n')[error.loc.line - 1] } : {}
      return { errors: [{ text: `Babel: ${error.message.replace(`${path}: `, '')}`, location: { file: relative(projectRoot, path).replaceAll('\\', '/'), ...at } }] }
    }
  }
  if (stripFlow === null || loader !== 'jsx' || !(await hasFlow(esbuild, contents, loader))) return { contents, loader }
  let stripped
  try {
    stripped = stripFlow(contents, path)
  } catch (error) {
    // flow-parser's errors say where, which esbuild then shows.
    const location = error?.loc === undefined ? null : { file: relative(projectRoot, path), line: error.loc.line, column: error.loc.column, lineText: contents.split('\n')[error.loc.line - 1] }
    return { errors: [{ text: `Can't strip Flow types from ${relative(projectRoot, path)}: ${error.message}`, location }] }
  }
  // Flow that is code (`enum`, `component`) isn't stripped.
  const left = await parseErrors(esbuild, stripped, loader, path)
  if (left !== null) return { errors: left.map((error) => ({ ...error, text: `Flow syntax flow-remove-types doesn't strip: ${error.text}` })) }
  return { contents: stripped, loader }
}

async function parseErrors(esbuild, code, loader, path) {
  try {
    await esbuild.transform(code, { loader, sourcefile: path, logLevel: 'silent' })
    return null
  } catch (error) {
    return error.errors
  }
}

// The comments a file opens with, before any code, so before any string.
const LEADING_COMMENTS = /^(?:#![^\n]*)?(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/u

// In a file whose leading comments say @flow, `f<T>(x)` is a call, not
// `(f < T) > x` as JS reads it, as @react-native/babel-preset has it.
function isFlow(code) {
  return /@flow\b/u.test(LEADING_COMMENTS.exec(code)[0])
}

async function hasFlow(esbuild, code, loader) {
  return isFlow(code) || (await parseErrors(esbuild, code, loader)) !== null
}

// -> { code, without }: the source for Babel, and the plugins to leave out.
async function javascript({ esbuild, stripFlow, sourcemap }, plugins, contents, path) {
  let code = contents
  if (stripFlow !== null && (await hasFlow(esbuild, contents, 'jsx'))) {
    try {
      code = stripFlow(contents, path)
    } catch (error) {
      // Left to Babel.
      if (!(error instanceof SyntaxError)) throw error
    }
  }
  // Flow that is code (`component`, `hook`, `enum`) flow-remove-types leaves,
  // and it takes off the @flow pragma, without which the Babel config's Flow
  // parser, as @react-native/babel-preset's, doesn't read the file: such a
  // file is left to Babel as it is, as Metro leaves it.
  if (code !== contents && (await parseErrors(esbuild, code, 'jsx', path)) !== null) return { code: contents, without: [] }
  return (await downgrade(esbuild, plugins, code, path, sourcemap)) ?? { code, without: [] }
}

// null leaves the file to Babel as it is: esbuild can't parse it, would misread
// a Flow call with type arguments in it, would drop the JSX pragmas Babel reads
// off its comments, or would lower decorators, whose semantics (legacy or not)
// the Babel config picks.
async function downgrade(esbuild, plugins, contents, path, sourcemap) {
  if ((isFlow(contents) && MAYBE_TYPE_ARGUMENTS.test(contents)) || contents.includes('@jsx')) return null
  const { supported, without } = lowering(plugins, INERT)
  let code
  try {
    code = await lower(esbuild, contents, 'jsx', path, { supported }, sourcemap)
  } catch (error) {
    // Parse errors have a location; errors in options don't.
    if (!Array.isArray(error?.errors) || !error.errors.every(({ location }) => location)) throw error
    return null
  }
  return decorated(code) ? null : { code, without }
}

// As @react-native/babel-preset's TS plugin makes it: fields with no value
// dropped, the rest assigned; unused imports dropped, but React in TSX with
// JSX. tsconfig isn't read: Metro doesn't. null leaves the file to Babel as it
// is, where the project's TS plugin keeps otherwise or reads JSX pragmas off
// comments, which esbuild drops.
async function typescript(esbuild, plugins, contents, loader, path, sourcemap) {
  const plugin = plugins.get('transform-typescript')
  if (contents.includes('@jsx') || [...TS_OPTIONS, 'instances'].some((option) => plugin?.[option] !== undefined)) return null
  const tsconfigRaw = (useDefineForClassFields) => ({ compilerOptions: { useDefineForClassFields } })
  const { supported, without } = lowering(plugins, [...INERT, ...INERT_TS])
  const code = await lower(esbuild, contents, loader, path, { supported, tsconfigRaw: tsconfigRaw(false) }, sourcemap)
  if (!decorated(code)) return { code, without }
  // Decorated: types stripped alone, classes left to the project's Babel config, all of it.
  return { code: await lower(esbuild, contents, loader, path, { tsconfigRaw: tsconfigRaw(true) }, sourcemap), without: [] }
}

// What esbuild lowers before Babel, for the plugins of the project's Babel
// config, and which of those Babel is then without.
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

// The plugins the file gives nothing to do, of CLASSES, COMMONJS and BLOCK_SCOPING.
function idle(code) {
  const module = MODULE.test(code)
  return [
    ...(code.includes('class') ? [] : [CLASSES]),
    ...(MODULE_SYNTAX.test(code) ? [] : [COMMONJS]),
    ...(module && !BLOCK_SCOPED.test(code) && !code.includes('codegenNativeComponent') ? [BLOCK_SCOPING] : []),
  ]
}

// Whether module-resolver, of these options, leaves the file as it is: a
// string specifier is, in the file, a quote, its value and that quote again,
// on one line, so each such span of the file (from each quote, whatever the
// quotes before it) is tried, but for escapes, which the value is read
// without; a file with one of a code point (`\x23`), it may not leave.
function unaliased(options, contents) {
  if (options === undefined || options.instances !== undefined || options.resolvePath !== undefined || [options.root ?? []].flat().length > 0 || /\\[ux0-9]/u.test(contents)) return false
  const aliases = aliasesOf(options)
  if (aliases === null) return false
  // A line continuation is nothing of a string's value.
  const text = contents.replaceAll(/\\(?:\r\n|[\n\r\u2028\u2029])/gu, '').replaceAll('\\', '')
  // From each quote to the next like it: of each kind, the file once over.
  for (const { index, 0: quote } of text.matchAll(/['"]/gu)) {
    const end = text.indexOf(quote, index + 1)
    const value = end === -1 ? '' : text.slice(index + 1, end)
    if (!value.includes('\n') && aliases.some((alias) => alias.test(value))) return false
  }
  return true
}

// -> ALIASES' RegExps of the options, null where one of its aliases is no RegExp.
function aliasesOf(options) {
  if (!ALIASES.has(options)) {
    const keys = [options.alias ?? {}].flat().flatMap((alias) => Object.keys(alias))
    const escape = (key) => key.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    const patterns = keys.filter((key) => key.startsWith('^') || key.endsWith('$'))
    const specifiers = keys.filter((key) => !patterns.includes(key))
    try {
      // eslint-disable-next-line require-unicode-regexp -- as module-resolver compiles a key: no flags
      const compiled = patterns.map((key) => new RegExp(key))
      ALIASES.set(options, specifiers.length === 0 ? compiled : [...compiled, new RegExp(`^(?:${specifiers.map(escape).join('|')})(?:/|$)`, 'su')])
    } catch {
      ALIASES.set(options, null)
    }
  }
  return ALIASES.get(options)
}

// esbuild brings in this helper only to lower decorators.
function decorated(code) {
  return code.includes('__decoratorStart(')
}

// With `sourcemap`, the code's map to `contents` follows it, as an inline
// comment Babel reads.
async function lower(esbuild, contents, loader, path, options, sourcemap) {
  const transform = (source) => esbuild.transform(source, { loader, jsx: 'preserve', sourcefile: path, logLevel: 'silent', ...options, ...(sourcemap && { sourcemap: 'external' }) })
  const mapped = ({ code, map }) => (sourcemap ? `${code}//# sourceMappingURL=data:application/json;charset=utf-8;base64,${Buffer.from(map).toString('base64')}\n` : code)
  if (loader !== 'tsx') return mapped(await transform(contents))
  const lowered = await transform(`${contents}\n;${USE_REACT}`)
  // No JSX, which plain JS doesn't parse: React's import goes, as Babel's TS plugin drops it.
  if ((await parseErrors(esbuild, lowered.code, 'js', path)) === null) return mapped(await transform(contents))
  return mapped({ ...lowered, code: lowered.code.endsWith(USE_REACT) ? lowered.code.slice(0, -USE_REACT.length) : lowered.code })
}
