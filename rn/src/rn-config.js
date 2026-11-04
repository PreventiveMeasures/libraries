// rn.config.json, in the project root: defaults for the flags of rn-bundle, rn-serve and rn-cli.
// Unknown or mistyped options are errors. Its lists add to Metro's defaults, and a Metro config that
// sets one otherwise is an error, so asset-exts.js needn't read that config. `babel` switches Babel
// plugins (babel-switches.js). `inlineRequires` sets Metro's inline requires (each module run where
// first used); a Metro config's own getTransformOptions that disagrees is an error. `esm` has esbuild
// link ES modules, each run as imported, so it can't go with inline requires. `development` and
// `production` set babel, esm and inlineRequires for dev and release builds: an option is set there
// or at the top level, never both.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { defaults } from './defaults.js'

const RN_CONFIG = 'rn.config.json'

const boolean = [(value) => typeof value === 'boolean', 'true or false']
const listOf = (valid) => (value) => Array.isArray(value) && value.every(valid)
// As Metro lists extensions: no leading dot, no directory.
const extensions = [listOf((value) => typeof value === 'string' && /^[^./\\][^/\\]*$/u.test(value)), 'a list of extensions, each without its dot ("riv")']
// A scale as Metro's assetResolutions has it (the 0.75 of `@0.75x`), as a string or a number.
const isScale = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0) || (typeof value === 'string' && /^\d+(?:\.\d+)?$/u.test(value) && Number(value) > 0)
const nonEmpty = (what) => [(value) => typeof value === 'string' && value !== '', what]
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
// Babel plugins by name, each on or off, in order.
const switches = [(value) => isObject(value) && Object.entries(value).every(([name, on]) => name !== '' && typeof on === 'boolean'), 'an object of Babel plugins, each true (run it on every file) or false (never)']
// What `development` and `production` may set.
const MODE = { babel: switches, esm: boolean, inlineRequires: boolean }
// Each option's [validator, description]; a section is an object of its own options.
const OPTIONS = {
  metroConfig: [(value) => typeof value === 'boolean' || (typeof value === 'string' && value !== ''), 'true, false or the path of a Metro config'],
  assetExts: extensions,
  sourceExts: extensions,
  assetResolutions: [listOf(isScale), 'a list of scales ("0.75", or 0.75)'],
  maxWorkers: [(value) => Number.isSafeInteger(value) && value > 0, 'a number of workers, 1 or more'],
  esm: boolean,
  inlineRequires: boolean,
  babel: switches,
  devtools: boolean,
  port: [(value) => Number.isSafeInteger(value) && value >= 0 && value <= 65_535, 'a port, 0 to 65535'],
  launch: [(value) => value === false || value === 'ios' || value === 'android', '"ios", "android", or false'],
  ios: {
    simulator: nonEmpty("a simulator's name, or its UDID"),
    binaryPath: nonEmpty("the path of a simulator's build of the app, an .app"),
  },
  android: {
    device: nonEmpty("a device's serial (adb devices), or an emulator's AVD name"),
    variant: nonEmpty('a build variant\'s name, as debuggableVariants has it ("debug", "freeDebug")'),
    binaryPath: nonEmpty('the path of a build of the app, an .apk'),
  },
  development: MODE,
  production: MODE,
}
const MODES = ['development', 'production']

// The first error of `values` as `options`, each named after `prefix`; or null.
const errorIn = (options, values, prefix) => Object.entries(values).map(([key, value]) => errorOf(options, key, value, `${prefix}${key}`)).find((error) => error !== null) ?? null

function errorOf(options, key, value, name) {
  if (!Object.hasOwn(options, key)) return `no such option ${name}: it has ${Object.keys(options).join(', ')}`
  const option = options[key]
  if (Array.isArray(option)) return option[0](value) ? null : `${name} is ${option[1]}, not ${JSON.stringify(value)}`
  if (!isObject(value)) return `${name} is an object of options (${Object.keys(option).join(', ')}), not ${JSON.stringify(value)}`
  return errorIn(option, value, `${name}.`)
}

