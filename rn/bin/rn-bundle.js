#!/usr/bin/env node
// rn-bundle --platform=ios --output=main.js [--dev] [--minify]
//   [--assets-dest=DIR] [--asset-catalog-dest=DIR] [--sourcemap-output=FILE]
//   [--sourcemap-sources-root=DIR] [--sourcemap-use-absolute-path]
//   [--metro-config=FILE] [--esm] [--profile] [--self-test]
//   [--unstable-transform-profile=PROFILE] [--define=K=V ...]
//   [--babel-aliases=FILE] ENTRY
// A React Native app's bundle: its imports resolved as Metro resolves them,
// built by esbuild (an iife), its assets as Metro's asset modules, copied to
// --assets-dest as `react-native bundle` lays them out; with
// --asset-catalog-dest, iOS's png and jpg assets go to DIR/RNAssets.xcassets
// instead, each an image set, as `react-native bundle` puts them for an app
// whose Info.plist has RCTUseAssetCatalog. --sourcemap-output writes the
// bundle's source map there, as `react-native bundle` does: through esbuild's
// lowering and minifying and Babel's transform, each source's path absolute,
// else from --sourcemap-sources-root, those in node_modules on its ignore
// list; the bundle's sourceMappingURL the map's name, or its path with
// --sourcemap-use-absolute-path. A release build, as
// `react-native bundle --dev=false` makes it, unless --dev; minified by
// esbuild with --minify, as `stasis build --minify` makes it. The project's
// Babel config, as Metro's transformer takes it (a babel.config.*, else a
// .babelrc, else @react-native/babel-preset), runs over each JS and TS file
// first, with the project's @babel/core, and Metro's caller and Babel env,
// after esbuild makes TS JS and lowers what Babel's preset throws on (static
// blocks, `using`) and what the config's plugins lower as esbuild does
// (async functions and generators, `export * as`), which Babel is then
// without; esbuild lowers the rest in the bundle, after Babel. --esm leaves
// import and export to esbuild, which links the modules as it does without
// Babel, dropping what of them is unused: the config is without its plugin
// that makes them CommonJS, but in a file that names `module` or `exports`
// with them, or in which esbuild finds an import of what an ES module doesn't
// export, which it warns of (Metro's is undefined). A function keeps its
// name, which esbuild, joining the modules in one scope, renames where two
// declare it (`Text3`), but where it minifies. An import resolves for
// ESM, as Metro resolves it: by exports' `import` condition.
// --unstable-transform-profile, `react-native bundle`'s: the profile Babel's
// caller names (default, hermes-stable, hermes-canary), which
// @react-native/babel-preset builds for; default where not given. --profile
// reports the time each of the config's plugins takes, summed over Babel's
// workers: the files its visitors ran in, their calls, and the time outside
// the plugins. --self-test builds again, Babel without none of the config's
// plugins it leaves out for having nothing to do (but those esbuild lowers
// before it), and fails where a module's Babel output differs, as esbuild
// prints each (its quotes, layout and comments alike); with it, --output
// may be left out, and nothing is written but the assets. Flow
// types are stripped first, by flow-remove-types; where Babel runs and that
// isn't installed, Babel's config strips them, as it does a file with Flow
// that is code (`component`, `hook`), which flow-remove-types leaves. The
// project's Metro config (metro.config.js, else --metro-config) is loaded as
// Metro loads it, by the project's metro-config, and its resolver's options
// (assetExts, sourceExts, blockList...), polyfills, modules run before the
// entry and asset registry taken, and the inline requires its transformer's
// getTransformOptions gives (@react-native/metro-config's), which Babel's
// workers inline after the Babel config's plugins, by the project's Metro,
// as Metro's transform worker does: a module required where it is first
// used, not before the module that imports it runs, nor at all where unused
// (but React's, react-native, and default and namespace imports); any other
// option not as Metro's default, or @react-native/metro-config's, has (a
// Babel transformer, a resolver or serializer of its own), and of bearing
// on the bundle, is an error. Without one, as Metro serializes a bundle as
// @react-native/metro-config configures it, its requires inlined as it has
// them: Metro's prelude, then @react-native/js-polyfills's
// polyfills (the project's @react-native/metro-config's), then
// react-native/setup-env (InitializeCore before 0.87), then the entry; each
// asset registered with the project's react-native's registry
// (react-native/asset-registry from 0.87).

