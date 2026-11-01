// `stasis bundle --metro` and `stasis build --metro=PLATFORM` in one: the
// module graph as Metro resolves it for a platform, captured as esbuild
// follows the imports, is what esbuild builds. Each asset is built as Metro's
// asset module; each file is read through the host.

import { dirname, extname, relative, resolve } from 'node:path'

import { assetData, assetModule } from './assets.js'
import { defaults, diskHost } from './defaults.js'
import { createMetroResolver } from './resolve.js'

const LOADERS = new Map([['.js', 'js'], ['.cjs', 'js'], ['.mjs', 'js'], ['.jsx', 'jsx'], ['.ts', 'ts'], ['.cts', 'ts'], ['.mts', 'ts'], ['.tsx', 'tsx'], ['.json', 'json']])
const JS = new Set(['.js', '.cjs', '.mjs'])
// What esbuild lowers in a file before Babel gets it, a TS file made JS, as
// @exodus/test prepares code for Hermes: class fields, private members and
// static blocks, import attributes, `using`. And decorators, only to tell a
// file that has them: lowering a field, esbuild drops its decorators.
const DOWNGRADED = {
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
  decorators: false,
}
// What a call with type arguments, `f<T>(x)` or f<T>`x`, can't be without: a
// `>`, then what alone may come between it and the arguments, space and
// comments, then `(` or a backtick.
const MAYBE_TYPE_ARGUMENTS = /(?<!=)>(?:\s|\/\/.*|\/\*[\s\S]*?\*\/)*[(`]/u
// TS reading a JS file as JS does but for type arguments: every import kept,
// class fields defined.
const AS_JS = { compilerOptions: { verbatimModuleSyntax: true, useDefineForClassFields: true } }
// Comments, as near as a scan with no parser tells them, and the JSX pragmas
// Babel reads off their text, which esbuild drops: each a line of it, its kind
// (none for @jsx) and its value.
const COMMENT = /\/\*([\s\S]*?)\*\/|\/\/(.*)/gu
const JSX_PRAGMA = /^\s*(?:\*\s*)?@jsx(Frag|ImportSource|Runtime)?\s+(\S+)\s*$/gmu
const IDENTIFIER = /^[\p{ID_Start}$_][\p{ID_Continue}$\u200C\u200D]*$/u
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
  jsx = false,
  // (source, path) => source with Flow types stripped, for files that have them.
  stripFlow = null,
  // (source, path) => the code the project's Babel makes of each JS and TS
  // file, given it as esbuild makes it, where that keeps its meaning.
  babel = null,
  // async (path) => the options the TS plugin of the project's Babel config
  // takes for a TS file, which say what imports it keeps; null where it has
  // none.
  babelTypescript = null,
  define = {},
  // (file, specifier) => the specifier an alias rewrites it to, or null.
  aliases = null,
  assetRegistryPath = 'react-native/Libraries/Image/AssetRegistry',
  // Metro's resolver.assetExts: its defaults where not given.
  assetExts = defaults.assetExts,
}) {
  const resolveModule = createMetroResolver({ host, assetExts })
  const graph = new Map()
  const assets = new Map()
  const options = { esbuild, host, projectRoot, jsx, stripFlow, babel, babelTypescript }
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
    logLevel: 'silent',
    plugins: [plugin],
  })
  return { outputFiles: result.outputFiles, warnings: result.warnings, assets: [...assets.keys()].toSorted().map((path) => assets.get(path)), graph }
}

// Every JS and TS file through Babel, as Metro's transformer runs it, made
// ready for it by esbuild first; or a JS file with Flow types stripped, one
// that doesn't parse after (Flow that is code: `enum`, `component`) failing.
async function loadFile({ esbuild, host, projectRoot, jsx, stripFlow, babel, babelTypescript }, path) {
  const loader = jsx && JS.has(extname(path)) ? 'jsx' : (LOADERS.get(extname(path)) ?? 'js')
  const contents = decoder.decode(host.readFile(path))
  if (babel !== null && loader !== 'json') {
    let source
    try {
      source = loader === 'ts' || loader === 'tsx' ? await typescript(esbuild, contents, loader, path, await babelTypescript?.(path)) : await javascript({ esbuild, stripFlow }, contents, path)
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
  if (stripFlow === null || (loader !== 'js' && loader !== 'jsx') || !(await hasFlow(esbuild, contents, loader))) return { contents, loader }
  let stripped
  try {
    stripped = stripFlow(contents, path)
  } catch (error) {
    return { errors: [{ text: `Can't strip Flow types from ${relative(projectRoot, path)}: ${error.message}` }] }
  }
  const left = await parseErrors(esbuild, stripped, loader, path)
  if (left !== null) return { errors: left.map((error) => ({ ...error, text: `Flow syntax flow-remove-types doesn't strip: ${error.text}` })) }
  return { contents: stripped, loader }
}

// esbuild's errors parsing a file, or null where it parses.
async function parseErrors(esbuild, code, loader, path) {
  try {
    await esbuild.transform(code, { loader, sourcefile: path, logLevel: 'silent' })
    return null
  } catch (error) {
    return error.errors
  }
}

// Whether a JS file has Flow types to strip: where esbuild can't parse it, or
// where it may have type arguments.
async function hasFlow(esbuild, code, loader) {
  return (await parseErrors(esbuild, code, loader)) !== null || (await typeArguments(esbuild, code))
}

