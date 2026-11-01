// What rn-bundle and rn-serve share: their peers, as the project installs
// them, else as installed beside rn/; Flow stripping; the project's Babel
// config, in worker threads; @react-native/js-polyfills's polyfills; the
// assetExts of metro.config.js; --babel-aliases; --define.

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

import { createAliases } from './babel-aliases.js'
import { babelWorkers, newProfile } from './babel-worker.js'
import { defaults } from './defaults.js'
import { metroAssetExts, scanMetroAssetExts } from './metro-config.js'

const BABEL_CONFIGS = ['babel.config.js', 'babel.config.cjs', 'babel.config.mjs', 'babel.config.json']

// -> (message) => never: the message, as `name: message`, and exit 1.
export const failer = (name) => (message) => {
  process.stderr.write(`${name}: ${message}\n`)
  process.exit(1)
}

const tryResolve = (from, name) => {
  try {
    return from.resolve(name)
  } catch {
    return null
  }
}

// -> { fromProject, locate(name), load(path), peer(name, why) }: a peer is
// the project's, else the one beside rn/.
export function peers(cwd, fail) {
  const fromProject = createRequire(resolve(cwd, 'package.json'))
  const fromHere = createRequire(import.meta.url)
  const locate = (name) => tryResolve(fromProject, name) ?? tryResolve(fromHere, name)
  const peer = (name, why) => {
    const path = locate(name)
    return path === null ? fail(`${why} needs ${name}: npm i -D ${name}`) : fromHere(path)
  }
  return { fromProject, locate, load: (path) => fromHere(path), peer }
}

// __DEV__ and process.env.NODE_ENV as Metro's prelude sets them for a dev
// build or not, unless a K=V pair sets them.
export function defines(dev, pairs, fail) {
  const define = { __DEV__: String(dev), 'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production') }
  for (const pair of pairs) {
    const at = pair.indexOf('=')
    if (at < 1) fail(`--define takes K=V, not ${pair}`)
    define[pair.slice(0, at)] = pair.slice(at + 1)
  }
  return define
}

// Flow types stripped by flow-remove-types; with --babel, where it isn't
// installed, left to Babel's config, as Metro leaves them.
export function flowStripper({ locate, load }, babel) {
  const flowRemoveTypes = locate('flow-remove-types')
  if (flowRemoveTypes !== null) return (source) => load(flowRemoveTypes)(source, { all: true, removeEmptyImports: true }).toString()
  if (babel) return null
  return () => {
    throw new Error('it needs flow-remove-types: npm i -D flow-remove-types')
  }
}

