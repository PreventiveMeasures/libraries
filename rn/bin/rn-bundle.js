#!/usr/bin/env node
// rn-bundle --platform=ios --output=main.js [--dev] [--minify]
//   [--assets-dest=DIR] [--babel] [--profile] [--define=K=V ...]
//   [--babel-aliases=FILE] ENTRY
// A React Native app's bundle: its imports resolved as Metro resolves them,
// built by esbuild (an iife), its assets as Metro's asset modules, copied to
// --assets-dest as `react-native bundle` lays them out. A release build, as
// `react-native bundle --dev=false` makes it, unless --dev; minified by
// esbuild with --minify, as `stasis build --minify` makes it. --babel runs the
// project's babel.config.* over each JS and TS file first, with its own
// @babel/core, and Metro's caller and Babel env, as Metro's transformer does,
// after esbuild makes TS JS and lowers what Babel's preset throws on (static
// blocks, `using`) and what the config's plugins lower as esbuild does
// (async functions and generators, `export * as`), which Babel is then
// without; esbuild lowers the rest in the bundle, after Babel. --profile
// reports the time each of the config's plugins takes, summed over Babel's
// workers: its files, its visitors' calls, and that outside the plugins. Flow
// types are stripped first, by flow-remove-types; with --babel, where that
// isn't installed, Babel's config strips them, as it does a file with Flow
// that is code (`component`, `hook`), which flow-remove-types leaves. The
// extensions metro.config.js lists among `assetExts` are assets too, read off
// it, never run: by oxc-parser where installed, else in the usual form by a
// regex. As Metro serializes a bundle as @react-native/metro-config configures
// it: Metro's prelude, then @react-native/js-polyfills's polyfills (the
// project's @react-native/metro-config's), then react-native/setup-env
// (InitializeCore before 0.87), then the entry; each asset registered with the
// project's react-native's registry (react-native/asset-registry from 0.87).

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { assetsDestFiles } from '../src/assets-dest.js'
import { profileReport } from '../src/babel-worker.js'
import { bundle } from '../src/bundle.js'
import { assetExts, babelAliases, defines, failer, flowStripper, peers, polyfills, projectBabel } from '../src/cli.js'
import { diskHost } from '../src/defaults.js'
import { prelude } from '../src/serializer.js'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    platform: { type: 'string' },
    output: { type: 'string' },
    dev: { type: 'boolean', default: false },
    minify: { type: 'boolean', default: false },
    'assets-dest': { type: 'string' },
    babel: { type: 'boolean', default: false },
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
if (values.babel && values['babel-aliases'] !== undefined) fail("--babel takes the aliases of the project's Babel config; --babel-aliases takes them from a file: pass one")

const define = defines(values.dev, values.define, fail)
// As `react-native bundle` sets it, before Metro's workers start, for Babel's
// plugins to read: Reanimated's (3), for production, leaves out each
// worklet's location and source map.
process.env.NODE_ENV = values.dev ? 'development' : 'production'
const cwd = process.cwd()
const project = peers(cwd, fail)
const esbuild = project.peer('esbuild', 'bundling')
const babel = values.babel ? projectBabel(cwd, project, fail, { profile: values.profile })({ platform: values.platform, dev: values.dev }) : null
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
    assetExts: assetExts(cwd, project, fail),
    define,
    minify: values.minify,
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
for (const { path, contents } of result.outputFiles) write(path, contents)
if (values['assets-dest'] !== undefined) {
  for (const { src, dest, contents } of assetsDestFiles(result.assets, values.platform)) write(resolve(cwd, values['assets-dest'], dest), contents ?? diskHost.readFile(src))
}
process.stderr.write(`rn-bundle: ${positionals[0]} for ${values.platform} to ${values.output} (esbuild ${esbuild.version}), ${result.graph.size} modules, ${result.assets.length} assets\n`)
if (babel?.profile) process.stderr.write(profileReport(babel.profile, cwd))
