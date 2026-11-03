// What rn-bundle and rn-serve share: peer lookup (the project's, else rn/'s), Flow stripping,
// the project's Babel config in worker threads, --babel-aliases and --define.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

import { createAliases } from './babel-aliases.js'
import { FORCED, switchesOf } from './babel-switches.js'
import { babelWorkers, newProfile } from './babel-worker.js'
import { babelrcFinder } from './babelrc.js'

export const failer = (name) => (message) => {
  process.stderr.write(`${name}: ${message}\n`)
  process.exit(1)
}

export const tryResolve = (from, name) => {
  try {
    return from.resolve(name)
  } catch {
    return null
  }
}

export function peers(cwd, fail) {
  const fromProject = createRequire(resolve(cwd, 'package.json'))
  const fromHere = createRequire(import.meta.url)
  const locate = (name) => tryResolve(fromProject, name) ?? tryResolve(fromHere, name)
  const peer = (name, why) => {
    const path = locate(name)
    return path === null ? fail(`${why} needs ${name}: npm i -D ${name}`) : fromHere(path)
  }
  return { fromProject, locate, load: fromHere, peer }
}

// __DEV__ and process.env.NODE_ENV as Metro's prelude sets them, unless a K=V pair overrides them.
export function defines(dev, pairs, fail) {
  const define = { __DEV__: String(dev), 'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production') }
  for (const pair of pairs) {
    const at = pair.indexOf('=')
    if (at < 1) fail(`--define takes K=V, not ${pair}`)
    define[pair.slice(0, at)] = pair.slice(at + 1)
  }
  return define
}

// Without flow-remove-types, Babel's config strips Flow where Babel runs, as with Metro.
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

// A package as @react-native/metro-babel-transformer (the project's or its
// @react-native/metro-config's) requires it, else the project's.
function ofTransformer(project, name) {
  const transformer = locateThrough(project, '@react-native/metro-babel-transformer', ['@react-native/metro-config'])
  return (transformer === null ? null : tryResolve(createRequire(transformer), name)) ?? tryResolve(project.fromProject, name)
}

const firstIn = (cwd, names) => names.map((name) => resolve(cwd, name)).find((file) => existsSync(file))

// The project's Babel config as @react-native/metro-babel-transformer's getBabelRC finds it:
// a babel.config.*, else a .babelrc(.js), else @react-native/babel-preset; null if none.
function babelConfigOf(cwd, project) {
  const configFile = firstIn(cwd, ['babel.config.js', 'babel.config.cjs', 'babel.config.mjs', 'babel.config.json'])
  if (configFile !== undefined) return { options: { configFile }, what: configFile }
  const babelrc = firstIn(cwd, ['.babelrc', '.babelrc.js'])
  if (babelrc !== undefined) return { options: { configFile: false, extends: babelrc }, what: babelrc }
  const preset = ofTransformer(project, '@react-native/babel-preset')
  return preset === null ? null : { options: { configFile: false }, what: '@react-native/babel-preset', preset }
}

