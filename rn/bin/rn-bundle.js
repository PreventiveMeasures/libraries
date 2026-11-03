#!/usr/bin/env node
// rn-bundle --platform=ios --output=main.js [--dev] [--minify] [--assets-dest=DIR] [--asset-catalog-dest=DIR]
//   [--sourcemap-output=FILE] [--sourcemap-sources-root=DIR] [--sourcemap-use-absolute-path] [--metro-config=FILE]
//   [--esm | --no-esm] [--inline-requires | --no-inline-requires] [--profile] [--self-test] [--unstable-transform-profile=PROFILE] [--max-workers=N] [--define=K=V ...] [--babel-aliases=FILE] ENTRY
// Bundles a React Native app as `react-native bundle` does: the Metro config loaded and imports resolved as Metro does,
// the project's Babel config run over each file, then esbuild. rn.config.json (src/rn-config.js) sets flag defaults.
// --profile times the config's Babel plugins; --self-test rebuilds skipping none of them and fails if a module differs.

import { enableCompileCache } from 'node:module'

// Enabled before the dynamic import so @babel/core, esbuild and Metro's config also load from
// Node's on-disk compile cache (NODE_DISABLE_COMPILE_CACHE=1 turns it off).
enableCompileCache()

const { rnBundle } = await import('../src/rn-bundle.js')
process.exitCode = await rnBundle(process.argv.slice(2))
