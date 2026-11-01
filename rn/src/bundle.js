// `stasis bundle --metro` and `stasis build --metro=PLATFORM` in one: the
// module graph as Metro resolves it for a platform, captured as esbuild
// follows the imports, is what esbuild builds. Each asset is built as Metro's
// asset module; each file is read through the host.

import { dirname, extname, relative, resolve } from 'node:path'

import { assetData, assetModule } from './assets.js'
import { defaults, diskHost } from './defaults.js'
import { createMetroResolver } from './resolve.js'

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
// A call with type arguments needs a `>`, then only space or comments, then
// `(` or a backtick.
const MAYBE_TYPE_ARGUMENTS = /(?<!=)>(?:\s|\/\/.*|\/\*[\s\S]*?\*\/)*[(`]/u
// Options of Babel's TS plugin that change which fields and imports it keeps.
const TS_OPTIONS = ['onlyRemoveTypeImports', 'allowDeclareFields', 'jsxPragma', 'jsxPragmaFrag']
// Appended to TSX so that esbuild keeps React's import, which JSX, left to
// Babel, uses (the classic runtime), as Babel's TS plugin keeps it.
const USE_REACT = 'typeof React;\n'
const decoder = new TextDecoder()
// eslint-disable-next-line require-unicode-regexp -- esbuild's filters are Go regexps, which take no `u`
const ANY = /.*/

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
  // (source, path) => the project's Babel output.
  babel = null,
  // async (path) => the options of the project's Babel TS plugin for a file, or null.
  babelTypescript = null,
  define = {},
  minify = false,
  // (file, specifier) => the specifier an alias rewrites it to, or null.
  aliases = null,
  assetRegistryPath = 'react-native/Libraries/Image/AssetRegistry',
  // Metro's resolver.assetExts: its defaults where not given.
  assetExts = defaults.assetExts,
}) {
  const resolveModule = createMetroResolver({ host, assetExts })
  const graph = new Map()
  const assets = new Map()
  const options = { esbuild, host, projectRoot, stripFlow, babel, babelTypescript }
  // The files Metro resolved, which alone esbuild may load.
  const resolved = new Set()
  const file = (path) => {
    resolved.add(path)
    return { path }
  }
  const plugin = {
    name: 'metro-graph',
    setup(build) {
      build.onResolve({ filter: ANY }, ({ path: specifier, importer, kind }) => {
        if (kind === 'entry-point') return file(host.realpath(resolve(projectRoot, specifier)))
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
        return { contents: assetModule(data, assetRegistryPath), loader: 'js', resolveDir: dirname(path) }
      })
      build.onLoad({ filter: ANY, namespace: 'metro-empty' }, () => ({ contents: '', loader: 'js' }))
    },
  }
  const result = await esbuild.build({
    entryPoints: [entry],
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
  })
  return { outputFiles: result.outputFiles, warnings: result.warnings, assets: [...assets.keys()].toSorted().map((path) => assets.get(path)), graph }
}

async function loadFile({ esbuild, host, projectRoot, stripFlow, babel, babelTypescript }, path) {
  const loader = LOADERS.get(extname(path)) ?? 'jsx'
  const contents = decoder.decode(host.readFile(path))
  if (babel !== null && loader !== 'json') {
    let source = contents
    try {
      // @react-native/babel-preset's codegen reads a native component's props
      // off its types, in each file that names codegenNativeComponent.
      if (!contents.includes('codegenNativeComponent')) source = (loader === 'ts' || loader === 'tsx' ? await typescript({ esbuild, babelTypescript }, contents, loader, path) : await javascript({ esbuild, stripFlow }, contents, path)) ?? contents
    } catch (error) {
      if (!Array.isArray(error?.errors)) throw error
      return { errors: error.errors }
    }
    try {
      return { contents: await babel(source, path), loader: 'js' }
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

// In a @flow file, `f<T>(x)` is a call, not `(f < T) > x` as JS reads it.
// @react-native/babel-preset parses Flow by the same test.
function isFlow(code) {
  return code.includes('@flow')
}

async function hasFlow(esbuild, code, loader) {
  return isFlow(code) || (await parseErrors(esbuild, code, loader)) !== null
}

async function javascript({ esbuild, stripFlow }, contents, path) {
  let source = contents
  if (stripFlow !== null && (await hasFlow(esbuild, contents, 'jsx'))) {
    try {
      source = stripFlow(contents, path)
    } catch (error) {
      // Left to Babel.
      if (!(error instanceof SyntaxError)) throw error
    }
  }
  return (await downgrade(esbuild, source, path)) ?? source
}

// null leaves the file to Babel as it is: esbuild can't parse it, would misread
// a Flow call with type arguments in it, would drop the JSX pragmas Babel reads
// off its comments, or would lower decorators, whose semantics (legacy or not)
// the Babel config picks.
async function downgrade(esbuild, contents, path) {
  if ((isFlow(contents) && MAYBE_TYPE_ARGUMENTS.test(contents)) || contents.includes('@jsx')) return null
  let code
  try {
    code = await lower(esbuild, contents, 'jsx', path, { supported: BEFORE_BABEL })
  } catch (error) {
    // Parse errors have a location; errors in options don't.
    if (!Array.isArray(error?.errors) || !error.errors.every(({ location }) => location)) throw error
    return null
  }
  return decorated(code) ? null : code
}

// As @react-native/babel-preset's TS plugin makes it: fields with no value
// dropped, the rest assigned; unused imports dropped, but React in TSX.
// tsconfig isn't read: Metro doesn't. null leaves the file to Babel as it is,
// where the project's TS plugin keeps otherwise or reads JSX pragmas off
// comments, which esbuild drops.
async function typescript({ esbuild, babelTypescript }, contents, loader, path) {
  const plugin = await babelTypescript?.(path)
  if (contents.includes('@jsx') || TS_OPTIONS.some((option) => plugin?.[option] !== undefined)) return null
  const tsconfigRaw = (useDefineForClassFields) => ({ compilerOptions: { useDefineForClassFields } })
  const code = await lower(esbuild, contents, loader, path, { supported: BEFORE_BABEL, tsconfigRaw: tsconfigRaw(false) })
  // Decorated: types stripped alone, classes left to the project's Babel config.
  return decorated(code) ? lower(esbuild, contents, loader, path, { tsconfigRaw: tsconfigRaw(true) }) : code
}

// esbuild brings in this helper only to lower decorators.
function decorated(code) {
  return code.includes('__decoratorStart(')
}

async function lower(esbuild, contents, loader, path, options) {
  const tsx = loader === 'tsx'
  const { code } = await esbuild.transform(tsx ? `${contents}\n;${USE_REACT}` : contents, { loader, jsx: 'preserve', sourcefile: path, logLevel: 'silent', ...options })
  return tsx && code.endsWith(USE_REACT) ? code.slice(0, -USE_REACT.length) : code
}
