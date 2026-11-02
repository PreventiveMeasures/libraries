#!/usr/bin/env node
// rn-bundle --platform=ios --output=main.js [--dev] [--minify]
//   [--assets-dest=DIR] [--asset-catalog-dest=DIR] [--sourcemap-output=FILE]
//   [--sourcemap-sources-root=DIR] [--sourcemap-use-absolute-path]
//   [--metro-config=FILE] [--esm | --no-esm] [--profile] [--self-test]
//   [--unstable-transform-profile=PROFILE] [--max-workers=N]
//   [--define=K=V ...] [--babel-aliases=FILE] ENTRY
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
// that makes them CommonJS, but in one that names `module` or `exports`
// unbound (not in a comment, a string or a property's name), which Babel's
// CommonJS binds, or in which esbuild finds an import of what an ES module
// doesn't export, which it warns of (Metro's is undefined). A function keeps
// its name, which esbuild, joining the modules in one scope, renames where two
// declare it (`Text3`), but where it minifies. An import resolves for
// ESM, as Metro resolves it: by exports' `import` condition.
// The project's rn.config.json (src/rn-config.js) has the defaults of
// --esm (its esm), --max-workers (its maxWorkers, over the Metro config's)
// and of the Metro config (its metroConfig: false, none, as of a project
// with none, but a package's exports read of any Metro; a path, that file),
// the flags over it; and what it adds to Metro's defaults of assetExts,
// sourceExts and assetResolutions (a Metro config that sets one of them
// too, an error).
// --unstable-transform-profile, `react-native bundle`'s: the profile Babel's
// caller names (default, hermes-stable, hermes-canary), which
// @react-native/babel-preset builds for; default where not given.
// --max-workers, `react-native bundle`'s: how many workers Babel runs in at
// most, over the Metro config's maxWorkers; where neither sets one (the
// config's Metro's default), 3 (1 of fewer than 4 CPUs): more, which the main
// thread can't keep busy, cost CPU and memory and slow it; a build's first
// files the main thread transforms itself, before any. --profile reports
// the time each of the config's plugins takes, summed over Babel's
// threads: the files its visitors ran in, their calls, and the time outside
// the plugins; and the main thread's before Babel: flow-remove-types'
// stripping of the files of Flow. --self-test builds again, Babel without none of the config's
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
// entry, asset registry and maxWorkers taken, and the inline requires its transformer's
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

import { enableCompileCache } from 'node:module'

// Node's cache of the code it compiles, on disk, as tsc has it: the
// project's @babel/core, esbuild's API and Metro's config, loaded below,
// compiled once of each version (NODE_DISABLE_COMPILE_CACHE=1 leaves it off).
enableCompileCache()

// Its work, of this process's arguments, its exit code this process's.
const { rnBundle } = await import('../src/rn-bundle.js')
process.exitCode = await rnBundle(process.argv.slice(2))