import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { assetCatalogFiles, assetsDestFiles } from '../src/assets-dest.js'
import { profileReport } from '../src/babel-worker.js'
import { bundle } from '../src/bundle.js'
import { TRANSFORM_PROFILES, babelAliases, defines, failer, flowStripper, peers, projectBabel } from '../src/cli.js'
import { diskHost } from '../src/defaults.js'
import { metroOptions } from '../src/metro-options.js'
import { prelude } from '../src/serializer.js'
import { differences } from '../src/self-test.js'
import { metroSourceMap } from '../src/source-map.js'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    platform: { type: 'string' },
    output: { type: 'string' },
    dev: { type: 'boolean', default: false },
    minify: { type: 'boolean', default: false },
    'assets-dest': { type: 'string' },
    'asset-catalog-dest': { type: 'string' },
    'sourcemap-output': { type: 'string' },
    'sourcemap-sources-root': { type: 'string' },
    'sourcemap-use-absolute-path': { type: 'boolean', default: false },
    'metro-config': { type: 'string' },
    esm: { type: 'boolean', default: false },
    profile: { type: 'boolean', default: false },
    'self-test': { type: 'boolean', default: false },
    'unstable-transform-profile': { type: 'string' },
    define: { type: 'string', multiple: true, default: [] },
    'babel-aliases': { type: 'string' },
  },
})

const fail = failer('rn-bundle')

if (positionals.length !== 1) fail('one entry file is required')
if (values.platform === undefined) fail('--platform is required, e.g. --platform=ios')
const selfTest = values['self-test']
if (values.output === undefined && !selfTest) fail('--output is required')
const transformProfile = values['unstable-transform-profile'] ?? 'default'
if (!TRANSFORM_PROFILES.includes(transformProfile)) fail(`--unstable-transform-profile is one of ${TRANSFORM_PROFILES.join(', ')}`)
const sourcemap = values['sourcemap-output']
if (sourcemap !== undefined && values.output === undefined) fail('--sourcemap-output maps the bundle of --output: pass it')
if (sourcemap === undefined && (values['sourcemap-sources-root'] !== undefined || values['sourcemap-use-absolute-path'])) fail('--sourcemap-sources-root and --sourcemap-use-absolute-path shape the map of --sourcemap-output: pass it')
if (values['asset-catalog-dest'] !== undefined && values.platform !== 'ios') fail('--asset-catalog-dest is for iOS')

const define = defines(values.dev, values.define, fail)
// As `react-native bundle` sets it, before Metro's workers start, for Babel's
// plugins to read: Reanimated's (3), for production, leaves out each
// worklet's location and source map.
process.env.NODE_ENV = values.dev ? 'development' : 'production'
const cwd = process.cwd()
const project = peers(cwd, fail)
const esbuild = project.peer('esbuild', 'bundling')
const metro = await metroOptions(cwd, project, fail, { file: values['metro-config'] ?? null, name: 'rn-bundle', minify: values.minify })
const transformRefusal = await metro.transformRefusal(resolve(cwd, positionals[0]), { platform: values.platform, dev: values.dev })
if (transformRefusal !== null) fail(transformRefusal)
const inlineRequires = await metro.inlineRequires(resolve(cwd, positionals[0]), { platform: values.platform, dev: values.dev })
const babel = projectBabel(cwd, project, fail, { profile: values.profile, sourceMaps: sourcemap !== undefined, transformProfile, babelRCLookup: metro.babelRCLookup, babelRuntime: metro.babelRuntime })?.({ platform: values.platform, dev: values.dev, inlineRequires }) ?? null
if (values.profile && babel === null) fail("--profile times the plugins of the project's Babel config, and it has none")
if (selfTest && babel === null) fail("--self-test builds again with each of the plugins of the project's Babel config, and it has none")
if (values.esm && babel === null) fail("--esm keeps ES modules through the project's Babel config, and it has none")
// The default, of no bearing on what is built, as Metro takes it.
if (transformProfile !== 'default' && babel === null) fail("--unstable-transform-profile is the profile the project's Babel config builds for, and it has none")
if (babel !== null && values['babel-aliases'] !== undefined) fail("--babel-aliases maps the imports where no Babel runs: the project's Babel config has its aliases")
// Builds, failing as esbuild does.
const build = async (options) => {
  try {
    return await bundle(options)
  } catch (error) {
    if (!Array.isArray(error?.errors)) throw error
    for (const line of await esbuild.formatMessages(error.errors, { kind: 'error' })) process.stderr.write(line)
    return fail(`esbuild reported ${error.errors.length} error(s)`)
  }
}
const options = {
  entry: positionals[0],
  platform: values.platform,
  // Without --output (--self-test), a bundle not written.
  outfile: values.output ?? 'rn-bundle.js',
  esbuild,
  projectRoot: cwd,
  stripFlow: flowStripper(project, babel !== null),
  babel: babel?.babel ?? null,
  babelPlugins: babel?.babelPlugins ?? null,
  esm: values.esm,
  assetExts: metro.assetExts,
  resolver: { ...metro.resolver, dev: values.dev },
  blockList: metro.blockList,
  runBeforeMain: metro.runBeforeMain?.(resolve(cwd, positionals[0])) ?? null,
  assetRegistryPath: metro.assetRegistryPath,
  define,
  minify: values.minify,
  sourcemap: sourcemap !== undefined,
  prelude: prelude(define.__DEV__, values.dev ? 'development' : 'production'),
  polyfills: metro.polyfills(values.platform),
  aliases: values['babel-aliases'] === undefined ? null : babelAliases(cwd, values['babel-aliases'], fail),
}
// Each module as this build loaded it, for --self-test.
const ours = selfTest ? new Map() : null
const result = await build({ ...options, cache: ours })
for (const line of await esbuild.formatMessages(result.warnings, { kind: 'warning' })) process.stderr.write(line)