// The project's Babel config, run by the @babel/core Metro's transformer uses, as a function of
// { platform, dev, inlineRequires } to bundle()'s Babel options, one set of workers per target.
// Null without a config, or with only the preset and no @babel/core. ownPlugins(dev): plugins run on
// the project's own files, after the config's ([path, options]; rn-serve's Fast Refresh); `fingerprinter`,
// the module the workers make their fingerprint with (babel-worker.js), for a cache of their output.
export function projectBabel(cwd, project, fail, { sourceMaps = false, profile = false, ownPlugins = () => [], transformProfile = 'default', babelRCLookup = true, babelRuntime = true, keepPlugins = false, maxWorkers = null, fingerprinter = null, oneBuild = false, warm = false, switches = () => [] } = {}) {
  const config = babelConfigOf(cwd, project)
  if (config === null) return null
  const corePath = ofTransformer(project, '@babel/core')
  if (corePath === null) return config.preset ? null : fail(`${config.what} needs @babel/core installed in the project`)
  // Loaded here only when first needed, after the workers load their own.
  let core = null
  const loadCore = () => (core ??= project.load(corePath))
  // In one build files don't change, so .babelrc lookups that find nothing can be skipped.
  const finds = oneBuild && babelRCLookup ? babelrcFinder() : null
  const targetOf = (platform, dev, inlineRequires) => {
    // Metro's caller. The profile is always named: @react-native/babel-preset 0.87+ takes none
    // as Hermes V1's, which leaves classes.
    const caller = { name: 'metro', bundler: 'metro', platform, inlinePlatform: true, unstable_transformProfile: transformProfile }
    // Plugins read it for release builds: react-native-worklets omits worklets' locations and maps.
    const envName = dev ? 'development' : process.env.BABEL_ENV || 'production'
    // What Metro's transformer gives the preset: 0.78's reads the profile from these, not the caller.
    const presetOptions = { projectRoot: cwd, dev, platform, inlinePlatform: true, unstable_transformProfile: transformProfile, customTransformOptions: {}, disableImportExportTransform: false, enableBabelRuntime: babelRuntime }
    // sourceType unambiguous: a file without import or export is a script, as in Metro's transformer.
    const options = { cwd, root: cwd, ...config.options, ...(config.preset !== undefined && { presets: [[config.preset, presetOptions]] }), babelrc: babelRCLookup, caller, envName, sourceType: 'unambiguous' }
    const timed = profile ? newProfile() : null
    // Inline maps for esbuild, with no sourceRoot, which Metro ignores and esbuild would prefix
    // to every source. Without maps, Babel needn't read input maps.
    const maps = sourceMaps ? { sourceMaps: 'inline', sourceRoot: '' } : { inputSourceMap: false }
    // rn.config.json's Babel plugins switched on and off for the build (babel-switches.js).
    const switched = switches(dev)
    const workerOptions = { ...options, compact: false, ...maps, ownPlugins: ownPlugins(dev), keepPlugins, inlineRequires, switches: switched }
    const babel = babelWorkers(corePath, { ...workerOptions, fingerprinter, oneBuild }, timed, maxWorkers, { warm })
    let switchedKeys = null
    return {
      profile: timed,
      babel,
      // The config's plugins, but those switched off, and those switched on, FORCED; then Metro's
      // inline-requires, which the workers run after them.
      babelPlugins: async (filename) => {
        const plugins = pluginsByKey((await loadCore().loadOptionsAsync({ ...options, filename, ...(finds?.(filename) === false && { babelrc: false }) }))?.plugins ?? [])
        if (switched.length > 0) {
          switchedKeys ??= switchesOf(loadCore(), switched, { cwd, root: cwd, caller, envName }, { ...options, filename: join(cwd, 'index.js') })
          for (const key of switchedKeys.off) plugins.delete(key)
          for (const { key, plugin } of switchedKeys.added) {
            if (plugins.has(key) || plugin !== null) plugins.set(key, { ...(plugins.get(key) ?? plugin.options), [FORCED]: true })
          }
        }
        return inlineRequires === null || inlineRequires.blockList.includes(filename) ? plugins : plugins.set('inline-requires', inlineRequires.options)
      },
      // For a cache of the workers' output (serve/load-cache.js): their options and fingerprint, and the
      // config's core and options, of which it keys each file.
      ...(fingerprinter !== null && { workerOptions, fingerprint: babel.fingerprint, core: loadCore, configOptions: options }),
    }
  }
  // A target per inlineRequires too, as Metro caches a file's transform per transform options.
  const targets = new Map()
  return ({ platform, dev, inlineRequires = null }) => {
    const key = JSON.stringify([platform, dev, inlineRequires])
    if (!targets.has(key)) targets.set(key, targetOf(platform, dev, inlineRequires))
    return targets.get(key)
  }
}

// Whether to warm Babel's workers up front: react-native's Libraries has dozens of
// directories, a test fixture's stub one or two.
export function bigBuild({ locate }) {
  const manifest = locate('react-native/package.json')
  if (manifest === null) return false
  try {
    return readdirSync(join(dirname(manifest), 'Libraries')).length >= 20
  } catch {
    return false
  }
}

// Each plugin's options by key; a key shared by several named instances maps to { instances }.
function pluginsByKey(plugins) {
  return new Map([...Map.groupBy(plugins, (plugin) => plugin.key)].map(([key, group]) => [key, group.length === 1 ? group[0].options : { instances: group.map((each) => each.options) }]))
}

// A package's path from the project, else from each of `through` in turn, each a
// dependency of the one before; null if none has it.
export function locateThrough({ fromProject }, name, through = []) {
  let from = fromProject
  for (const step of through) {
    const found = tryResolve(from, name)
    if (found !== null) return found
    const path = tryResolve(from, step)
    if (path === null) return null
    from = createRequire(path)
  }
  return tryResolve(from, name)
}
