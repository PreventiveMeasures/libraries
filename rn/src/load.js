// Each file as esbuild loads it: Flow stripped, then, with Babel, lowered by
// esbuild where Babel's preset throws and where the config's plugins lower
// alike, then run through the project's Babel config but for those plugins;
// with `sourcemap`, each step's map carried to the next.

import { Buffer } from 'node:buffer'
import { extname, relative } from 'node:path'

import { createAliases } from './babel-aliases.js'

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
// Appended to TSX with JSX so that esbuild keeps React's import, which JSX,
// left to Babel, uses (the classic runtime), as Babel's TS plugin keeps it.
const USE_REACT = 'typeof React;\n'

// The file's contents as esbuild loads them: { contents, loader } or { errors };
// with `alias`, where Babel was without babel-plugin-module-resolver, the
// (file, specifier) => specifier its imports are to be mapped by instead.
export async function loadFile({ esbuild, projectRoot, stripFlow, babel, babelPlugins, sourcemap = false }, path, contents) {
  const loader = LOADERS.get(extname(path)) ?? 'jsx'
  if (babel !== null && loader !== 'json') {
    let source = { code: contents, without: [] }
    let plugins
    try {
      plugins = (await babelPlugins?.(path)) ?? new Map()
      // @react-native/babel-preset's codegen reads a native component's props
      // off its types, in each file that names codegenNativeComponent.
      if (!contents.includes('codegenNativeComponent')) source = (loader === 'ts' || loader === 'tsx' ? await typescript(esbuild, plugins, contents, loader, path, sourcemap) : await javascript({ esbuild, stripFlow, sourcemap }, plugins, contents, path)) ?? source
    } catch (error) {
      if (!Array.isArray(error?.errors)) throw error
      return { errors: error.errors }
    }
    const alias = MODULE_RESOLVER_CALLS.test(contents) ? null : moduleResolver(plugins)
    try {
      const loaded = { contents: await babel(source.code, path, alias === null ? source.without : [...source.without, 'module-resolver']), loader: 'js' }
      return alias === null ? loaded : { ...loaded, alias }
    } catch (error) {
      return { errors: [{ text: `Babel: ${error.message}` }] }
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

// babel-plugin-module-resolver's aliases, where its config has its alias
// option alone, which a file's imports are mapped by as the plugin maps them
// (babel-aliases.js), from process.cwd() as the plugin does: else null.
const resolvers = new WeakMap()
// Calls the plugin maps the string argument of (its transformFunctions), that
// esbuild resolves nothing for: a file with one keeps the plugin.
const MODULE_RESOLVER_CALLS = /\b(?:System\.import|require\.(?:resolve|requireActual|requireMock)|jest\.(?:genMockFromModule|mock|unmock|doMock|dontMock|setMock|requireActual|requireMock))\s*\(/u
function moduleResolver(plugins) {
  const options = plugins.get('module-resolver')
  if (options === undefined || Object.keys(options).some((key) => key !== 'alias')) return null
  if (!resolvers.has(options)) {
    let alias = null
    try {
      alias = createAliases(options.alias, process.cwd())
    } catch {
      // Left to the plugin: aliases createAliases doesn't map, as to arrays.
    }
    resolvers.set(options, alias)
  }
  return resolvers.get(options)
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