const write = (path, contents) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
}
const outfile = values.output === undefined ? null : resolve(cwd, values.output)
const sourcesRoot = values['sourcemap-sources-root'] === undefined ? null : resolve(cwd, values['sourcemap-sources-root'])
const sourceMapUrl = sourcemap === undefined ? null : values['sourcemap-use-absolute-path'] ? resolve(cwd, sourcemap) : basename(sourcemap)
for (const { path, contents, text } of values.output === undefined ? [] : result.outputFiles) {
  if (sourcemap === undefined) write(path, contents)
  else if (path === outfile) write(path, `${text}//# sourceMappingURL=${sourceMapUrl}\n`)
  else write(resolve(cwd, sourcemap), metroSourceMap(text, { outDir: dirname(outfile), projectRoot: cwd, sourcesRoot }))
}
let { assets } = result
if (values['asset-catalog-dest'] !== undefined) {
  const catalog = resolve(cwd, values['asset-catalog-dest'], 'RNAssets.xcassets')
  // As `react-native bundle` does, the image sets of a build before removed.
  mkdirSync(catalog, { recursive: true })
  for (const name of readdirSync(catalog)) {
    if (name.endsWith('.imageset')) rmSync(join(catalog, name), { recursive: true, force: true })
  }
  const { files, rest } = assetCatalogFiles(assets)
  for (const { src, dest, contents } of files) write(join(catalog, dest), contents ?? diskHost.readFile(src))
  assets = rest
}
if (values['assets-dest'] !== undefined) {
  for (const { src, dest, contents } of assetsDestFiles(assets, values.platform)) write(resolve(cwd, values['assets-dest'], dest), contents ?? diskHost.readFile(src))
}
process.stderr.write(`rn-bundle: ${positionals[0]} for ${values.platform}${values.output === undefined ? '' : ` to ${values.output}`} (esbuild ${esbuild.version}), ${result.graph.size} modules, ${result.assets.length} assets\n`)
if (babel?.profile) process.stderr.write(profileReport(babel.profile, cwd))
if (selfTest) {
  const kept = projectBabel(cwd, project, fail, { sourceMaps: sourcemap !== undefined, transformProfile, babelRCLookup: metro.babelRCLookup, babelRuntime: metro.babelRuntime, keepPlugins: true })({ platform: values.platform, dev: values.dev, inlineRequires })
  const theirs = new Map()
  await build({ ...options, babel: kept.babel, babelPlugins: kept.babelPlugins, keepPlugins: true, cache: theirs })
  const found = await differences(esbuild, ours, theirs)
  const cut = (line) => (line.length > 160 ? `${line.slice(0, 160)}...` : line)
  if (found.length === 0) process.stderr.write(`rn-bundle: --self-test: each of ${ours.size} modules is as Babel makes it with each of the config's plugins\n`)
  else {
    process.stderr.write(`rn-bundle: --self-test: ${found.length} of ${ours.size} modules differ from Babel's output with each of the config's plugins:\n`)
    for (const { path, line, ours: mine, kept: other } of found) {
      const name = relative(cwd, path).replaceAll('\\', '/')
      process.stderr.write(line === null ? `  ${name}: in ${mine === null ? 'that' : 'this'} build alone\n` : `  ${name}:${line}\n    - ${cut(mine)}\n    + ${cut(other)}\n`)
    }
    process.exitCode = 1
  }
}