export function babelAliases(cwd, file, fail) {
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

// Metro's asset extensions, and those metro.config.js adds (`file`'s, where
// given): read by its AST where oxc-parser is installed, else in the one form
// a regex reads.
export function assetExts(cwd, { locate, load }, fail, file = null) {
  const config = resolve(cwd, file ?? 'metro.config.js')
  if (!existsSync(config)) return file === null ? defaults.assetExts : fail(`no such Metro config: ${file}`)
  const source = readFileSync(config, 'utf8')
  const oxc = locate('oxc-parser')
  const listed = oxc === null ? scanMetroAssetExts(source) : metroAssetExts(load(oxc).parseSync(config, source, { sourceType: 'unambiguous' }).program)
  return listed === null ? fail(`reading the assetExts of ${file ?? 'metro.config.js'} needs oxc-parser: npm i -D oxc-parser`) : [...defaults.assetExts, ...listed]
}

// The project's babel.config.*: its path, or null.
export const babelConfigOf = (cwd) => BABEL_CONFIGS.map((name) => resolve(cwd, name)).find((file) => existsSync(file)) ?? null

// Metro's transform profiles, as `react-native bundle --unstable-transform-profile` takes them.
export const TRANSFORM_PROFILES = ['default', 'hermes-stable', 'hermes-canary']

// The project's babel.config.*, by the project's own @babel/core. -> a
// function of { platform, dev } to the options bundle() takes of Babel,
// with Metro's caller and Babel env, each target's workers its own.
// `sourceMaps` makes each file's output carry its map, inline; `profile`,
// each target's workers time the config's plugins, as its `profile`;
// `refresh`, react-refresh's Babel plugin, a dev target's workers run it
// over each file outside node_modules, for Fast Refresh; `transformProfile`,
// one of TRANSFORM_PROFILES, the caller's, for the config's plugins.
export function projectBabel(cwd, { fromProject, load }, fail, { sourceMaps = false, profile = false, refresh = null, transformProfile = 'default' } = {}) {
  const configFile = babelConfigOf(cwd)
  if (configFile === null) fail('--babel needs a babel.config.(js|cjs|mjs|json) in the project')
  const corePath = tryResolve(fromProject, '@babel/core')
  if (corePath === null) fail('--babel needs @babel/core installed in the project')
  const core = load(corePath)
  const targets = new Map()
  return ({ platform, dev }) => {
    const key = `${platform}\0${dev}`
    if (targets.has(key)) return targets.get(key)
    // As Metro's transformer names it: Platform inlined, as Metro's bundles
    // have it, for the transform profile, `react-native bundle`'s default
    // where not given (@react-native/babel-preset 0.87 on takes none for
    // Hermes V1's, which leaves classes).
    const caller = { name: 'metro', bundler: 'metro', platform, inlinePlatform: true, unstable_transformProfile: transformProfile }
    // The env Metro's transformer names, which plugins read for a release
    // build: react-native-worklets omits each worklet's location and source map.
    const envName = dev ? 'development' : process.env.BABEL_ENV || 'production'
    // A file with no import or export a script, as Metro's transformer has
    // it, which Babel takes for an ES module else: parsed as strict, its
    // helpers imported, then made CommonJS.
    const options = { cwd, root: cwd, configFile, caller, envName, sourceType: 'unambiguous' }
    const timed = profile ? newProfile() : null
    const target = {
      profile: timed,
      babel: babelWorkers(corePath, { ...options, compact: false, ...(sourceMaps && { sourceMaps: 'inline' }), ...(dev && refresh !== null && { refresh }) }, timed),
      babelPlugins: async (filename) => pluginsByKey((await core.loadOptionsAsync({ ...options, filename }))?.plugins ?? []),
    }
    targets.set(key, target)
    return target
  }
}

// Each plugin's options by its key; a key of more than one plugin (instances
// of one, each named) has { instances }: theirs, in order.
function pluginsByKey(plugins) {
  const byKey = Map.groupBy(plugins, (plugin) => plugin.key)
  return new Map([...byKey].map(([key, [plugin, ...more]]) => [key, more.length === 0 ? plugin.options : { instances: [plugin, ...more].map((each) => each.options) }]))
}

// A package of the project's, else of a dependency's: `through` names the
// packages to look in after, each a dependency of the one before. -> its
// path, or null.
export function locateThrough({ fromProject }, name, through = []) {
  let from = fromProject
  for (const step of [null, ...through]) {
    if (step !== null) {
      const path = tryResolve(from, step)
      if (path === null) return null
      from = createRequire(path)
    }
    const found = tryResolve(from, name)
    if (found !== null) return found
  }
  return null
}

// @react-native/metro-config's serializer.getPolyfills: the list
// @react-native/js-polyfills gives, of the project's copy, which its
// @react-native/metro-config depends on; none where it has none.
export function polyfills(project, fail) {
  const list = locateThrough(project, '@react-native/js-polyfills', ['@react-native/metro-config'])
  if (list === null) return []
  const getPolyfills = project.load(list)
  const paths = typeof getPolyfills === 'function' ? getPolyfills() : null
  return Array.isArray(paths) && paths.every((path) => typeof path === 'string') ? paths : fail(`${list} lists no polyfills`)
}