// The project's rn.config.json, or {}.
export function readRnConfig(projectRoot, fail) {
  let config
  try {
    config = JSON.parse(readFileSync(resolve(projectRoot, RN_CONFIG), 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    return fail(`${RN_CONFIG}: ${error instanceof SyntaxError ? 'not JSON: ' : ''}${error.message}`)
  }
  if (!isObject(config)) return fail(`${RN_CONFIG}: not an object of options`)
  const error = errorIn(OPTIONS, config, '')
  if (error !== null) return fail(`${RN_CONFIG}: ${error}`)
  for (const key of Object.keys(MODE)) {
    const modes = MODES.filter((mode) => config[mode]?.[key] !== undefined)
    if (config[key] !== undefined && modes.length > 0) return fail(`${RN_CONFIG}: ${key} is set at the top level and in ${modes.join(' and ')}: set it at the top level, for both, or in development and production`)
  }
  return config
}

// The config of a dev build (or a release build): its section's options, else the top level's.
export function inMode(config, dev) {
  const { development, production, ...rest } = config
  return { ...rest, ...(dev ? development : production) }
}

// The Babel plugins a dev build (or a release build) switches, as [[name, on]] in order.
export const babelSwitchesOf = (config, dev) => Object.entries(inMode(config, dev).babel ?? {})

// metroOptions()'s `file`: --metro-config, else metroConfig (true is null: the one Metro finds).
export const metroConfigOf = (flag, { metroConfig = true }) => flag ?? (metroConfig === true ? null : metroConfig)

const LISTS = ['assetExts', 'sourceExts', 'assetResolutions']
// metroOptions()'s list, Metro's default where it has none (no config loaded).
const listIn = (metro, key) => (key === 'assetExts' ? metro.assetExts : metro.resolver[key]) ?? defaults[key]
// `base`, then each of `more` it lacks, once.
export const added = (base, more) => [...base, ...new Set(more).difference(new Set(base))]
// Whether two lists build alike: sourceExts in order, as imports try them so; the rest as sets.
function alike(key, a, b) {
  const [ours, theirs] = [a, b].map((list) => new Set(list.map(String)))
  return key === 'sourceExts' ? isDeepStrictEqual([...ours], [...theirs]) : ours.symmetricDifference(theirs).size === 0
}
const shown = (list) => (list.length > 5 ? `${list.slice(0, 5).join(', ')} and ${list.length - 5} more` : list.join(', '))

// The error if the loaded Metro config sets the list `key` unlike any default, with or without
// rn.config.json's `additions`; or null.
function conflictOf(metro, key, additions) {
  const current = listIn(metro, key).map(String)
  if (metro.defaultLists.some((base) => alike(key, current, base[key]) || alike(key, current, added(base[key], additions)))) return null
  const expected = added(metro.defaultLists.at(-1)[key], additions)
  const extra = current.filter((each) => !expected.includes(each))
  const missing = expected.filter((each) => !current.includes(each))
  const how = [extra.length > 0 && `has ${shown(extra)}`, missing.length > 0 && `lacks ${shown(missing)}`].filter(Boolean).join(' and ') || 'has them in another order'
  return `${RN_CONFIG}: ${key} is Metro's defaults${additions.length === 0 ? '' : ` and ${shown(additions)}`}, and ${metro.file}'s resolver.${key} ${how}: set it in one of them, or alike in both`
}

// metroOptions()'s `metro` with the config's list additions and maxWorkers; `metro` itself if it has none.
export function extendedMetro(metro, config, fail) {
  const [assetExts, sourceExts, assetResolutions] = LISTS.map((key) => {
    const additions = (config[key] ?? []).map(String)
    // Without defaultLists, no Metro config was loaded to compare with.
    const conflict = config[key] === undefined || !metro.defaultLists ? null : conflictOf(metro, key, additions)
    return conflict === null ? added(listIn(metro, key), additions) : fail(conflict)
  })
  if (LISTS.every((key) => !config[key]?.length) && config.maxWorkers === undefined) return metro
  for (const [key, other, otherKey] of [['assetExts', sourceExts, 'sourceExts'], ['sourceExts', assetExts, 'assetExts']]) {
    const both = config[key]?.find((ext) => other.includes(ext))
    if (both !== undefined) return fail(`${RN_CONFIG}: ${key} adds ${both}, which ${otherKey} has: Metro takes a file of it for an asset, and ${RN_CONFIG} removes none`)
  }
  return { ...metro, assetExts, resolver: { ...metro.resolver, sourceExts, assetResolutions }, maxWorkers: config.maxWorkers ?? metro.maxWorkers }
}

// A boolean option: --flagName if given, else the config's `name` (in the section for `dev`, if given
// and set there), else `unset`. `by` names its source for errors.
export function flagOf(flag, config, name, dev, { flagName = name, unset = false } = {}) {
  if (flag !== undefined) return { on: flag, by: `--${flag ? '' : 'no-'}${flagName}`, flag: true }
  const mode = dev ? 'development' : 'production'
  if (dev !== undefined && config[mode]?.[name] !== undefined) return { on: config[mode][name], by: `${RN_CONFIG}'s ${mode}.${name}`, flag: false }
  return { on: config[name] ?? unset, by: `${RN_CONFIG}'s ${name}`, flag: false }
}

// Its `on` is null where neither the flag nor the config sets them.
export const inlineRequiresOf = (flag, config, dev) => flagOf(flag, config, 'inlineRequires', dev, { flagName: 'inline-requires', unset: null })

// metroOptions()'s `metro` with inline requires as `wanted(dev)` (inlineRequiresOf()'s) sets them,
// else as the Metro config does. Its transformRefusal() refuses them without metro-transform-plugins,
// against the Metro config's own getTransformOptions, or with `esm(dev)` (flagOf()'s) on.
export function withInlineRequires(metro, wanted, esm = () => ({ on: false })) {
  const inlined = (entryPath, target) => {
    const { on } = wanted(target.dev)
    if (on === null) return metro.inlineRequires(entryPath, target)
    return on ? metro.inlining(entryPath, target) : Promise.resolve(null)
  }
  return {
    ...metro,
    inlineRequires: inlined,
    transformRefusal: async (entryPath, target) => {
      const refusal = await metro.transformRefusal(entryPath, target)
      if (refusal !== null) return refusal
      const { on, by, flag } = wanted(target.dev)
      if (on && (await metro.inlining(entryPath, target)) === null) return `${by} inlines requires with metro-transform-plugins, which the project lacks: npm i -D metro-transform-plugins`
      if (on !== null && !flag && metro.ownTransformOptions) {
        const given = (await metro.inlineRequires(entryPath, target)) !== null
        if (given !== on) return `${by} is ${on}, and ${metro.file}'s transformer.getTransformOptions gives inlineRequires ${given}: set it in one of them, or alike in both`
      }
      const linking = esm(target.dev)
      if (!linking.on || (await inlined(entryPath, target)) === null) return null
      const source = on === null ? (metro.file === null ? "React Native's defaults" : `${metro.file}'s transformer.getTransformOptions`) : by
      return `${linking.by} links ES modules, each run as it is imported, and ${source} inlines requires, each module run where first used: turn them off for it (--no-inline-requires, or rn.config.json's inlineRequires false), or leave esm off, the imports checked all the same`
    },
  }
}
