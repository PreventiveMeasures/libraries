#!/usr/bin/env node
// rn-bundle --platform=ios --output=main.js [--dev] [--minify]
//   [--assets-dest=DIR] [--jsx] [--babel] [--define=K=V ...]
//   [--babel-aliases=FILE] ENTRY
// A React Native app's bundle: its imports resolved as Metro resolves them,
// built by esbuild (an iife), its assets as Metro's asset modules, copied to
// --assets-dest as `react-native bundle` lays them out. A release build, as
// `react-native bundle --dev=false` makes it, unless --dev; minified by
// esbuild with --minify, as `stasis build --minify` makes it. --babel runs the
// project's babel.config.* over each JS and TS file first, with its own
// @babel/core, and Metro's caller and Babel env, as Metro's transformer does,
// after esbuild makes TS JS and lowers what Babel's preset throws on (static
// blocks, `using`); esbuild lowers the rest in the bundle, after Babel. Flow
// types are stripped first, by flow-remove-types; with --babel, where that
// isn't installed, Babel's config strips them. The extensions metro.config.js
// lists among `assetExts` are assets too, read off it, never run: by
// oxc-parser where installed, else in the usual form by a regex.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { assetsDestFiles } from '../src/assets-dest.js'
import { createAliases } from '../src/babel-aliases.js'
import { babelWorkers } from '../src/babel-worker.js'
import { bundle } from '../src/bundle.js'
import { defaults, diskHost } from '../src/defaults.js'
import { metroAssetExts, scanMetroAssetExts } from '../src/metro-config.js'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    platform: { type: 'string' },
    output: { type: 'string' },
    dev: { type: 'boolean', default: false },
    minify: { type: 'boolean', default: false },
    'assets-dest': { type: 'string' },
    jsx: { type: 'boolean', default: false },
    babel: { type: 'boolean', default: false },
    define: { type: 'string', multiple: true, default: [] },
    'babel-aliases': { type: 'string' },
  },
})

const fail = (message) => {
  process.stderr.write(`rn-bundle: ${message}\n`)
  process.exit(1)
}

if (positionals.length !== 1) fail('one entry file is required')
if (values.platform === undefined) fail('--platform is required, e.g. --platform=ios')
if (values.output === undefined) fail('--output is required')
if (values.babel && values['babel-aliases'] !== undefined) fail("--babel takes the aliases of the project's Babel config; --babel-aliases takes them from a file: pass one")

// __DEV__ and process.env.NODE_ENV as Metro's prelude sets them for --dev or
// not, unless --define sets them.
const define = { __DEV__: String(values.dev), 'process.env.NODE_ENV': JSON.stringify(values.dev ? 'development' : 'production') }
for (const pair of values.define) {
  const at = pair.indexOf('=')
  if (at < 1) fail(`--define takes K=V, not ${pair}`)
  define[pair.slice(0, at)] = pair.slice(at + 1)
}

const cwd = process.cwd()
const fromProject = createRequire(resolve(cwd, 'package.json'))
const fromHere = createRequire(import.meta.url)
// A peer as the project installs it, else as installed beside rn-bundle.
const locate = (from, name) => {
  try {
    return from.resolve(name)
  } catch {
    return null
  }
}
const peer = (name, why) => {
  const path = locate(fromProject, name) ?? locate(fromHere, name)
  return path === null ? fail(`${why} needs ${name}: npm i -D ${name}`) : fromHere(path)
}
const esbuild = peer('esbuild', 'bundling')
const flowRemoveTypes = locate(fromProject, 'flow-remove-types') ?? locate(fromHere, 'flow-remove-types')
// Flow types stripped by flow-remove-types; with --babel, where it isn't
// installed, left to Babel's config, as Metro leaves them.
function stripFlow() {
  if (flowRemoveTypes !== null) return (source) => fromHere(flowRemoveTypes)(source, { all: true, removeEmptyImports: true }).toString()
  if (values.babel) return null
  return () => {
    throw new Error('it needs flow-remove-types: npm i -D flow-remove-types')
  }
}

function babelAliases(file) {
  let alias
  try {
    alias = JSON.parse(readFileSync(resolve(cwd, file), 'utf8'))
  } catch {
    return fail(`--babel-aliases: can't read ${file} as JSON`)
  }
  try {
    return createAliases(alias, cwd)
  } catch (error) {
    return fail(`--babel-aliases: ${file}: ${error.message}`)
  }
}

// Metro's asset extensions, and those metro.config.js adds: read by its AST
// where oxc-parser is installed, else in the one form a regex reads.
function assetExts() {
  const config = resolve(cwd, 'metro.config.js')
  if (!existsSync(config)) return defaults.assetExts
  const source = readFileSync(config, 'utf8')
  const oxc = locate(fromProject, 'oxc-parser') ?? locate(fromHere, 'oxc-parser')
  const listed = oxc === null ? scanMetroAssetExts(source) : metroAssetExts(fromHere(oxc).parseSync(config, source, { sourceType: 'unambiguous' }).program)
  return listed === null ? fail('reading the assetExts of metro.config.js needs oxc-parser: npm i -D oxc-parser') : [...defaults.assetExts, ...listed]
}

// The project's babel.config.*, by the project's own @babel/core.
function projectBabel() {
  const configFile = ['babel.config.js', 'babel.config.cjs', 'babel.config.mjs', 'babel.config.json'].map((name) => resolve(cwd, name)).find((file) => existsSync(file))
  if (configFile === undefined) fail('--babel needs a babel.config.(js|cjs|mjs|json) in the project')
  const corePath = locate(fromProject, '@babel/core')
  if (corePath === null) fail('--babel needs @babel/core installed in the project')
  const core = fromHere(corePath)
  const caller = { name: 'metro', bundler: 'metro', platform: values.platform }
  // The env Metro's transformer names, which plugins read for a release
  // build: react-native-worklets omits each worklet's location and source map.
  const envName = values.dev ? 'development' : process.env.BABEL_ENV || 'production'
  const options = { cwd, root: cwd, configFile, caller, envName }
  return {
    transform: babelWorkers(corePath, { ...options, compact: false }),
    typescript: async (filename) => (await core.loadOptionsAsync({ ...options, filename }))?.plugins.find(({ key }) => key === 'transform-typescript')?.options ?? null,
  }
}

const babel = values.babel ? projectBabel() : null
let result
try {
  result = await bundle({
    entry: positionals[0],
    platform: values.platform,
    outfile: values.output,
    esbuild,
    projectRoot: cwd,
    jsx: values.jsx,
    stripFlow: stripFlow(),
    babel: babel?.transform ?? null,
    babelTypescript: babel?.typescript ?? null,
    assetExts: assetExts(),
    define,
    minify: values.minify,
    aliases: values['babel-aliases'] === undefined ? null : babelAliases(values['babel-aliases']),
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
