// `stasis bundle --metro` and `stasis build --metro=PLATFORM` in one: the
// module graph as Metro resolves it for a platform, captured as esbuild
// follows the imports, is what esbuild builds. Each asset is built as Metro's
// asset module; each file is read through the host. As Metro's serializer
// has a bundle (serializer.js): the prelude, the polyfills, the modules run
// before the entry, then the entry.

import { dirname, extname, relative, resolve } from 'node:path'

import { assetData, assetModule } from './assets.js'
import { defaults, diskHost } from './defaults.js'
import { createMetroResolver } from './resolve.js'
import { reactNativeOf } from './serializer.js'

// JS read as JSX, as @react-native/babel-preset reads it: react-native's own
// .js files have JSX, and JSX reads plain JS as JS does.
const LOADERS = new Map([['.js', 'jsx'], ['.cjs', 'jsx'], ['.mjs', 'jsx'], ['.jsx', 'jsx'], ['.ts', 'ts'], ['.cts', 'ts'], ['.mts', 'ts'], ['.tsx', 'tsx'], ['.json', 'json']])
// Lowered by esbuild in the bundle, after Babel, which leaves them.
const LOWERED = {
  'class-field': false,
  'class-private-accessor': false,
  'class-private-brand-check': false,
  'class-private-field': false,
  'class-private-method': false,
  'class-private-static-accessor': false,
  'class-private-static-field': false,
  'class-private-static-method': false,
  'class-static-blocks': false,
  'class-static-field': false,
  'import-attributes': false,
  using: false,
}
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
const decoder = new TextDecoder()
// eslint-disable-next-line require-unicode-regexp -- esbuild's filters are Go regexps, which take no `u`
const ANY = /.*/
// The module that runs the polyfills, then each module run before the entry,
// then the entry.
const MAIN = 'metro-main'
const POLYFILL = 'metro-polyfill:'
const ENTRY = 'metro-entry:'
// As Metro wraps a polyfill: a script, given the global object.
const GLOBAL = "typeof globalThis !== 'undefined' ? globalThis : typeof global !== 'undefined' ? global : typeof window !== 'undefined' ? window : this"

// -> { outputFiles, warnings, assets: AssetData[], graph: Map<importer, Map<specifier, Resolution>> }
export async function bundle({
  entry,
  platform,
  outfile,
  esbuild,
  host = diskHost,
  projectRoot = process.cwd(),
  // (source, path) => source with Flow types stripped.
  stripFlow = null,
  // (source, path, without) => the project's Babel output, but for the plugins
  // of the keys in without.
  babel = null,
  // async (path) => the plugins of the project's Babel config for a file: a
  // Map of their keys to their options.
  babelPlugins = null,
  define = {},
  minify = false,
  // (file, specifier) => the specifier an alias rewrites it to, or null.
  aliases = null,
  // Metro's transformer.assetRegistryPath: the project's react-native's where not given.
  assetRegistryPath = null,
  // Metro's resolver.assetExts: its defaults where not given.
  assetExts = defaults.assetExts,
  // The code before the bundle: prelude() for Metro's.
  prelude = null,
  // Paths of the scripts to run first, as Metro's serializer.getPolyfills.
  polyfills = [],
  // Specifiers, from the entry, of the modules to run before it, as Metro's
  // serializer.getModulesRunBeforeMainModule: the project's react-native's
  // where not given.
  runBeforeMain = null,
}) {
  const resolveModule = createMetroResolver({ host, assetExts })
  const reactNative = reactNativeOf(resolveModule, host, resolve(projectRoot, entry), platform)
  const before = runBeforeMain ?? reactNative.runBeforeMain
  const graph = new Map()
  const assets = new Map()
  const options = { esbuild, host, projectRoot, stripFlow, babel, babelPlugins }
  // The files Metro resolved, which alone esbuild may load.
  const resolved = new Set()
  const file = (path) => {
    resolved.add(path)
    return { path }
  }
  const main = { polyfills, before, projectRoot, options }
  const plugin = {
    name: 'metro-graph',
    setup(build) {
      build.onResolve({ filter: ANY }, ({ path: specifier, importer, kind, namespace }) => {
        if (kind === 'entry-point') return specifier === MAIN ? { path: host.realpath(resolve(projectRoot, entry)), namespace: MAIN } : file(host.realpath(resolve(projectRoot, specifier)))
        if (namespace === MAIN && specifier.startsWith(POLYFILL)) return { path: specifier.slice(POLYFILL.length), namespace: 'metro-polyfill' }
        if (namespace === MAIN && specifier === ENTRY) return file(importer)
        const resolution = resolveModule(importer, aliases?.(importer, specifier) ?? specifier, { platform, isESMImport: kind === 'import-statement' || kind === 'dynamic-import' })
        if (!graph.has(importer)) graph.set(importer, new Map())
        graph.get(importer).set(specifier, resolution)
        // Left to esbuild, which can't resolve it either: in a try block, an
        // optional dependency, as Metro takes one, which fails at run time;
        // else an error.
        if (resolution === null) return undefined
        if (resolution.type === 'empty') return { path: 'empty', namespace: 'metro-empty' }
        // Metro builds an asset into the module of its lowest path.
        if (resolution.type === 'assetFiles') return { path: resolution.filePaths.toSorted()[0], namespace: 'metro-asset' }
        return file(resolution.filePath)
      })
      build.onLoad({ filter: ANY, namespace: 'file' }, ({ path }) => {
        if (!resolved.has(path)) return { errors: [{ text: `esbuild resolved ${relative(projectRoot, path)} where Metro resolves nothing` }] }
        return loadFile(options, path)
      })
      build.onLoad({ filter: ANY, namespace: 'metro-asset' }, ({ path }) => {
        const data = assetData(path, { urlPath: relative(projectRoot, path).replaceAll('\\', '/'), platform, host })
        assets.set(path, data)
        return { contents: assetModule(data, assetRegistryPath ?? reactNative.assetRegistryPath), loader: 'js', resolveDir: dirname(path) }
      })
      build.onLoad({ filter: ANY, namespace: 'metro-empty' }, () => ({ contents: '', loader: 'js' }))
      serializer(build, main)
    },
  }
  const result = await esbuild.build({
    entryPoints: [polyfills.length > 0 || before.length > 0 ? MAIN : entry],
    absWorkingDir: projectRoot,
    bundle: true,
    write: false,
    outfile: resolve(projectRoot, outfile),
    format: 'iife',
    platform: 'neutral',
    define,
    minify,
    supported: babel === null ? {} : LOWERED,
    logLevel: 'silent',
    plugins: [plugin],
    ...(prelude !== null && { banner: { js: prelude } }),
  })
  return { outputFiles: result.outputFiles, warnings: result.warnings, assets: [...assets.keys()].toSorted().map((path) => assets.get(path)), graph }
}

