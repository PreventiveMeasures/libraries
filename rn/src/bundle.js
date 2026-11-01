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
// What esbuild lowers in a JS file before Babel gets it, as @exodus/test
// prepares code for Hermes: class fields, private members and static blocks,
// import attributes, `using`. And decorators, only to tell a file that has
// them: lowering a field, esbuild drops its decorators.
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
// Comments Babel reads, which esbuild drops: whether `f<T>(x)` is a Flow call,
// how JSX is built.
const PRAGMA = /@(?:flow|jsx(?:Frag|ImportSource|Runtime)?)\b/u
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
  // (source, path) => source with Flow types stripped, for files esbuild can't parse.
  stripFlow = null,
  // (source, path) => the code the project's Babel makes of each JS and TS
  // file, a JS file given with what esbuild lowers lowered.
  babel = null,
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
  const options = { esbuild, host, projectRoot, jsx, stripFlow, babel }
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

// Every JS and TS file through Babel, as Metro's transformer runs it, a JS
// file lowered by esbuild first where it can be; or a JS file that doesn't
// parse with its Flow types stripped, one that still doesn't (Flow that is
// code: `enum`, `component`) failing.
async function loadFile({ esbuild, host, projectRoot, jsx, stripFlow, babel }, path) {
  const loader = jsx && JS.has(extname(path)) ? 'jsx' : (LOADERS.get(extname(path)) ?? 'js')
  const contents = decoder.decode(host.readFile(path))
  if (babel !== null && loader !== 'json') {
    const source = loader === 'js' || loader === 'jsx' ? ((await downgrade(esbuild, contents)) ?? contents) : contents
    try {
      return { contents: await babel(source, path), loader: 'js' }
    } catch (error) {
      return { errors: [{ text: `Babel: ${error.message}` }] }
    }
  }
  if (stripFlow === null || (loader !== 'js' && loader !== 'jsx')) return { contents, loader }
  const parseErrors = async (code) => {
    try {
      await esbuild.transform(code, { loader, sourcefile: path, logLevel: 'silent' })
      return null
    } catch (error) {
      return error.errors
    }
  }
  if ((await parseErrors(contents)) === null) return { contents, loader }
  let stripped
  try {
    stripped = stripFlow(contents, path)
  } catch (error) {
    return { errors: [{ text: `Can't strip Flow types from ${relative(projectRoot, path)}: ${error.message}` }] }
  }
  const left = await parseErrors(stripped)
  if (left !== null) return { errors: left.map((error) => ({ ...error, text: `Flow syntax flow-remove-types doesn't strip: ${error.text}` })) }
  return { contents: stripped, loader }
}

// A JS file with what esbuild lowers lowered, its JSX kept, for Babel to make
// the rest of; or null, for Babel to take it as it is: where esbuild can't
// parse it (Flow, syntax only a Babel plugin takes), where it has comments
// Babel reads, and where it has decorators, which the project's Babel config
// gives their meaning (legacy, or not). TS files aren't lowered: esbuild would
// strip their types, and with them imports only JSX uses (React, which Babel's
// classic runtime takes).
async function downgrade(esbuild, contents) {
  if (PRAGMA.test(contents)) return null
  let result
  try {
    result = await esbuild.transform(contents, { loader: 'jsx', jsx: 'preserve', supported: DOWNGRADED, logLevel: 'silent' })
  } catch (error) {
    // What esbuild can't parse; not an option this esbuild doesn't take.
    if (!Array.isArray(error?.errors) || !error.errors.every(({ location }) => location)) throw error
    return null
  }
  // A helper esbuild brings in only to lower decorators.
  return result.code.includes('__decoratorStart(') ? null : result.code
}
