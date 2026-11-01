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
// Lowered by esbuild before Babel. Decorators only to detect them: esbuild
// drops a field's decorators when it lowers the field.
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
// A call with type arguments needs a `>`, then only space or comments, then
// `(` or a backtick.
const MAYBE_TYPE_ARGUMENTS = /(?<!=)>(?:\s|\/\/.*|\/\*[\s\S]*?\*\/)*[(`]/u
// So that TS reads JS as JS does, but for type arguments.
const AS_JS = { compilerOptions: { verbatimModuleSyntax: true, useDefineForClassFields: true } }
// Babel reads a JSX pragma off any line of a comment's text.
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
  // (source, path) => source with Flow types stripped.
  stripFlow = null,
  // (source, path) => the project's Babel output.
  babel = null,
  // async (path) => the options of the project's Babel TS plugin for a file, or null.
  babelTypescript = null,
  // async (source, path) => the text of each comment of a TS file, as Babel parses it.
  babelComments = null,
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
  const options = { esbuild, host, projectRoot, jsx, stripFlow, babel, babelTypescript, babelComments }
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

async function loadFile({ esbuild, host, projectRoot, jsx, stripFlow, babel, babelTypescript, babelComments }, path) {
  const loader = jsx && JS.has(extname(path)) ? 'jsx' : (LOADERS.get(extname(path)) ?? 'js')
  const contents = decoder.decode(host.readFile(path))
  if (babel !== null && loader !== 'json') {
    let source
    try {
      source = loader === 'ts' || loader === 'tsx' ? await typescript({ esbuild, babelTypescript, babelComments }, contents, loader, path) : await javascript({ esbuild, stripFlow }, contents, path)
    } catch (error) {
      if (error?.code === 'BABEL_PARSE_ERROR') return { errors: [{ text: `Babel: ${error.message}` }] }
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

async function hasFlow(esbuild, code, loader) {
  return (await parseErrors(esbuild, code, loader)) !== null || (await typeArguments(esbuild, code))
}

// `f<T>(x)` is a call to Flow (in @flow files, or in every file with Babel's
// `all: true`), but `(f < T) > x` to JS. esbuild's TS parser reads it as a
// call too, so such a file reads differently as TS than as JS.
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

// Parse errors have a location; errors in options don't.
function located(error) {
  return Array.isArray(error?.errors) && error.errors.every(({ location }) => location)
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

// null leaves the file to Babel as it is: esbuild can't parse it, may misread
// it, would drop the JSX pragmas Babel reads off its comments, or would lower
// decorators, whose semantics (legacy or not) the project's Babel config picks.
async function downgrade(esbuild, contents, path) {
  if (contents.includes('@jsx') || (await typeArguments(esbuild, contents))) return null
  let code
  try {
    code = await lower(esbuild, contents, 'jsx', path, { supported: DOWNGRADED })
  } catch (error) {
    if (!located(error)) throw error
    return null
  }
  return decorated(code) ? null : code
}

// Fields and imports kept as the project's Babel TS plugin keeps them. By
// default (as in @react-native/babel-preset) it drops fields with no value and
// unused imports, but not, in TSX, those only JSX uses. tsconfig isn't read:
// Metro doesn't.
async function typescript({ esbuild, babelTypescript, babelComments }, contents, loader, path) {
  const { onlyRemoveTypeImports = false, allowDeclareFields = false, jsxPragma = 'React.createElement', jsxPragmaFrag = 'React.Fragment' } = (await babelTypescript?.(path)) ?? {}
  // esbuild drops comments, so the JSX pragmas Babel reads off them are carried over.
  const pragmas = contents.includes('@jsx') && babelComments !== null ? jsxPragmas(await babelComments(contents, path)) : []
  const verbatimModuleSyntax = onlyRemoveTypeImports === true
  const keep = verbatimModuleSyntax || loader !== 'tsx' ? [] : pragmaImports(pragmas, jsxPragma, jsxPragmaFrag)
  const tsconfigRaw = (useDefineForClassFields) => ({ compilerOptions: { useDefineForClassFields, verbatimModuleSyntax } })
  const lowered = (options) => lower(esbuild, contents, loader, path, options, keep)
  const code = await lowered({ supported: DOWNGRADED, tsconfigRaw: tsconfigRaw(allowDeclareFields === true) })
  // Decorated: types stripped alone, classes left to the project's Babel config.
  const js = decorated(code) ? await lowered({ tsconfigRaw: tsconfigRaw(true) }) : code
  return pragmas.map(([kind = '', value]) => `/* @jsx${kind} ${value} */\n`).join('') + js
}

// As Babel's TS plugin picks the imports it keeps for JSX.
function pragmaImports(pragmas, jsxPragma, jsxPragmaFrag) {
  let [pragma, frag] = [jsxPragma, jsxPragmaFrag]
  for (const [kind, value] of pragmas) {
    if (kind === undefined) pragma = value
    else if (kind === 'Frag') frag = value
  }
  return [...new Set([pragma, frag].map((name) => String(name).split('.')[0]).filter((name) => IDENTIFIER.test(name)))]
}

// esbuild brings in this helper only to lower decorators.
function decorated(code) {
  return code.includes('__decoratorStart(')
}

// A use of each name to keep, appended then taken off, keeps its import.
async function lower(esbuild, contents, loader, path, options, keep = []) {
  const uses = keep.map((name) => `typeof ${name};\n`).join('')
  const { code } = await esbuild.transform(uses ? `${contents}\n;${uses}` : contents, { loader, jsx: 'preserve', sourcefile: path, logLevel: 'silent', ...options })
  return uses && code.endsWith(uses) ? code.slice(0, -uses.length) : code
}

// [kind, value] of each JSX pragma in the comments' text.
function jsxPragmas(comments) {
  return comments.flatMap((text) => [...text.matchAll(JSX_PRAGMA)].map(([, kind, value]) => [kind, value]))
}
