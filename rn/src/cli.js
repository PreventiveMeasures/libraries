// What rn-bundle and rn-serve share: their peers, as the project installs
// them, else as installed beside rn/; Flow stripping; the project's Babel
// config, in worker threads; @react-native/js-polyfills's polyfills;
// --babel-aliases; --define. Its Metro config: metro-options.js.

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

import { createAliases } from './babel-aliases.js'
import { babelWorkers, newProfile } from './babel-worker.js'

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

// Flow types stripped by flow-remove-types; where Babel runs and it isn't
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

// A dependency of Metro's transformer (@react-native/metro-babel-transformer,
// the project's or its @react-native/metro-config's) as it requires it: the
// one it finds, else the project's.
function ofTransformer(project, name) {
  const transformer = locateThrough(project, '@react-native/metro-babel-transformer', ['@react-native/metro-config'])
  return (transformer === null ? null : tryResolve(createRequire(transformer), name)) ?? tryResolve(project.fromProject, name)
}

// The project's Babel config, as Metro's transformer takes it
// (@react-native/metro-babel-transformer's getBabelRC): a babel.config.*,
// which Babel finds itself; else the .babelrc or .babelrc.js it extends;
// else its @react-native/babel-preset. -> Babel's options of it, and what it
// is; null where the project has none of them.
export function babelConfigOf(cwd, project) {
  const configFile = BABEL_CONFIGS.map((name) => resolve(cwd, name)).find((file) => existsSync(file))
  if (configFile !== undefined) return { options: { configFile }, what: configFile }
  const babelrc = ['.babelrc', '.babelrc.js'].map((name) => resolve(cwd, name)).find((file) => existsSync(file))
  if (babelrc !== undefined) return { options: { configFile: false, extends: babelrc }, what: babelrc }
  const preset = ofTransformer(project, '@react-native/babel-preset')
  return preset === null ? null : { options: { configFile: false, presets: [[preset, { projectRoot: cwd }]] }, what: '@react-native/babel-preset', preset: true }
}

// Metro's transform profiles, as `react-native bundle --unstable-transform-profile` takes them.
export const TRANSFORM_PROFILES = ['default', 'hermes-stable', 'hermes-canary']

// The project's Babel config (babelConfigOf()), by the @babel/core Metro's
// transformer runs, else the project's: null where the project has none, or
// only the preset with no @babel/core. -> a function of { platform, dev } to the options bundle()
// takes of Babel, with Metro's caller and Babel env, each target's workers
// its own. `sourceMaps` makes each file's output carry its map, inline;
// `profile`, each target's workers time the config's plugins, as its
// `profile`; `refresh`, react-refresh's Babel plugin, a dev target's workers
// run it over each file outside node_modules, for Fast Refresh;
// `transformProfile`, one of TRANSFORM_PROFILES, the caller's, for the
// config's plugins; `babelRCLookup`, Metro's transformer.enableBabelRCLookup.
export function projectBabel(cwd, project, fail, { sourceMaps = false, profile = false, refresh = null, transformProfile = 'default', babelRCLookup = true } = {}) {
  const config = babelConfigOf(cwd, project)
  if (config === null) return null
  const corePath = ofTransformer(project, '@babel/core')
  if (corePath === null) return config.preset ? null : fail(`${config.what} needs @babel/core installed in the project`)
  const core = project.load(corePath)
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
    const options = { cwd, root: cwd, ...config.options, babelrc: babelRCLookup, caller, envName, sourceType: 'unambiguous' }
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