// The main module, and each polyfill, which is loaded as any file and run as
// a script.
function serializer(build, { polyfills, before, projectRoot, options }) {
  build.onLoad({ filter: ANY, namespace: MAIN }, () => {
    const specifiers = [...polyfills.map((path) => POLYFILL + path), ...before, ENTRY]
    return { contents: specifiers.map((specifier) => `import ${JSON.stringify(specifier)}\n`).join(''), loader: 'js', resolveDir: projectRoot }
  })
  build.onLoad({ filter: ANY, namespace: 'metro-polyfill' }, async ({ path }) => {
    const loaded = await loadFile(options, path)
    // On its first line, so that its lines stay where they are.
    return loaded.errors === undefined ? { ...loaded, contents: `(function (global) {${loaded.contents}\n})(${GLOBAL});\n`, resolveDir: dirname(path) } : loaded
  })
}

async function loadFile({ esbuild, host, projectRoot, stripFlow, babel, babelPlugins }, path) {
  const loader = LOADERS.get(extname(path)) ?? 'jsx'
  const contents = decoder.decode(host.readFile(path))
  if (babel !== null && loader !== 'json') {
    let source = { code: contents, without: [] }
    try {
      // @react-native/babel-preset's codegen reads a native component's props
      // off its types, in each file that names codegenNativeComponent.
      if (!contents.includes('codegenNativeComponent')) {
        const plugins = (await babelPlugins?.(path)) ?? new Map()
        source = (loader === 'ts' || loader === 'tsx' ? await typescript(esbuild, plugins, contents, loader, path) : await javascript({ esbuild, stripFlow }, plugins, contents, path)) ?? source
      }
    } catch (error) {
      if (!Array.isArray(error?.errors)) throw error
      return { errors: error.errors }
    }
    try {
      return { contents: await babel(source.code, path, source.without), loader: 'js' }
    } catch (error) {
      return { errors: [{ text: `Babel: ${error.message}` }] }
    }
  }
  if (stripFlow === null || loader !== 'jsx' || !(await hasFlow(esbuild, contents, loader))) return { contents, loader }
  let stripped
  try {
    stripped = stripFlow(contents, path)
  } catch (error) {
    return { errors: [{ text: `Can't strip Flow types from ${relative(projectRoot, path)}: ${error.message}` }] }
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
async function javascript({ esbuild, stripFlow }, plugins, contents, path) {
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
  return (await downgrade(esbuild, plugins, code, path)) ?? { code, without: [] }
}

// null leaves the file to Babel as it is: esbuild can't parse it, would misread
// a Flow call with type arguments in it, would drop the JSX pragmas Babel reads
// off its comments, or would lower decorators, whose semantics (legacy or not)
// the Babel config picks.
async function downgrade(esbuild, plugins, contents, path) {
  if ((isFlow(contents) && MAYBE_TYPE_ARGUMENTS.test(contents)) || contents.includes('@jsx')) return null
  const { supported, without } = lowering(plugins, INERT)
  let code
  try {
    code = await lower(esbuild, contents, 'jsx', path, { supported })
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
async function typescript(esbuild, plugins, contents, loader, path) {
  const plugin = plugins.get('transform-typescript')
  if (contents.includes('@jsx') || TS_OPTIONS.some((option) => plugin?.[option] !== undefined)) return null
  const tsconfigRaw = (useDefineForClassFields) => ({ compilerOptions: { useDefineForClassFields } })
  const { supported, without } = lowering(plugins, [...INERT, ...INERT_TS])
  const code = await lower(esbuild, contents, loader, path, { supported, tsconfigRaw: tsconfigRaw(false) })
  if (!decorated(code)) return { code, without }
  // Decorated: types stripped alone, classes left to the project's Babel config, all of it.
  return { code: await lower(esbuild, contents, loader, path, { tsconfigRaw: tsconfigRaw(true) }), without: [] }
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

// esbuild brings in this helper only to lower decorators.
function decorated(code) {
  return code.includes('__decoratorStart(')
}

async function lower(esbuild, contents, loader, path, options) {
  const transform = async (source) => (await esbuild.transform(source, { loader, jsx: 'preserve', sourcefile: path, logLevel: 'silent', ...options })).code
  if (loader !== 'tsx') return transform(contents)
  const code = await transform(`${contents}\n;${USE_REACT}`)
  // No JSX, which plain JS doesn't parse: React's import goes, as Babel's TS plugin drops it.
  if ((await parseErrors(esbuild, code, 'js', path)) === null) return transform(contents)
  return code.endsWith(USE_REACT) ? code.slice(0, -USE_REACT.length) : code
}