// Whether a JS file may have a call with type arguments, `f<T>(x)`, which JS
// reads as `(f < T) > x` and Flow as a call: in a @flow file, and in any where
// Babel's config parses Flow in each (`all: true`). Told by esbuild reading it
// as TS, where it is a call too, other than as JS.
async function typeArguments(esbuild, code) {
  if (!MAYBE_TYPE_ARGUMENTS.test(code)) return false
  const read = async (loader, tsconfigRaw) => (await esbuild.transform(code, { loader, jsx: 'preserve', tsconfigRaw, logLevel: 'silent' })).code
  try {
    const [js, ts] = await Promise.all([read('jsx'), read('tsx', AS_JS)])
    return js !== ts
  } catch (error) {
    if (!located(error)) throw error
    return true
  }
}

// Whether esbuild failed on what it parsed; not on an option it doesn't take.
function located(error) {
  return Array.isArray(error?.errors) && error.errors.every(({ location }) => location)
}

// A JS file for Babel: with --flow, its Flow types stripped where it has them,
// what flow-remove-types can't parse left to Babel as it is; then with what
// esbuild lowers lowered, where that keeps its meaning.
async function javascript({ esbuild, stripFlow }, contents, path) {
  let source = contents
  if (stripFlow !== null && (await hasFlow(esbuild, contents, 'jsx'))) {
    try {
      source = stripFlow(contents, path)
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
    }
  }
  return (await downgrade(esbuild, source, path)) ?? source
}

// A JS file with what esbuild lowers lowered, for Babel to make the rest of;
// or null, for Babel to take it as it is: where esbuild can't parse it (Flow,
// syntax only a Babel plugin takes), where it may have type arguments, and
// where it has decorators, which the project's Babel config gives their
// meaning (legacy, or not).
async function downgrade(esbuild, contents, path) {
  if (await typeArguments(esbuild, contents)) return null
  let code
  try {
    code = await lower(esbuild, contents, 'jsx', path, { supported: DOWNGRADED })
  } catch (error) {
    if (!located(error)) throw error
    return null
  }
  return decorated(code) ? null : code
}

// A TS file as JS, by esbuild, with what it lowers lowered, as Metro's Babel
// preset makes it: class fields assigned in the constructor, those that are
// types alone dropped (useDefineForClassFields: false); its fields and
// imports as the project's Babel TS plugin keeps them, by its options for the
// file. One with decorators has its types stripped alone, its classes left to
// the project's Babel config, which gives the decorators their meaning.
// Throws what esbuild can't parse.
async function typescript(esbuild, contents, loader, path, plugin) {
  const { onlyRemoveTypeImports = false, allowDeclareFields = false, jsxPragma = 'React.createElement', jsxPragmaFrag = 'React.Fragment' } = plugin ?? {}
  // A field with no value is a type alone, dropped; with allowDeclareFields, a
  // field, kept and defined as in JS, and only one `declare`d is dropped.
  const definedFields = allowDeclareFields === true
  // Each import but of types alone, as esbuild keeps them by
  // verbatimModuleSyntax; else none unused, as esbuild drops them, but in TSX
  // those the JSX pragmas name, which its JSX, kept, uses.
  const verbatimModuleSyntax = onlyRemoveTypeImports === true
  const keep = verbatimModuleSyntax || loader !== 'tsx' ? [] : pragmaImports(contents, jsxPragma, jsxPragmaFrag)
  const tsconfigRaw = (useDefineForClassFields) => ({ compilerOptions: { useDefineForClassFields, verbatimModuleSyntax } })
  const code = await lower(esbuild, contents, loader, path, { supported: DOWNGRADED, tsconfigRaw: tsconfigRaw(definedFields) }, keep)
  return decorated(code) ? lower(esbuild, contents, loader, path, { tsconfigRaw: tsconfigRaw(true) }, keep) : code
}

// The names whose imports Babel's TS plugin keeps for JSX alone: the roots of
// its jsxPragma and jsxPragmaFrag, or of the file's @jsx and @jsxFrag.
function pragmaImports(contents, jsxPragma, jsxPragmaFrag) {
  let [pragma, frag] = [jsxPragma, jsxPragmaFrag]
  for (const [kind, value] of jsxPragmas(contents)) {
    if (kind === undefined) pragma = value
    else if (kind === 'Frag') frag = value
  }
  return [...new Set([pragma, frag].map((name) => String(name).split('.')[0]).filter((name) => IDENTIFIER.test(name)))]
}

// Whether esbuild lowered decorators: it brings in this helper for that alone.
function decorated(code) {
  return code.includes('__decoratorStart(')
}

// A file as esbuild makes it JS, its JSX kept, with the JSX pragmas Babel
// reads carried over, and the imports of the names given kept: a use of each
// appended, then taken off.
async function lower(esbuild, contents, loader, path, options, keep = []) {
  const uses = keep.map((name) => `typeof ${name};\n`).join('')
  const { code } = await esbuild.transform(uses ? `${contents}\n;${uses}` : contents, { loader, jsx: 'preserve', sourcefile: path, logLevel: 'silent', ...options })
  const pragmas = jsxPragmas(contents).map(([kind = '', value]) => `/* @jsx${kind} ${value} */\n`).join('')
  return pragmas + (uses && code.endsWith(uses) ? code.slice(0, -uses.length) : code)
}

// The JSX pragmas Babel reads off a file's comments: [kind, value] each.
function jsxPragmas(contents) {
  if (!contents.includes('@jsx')) return []
  return [...contents.matchAll(COMMENT)].flatMap(([, block, line]) => [...(block ?? line).matchAll(JSX_PRAGMA)].map(([, kind, value]) => [kind, value]))
}
