#!/usr/bin/env node
// rn-bundle --platform=ios --output=main.js [--dev] [--minify]
//   [--assets-dest=DIR] [--asset-catalog-dest=DIR] [--sourcemap-output=FILE]
//   [--sourcemap-sources-root=DIR] [--sourcemap-use-absolute-path]
//   [--metro-config=FILE] [--babel] [--esm] [--profile] [--define=K=V ...]
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
// esbuild with --minify, as `stasis build --minify` makes it. --babel runs the
// project's babel.config.* over each JS and TS file first, with its own
// @babel/core, and Metro's caller and Babel env, as Metro's transformer does,
// after esbuild makes TS JS and lowers what Babel's preset throws on (static
// blocks, `using`) and what the config's plugins lower as esbuild does
// (async functions and generators, `export * as`), which Babel is then
// without; esbuild lowers the rest in the bundle, after Babel. --esm leaves
// import and export to esbuild, which links the modules as it does without
// Babel, dropping what of them is unused: the config is without its plugin
// that makes them CommonJS, but in a file that names `module` or `exports`
// with them, or in which esbuild finds an import of what an ES module doesn't
// export, which it warns of (Metro's is undefined). An import resolves for
// ESM, as Metro resolves it: by exports' `import` condition. --profile
// reports the time each of the config's plugins takes, summed over Babel's
// workers: the files its visitors ran in, their calls, and the time outside
// the plugins. Flow
// types are stripped first, by flow-remove-types; with --babel, where that
// isn't installed, Babel's config strips them, as it does a file with Flow
// that is code (`component`, `hook`), which flow-remove-types leaves. The
// extensions metro.config.js (else --metro-config) lists among `assetExts`
// are assets too, read off it, never run: by oxc-parser where installed,
// else in the usual form by a regex. As Metro serializes a bundle as
// @react-native/metro-config configures it: Metro's prelude, then
// @react-native/js-polyfills's polyfills (the project's
// @react-native/metro-config's), then react-native/setup-env (InitializeCore
// before 0.87), then the entry; each asset registered with the project's
// react-native's registry (react-native/asset-registry from 0.87).

import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { assetCatalogFiles, assetsDestFiles } from '../src/assets-dest.js'
import { profileReport } from '../src/babel-worker.js'
import { bundle } from '../src/bundle.js'
import { assetExts, babelAliases, defines, failer, flowStripper, peers, polyfills, projectBabel } from '../src/cli.js'
import { diskHost } from '../src/defaults.js'
import { prelude } from '../src/serializer.js'
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
    babel: { type: 'boolean', default: false },
    esm: { type: 'boolean', default: false },
    profile: { type: 'boolean', default: false },
    define: { type: 'string', multiple: true, default: [] },
    'babel-aliases': { type: 'string' },
  },
})

const fail = failer('rn-bundle')

if (positionals.length !== 1) fail('one entry file is required')
if (values.platform === undefined) fail('--platform is required, e.g. --platform=ios')
if (values.output === undefined) fail('--output is required')
if (values.profile && !values.babel) fail('--profile times the plugins of --babel: pass it')
if (values.esm && !values.babel) fail('--esm keeps ES modules through --babel: pass it')
if (values.babel && values['babel-aliases'] !== undefined) fail("--babel takes the aliases of the project's Babel config; --babel-aliases takes them from a file: pass one")
const sourcemap = values['sourcemap-output']
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
const babel = values.babel ? projectBabel(cwd, project, fail, { profile: values.profile, sourceMaps: sourcemap !== undefined })({ platform: values.platform, dev: values.dev }) : null
let result
try {
  result = await bundle({
    entry: positionals[0],
    platform: values.platform,
    outfile: values.output,
    esbuild,
    projectRoot: cwd,
    stripFlow: flowStripper(project, values.babel),
    babel: babel?.babel ?? null,
    babelPlugins: babel?.babelPlugins ?? null,
    esm: values.esm,
    assetExts: assetExts(cwd, project, fail, values['metro-config'] ?? null),
    define,
    minify: values.minify,
    sourcemap: sourcemap !== undefined,
    prelude: prelude(define.__DEV__, values.dev ? 'development' : 'production'),
    polyfills: polyfills(project, fail),
    aliases: values['babel-aliases'] === undefined ? null : babelAliases(cwd, values['babel-aliases'], fail),
  })
} catch (error) {
  if (!Array.isArray(error?.errors)) throw error
  for (const line of await esbuild.formatMessages(error.errors, { kind: 'error' })) process.stderr.write(line)
  fail(`esbuild reported ${error.errors.length} error(s)`)
}
for (const line of await esbuild.formatMessages(result.warnings, { kind: 'warning' })) process.stderr.write(line)

const write = (path, contents) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
}
const outfile = resolve(cwd, values.output)
const sourcesRoot = values['sourcemap-sources-root'] === undefined ? null : resolve(cwd, values['sourcemap-sources-root'])
const sourceMapUrl = sourcemap === undefined ? null : values['sourcemap-use-absolute-path'] ? resolve(cwd, sourcemap) : basename(sourcemap)
for (const { path, contents, text } of result.outputFiles) {
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
process.stderr.write(`rn-bundle: ${positionals[0]} for ${values.platform} to ${values.output} (esbuild ${esbuild.version}), ${result.graph.size} modules, ${result.assets.length} assets\n`)
if (babel?.profile) process.stderr.write(profileReport(babel.profile, cwd))
