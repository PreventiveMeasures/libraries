// A project's rn.config.json, in the root where rn-bundle, rn-serve and rn-cli run: defaults for
// their flags, which override it. Its lists add to Metro's defaults; a Metro config that sets one
// differently is an error, so asset-exts.js can skip reading it. Unknown or mistyped options are errors.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { defaults } from './defaults.js'

const RN_CONFIG = 'rn.config.json'

const boolean = [(value) => typeof value === 'boolean', 'true or false']
const listOf = (valid) => (value) => Array.isArray(value) && value.every(valid)
// As Metro lists extensions: no leading dot, no directory.
const extensions = [listOf((value) => typeof value === 'string' && /^[^./\\][^/\\]*$/u.test(value)), 'a list of extensions, each without its dot ("riv")']
// A scale as Metro's assetResolutions has it (the 0.75 of `@0.75x`), as a string or a number.
const isScale = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0) || (typeof value === 'string' && /^\d+(?:\.\d+)?$/u.test(value) && Number(value) > 0)
const nonEmpty = (what) => [(value) => typeof value === 'string' && value !== '', what]
// Each option's [validator, description]; a section is an object of its own options.
const OPTIONS = {
  metroConfig: [(value) => typeof value === 'boolean' || (typeof value === 'string' && value !== ''), 'true, false or the path of a Metro config'],
  assetExts: extensions,
  sourceExts: extensions,
  assetResolutions: [listOf(isScale), 'a list of scales ("0.75", or 0.75)'],
  maxWorkers: [(value) => Number.isSafeInteger(value) && value > 0, 'a number of workers, 1 or more'],
  esm: boolean,
  devtools: boolean,
  port: [(value) => Number.isSafeInteger(value) && value >= 0 && value <= 65_535, 'a port, 0 to 65535'],
  launch: [(value) => value === false || value === 'ios', '"ios", or false'],
  ios: {
    simulator: nonEmpty("a simulator's name, or its UDID"),
    binaryPath: nonEmpty("the path of a simulator's build of the app, an .app"),
  },
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

// The error of `value` for `key` of `options`, shown as `name`, or null.
function errorOf(options, key, value, name) {
  if (!Object.hasOwn(options, key)) return `no such option ${name}: it has ${Object.keys(options).join(', ')}`
  const option = options[key]
  if (Array.isArray(option)) return option[0](value) ? null : `${name} is ${option[1]}, not ${JSON.stringify(value)}`
  if (!isObject(value)) return `${name} is an object of options (${Object.keys(option).join(', ')}), not ${JSON.stringify(value)}`
  return Object.entries(value).map(([inner, each]) => errorOf(option, inner, each, `${name}.${inner}`)).find((error) => error !== null) ?? null
}

// The project's rn.config.json: {} if it has none.
export function readRnConfig(projectRoot, fail) {
  let text
  try {
    text = readFileSync(resolve(projectRoot, RN_CONFIG), 'utf8')
  } catch (error) {
    return error.code === 'ENOENT' ? {} : fail(`${RN_CONFIG}: ${error.message}`)
  }
  let config
  try {
    config = JSON.parse(text)
  } catch (error) {
    return fail(`${RN_CONFIG}: not JSON: ${error.message}`)
  }
  if (!isObject(config)) return fail(`${RN_CONFIG}: not an object of options`)
  for (const [key, value] of Object.entries(config)) {
    const error = errorOf(OPTIONS, key, value, key)
    if (error !== null) return fail(`${RN_CONFIG}: ${error}`)
  }
  return config
}

// metroOptions()'s `file`: --metro-config, else metroConfig (true is null: the one Metro finds).
export const metroConfigOf = (flag, { metroConfig = true }) => flag ?? (metroConfig === true ? null : metroConfig)

const LISTS = ['assetExts', 'sourceExts', 'assetResolutions']
// `base`, then each of `more` it lacks, once.
export const added = (base, more) => [...base, ...more.filter((each, i) => !base.includes(each) && more.indexOf(each) === i)]
const unique = (list) => [...new Set(list.map(String))]
// Whether two lists build alike: sourceExts in order, as imports try them in order; the rest as sets.
function alike(key, a, b) {
  const [ours, theirs] = [unique(a), unique(b)]
  return ours.length === theirs.length && (key === 'sourceExts' ? ours.every((each, i) => each === theirs[i]) : ours.every((each) => theirs.includes(each)))
}
const shown = (list) => (list.length > 5 ? `${list.slice(0, 5).join(', ')} and ${list.length - 5} more` : list.join(', '))

// The error of a list in `config` that the loaded Metro config sets other than a default
// does, with or without the config's additions; or null.
function listConflict(metro, config) {
  if (metro.defaultLists == null) return null
  for (const key of LISTS) {
    if (config[key] === undefined) continue
    const additions = config[key].map(String)
    const current = (key === 'assetExts' ? metro.assetExts : metro.resolver[key]).map(String)
    if (metro.defaultLists.some((base) => alike(key, current, base[key]) || alike(key, current, added(base[key], additions)))) continue
    const expected = added(metro.defaultLists.at(-1)[key], additions)
    const extra = current.filter((each) => !expected.includes(each))
    const missing = expected.filter((each) => !current.includes(each))
    const how = [extra.length > 0 && `has ${shown(extra)}`, missing.length > 0 && `lacks ${shown(missing)}`].filter(Boolean).join(' and ') || 'has them in another order'
    return `${RN_CONFIG}: ${key} is Metro's defaults${additions.length === 0 ? '' : ` and ${shown(additions)}`}, and ${metro.file}'s resolver.${key} ${how}: set it in one of them, or alike in both`
  }
  return null
}

// metroOptions()'s `metro` with the config's list additions and maxWorkers; `metro` itself if it has none.
export function extendedMetro(metro, config, fail) {
  const { assetExts = [], sourceExts = [], assetResolutions = [], maxWorkers } = config
  const conflict = listConflict(metro, config)
  if (conflict !== null) return fail(conflict)
  if (assetExts.length + sourceExts.length + assetResolutions.length === 0 && maxWorkers === undefined) return metro
  const assets = added(metro.assetExts, assetExts)
  const sources = added(metro.resolver.sourceExts ?? defaults.sourceExts, sourceExts)
  for (const [key, list, other, otherKey] of [['assetExts', assetExts, sources, 'sourceExts'], ['sourceExts', sourceExts, assets, 'assetExts']]) {
    const both = list.find((ext) => other.includes(ext))
    if (both !== undefined) return fail(`${RN_CONFIG}: ${key} adds ${both}, which ${otherKey} has: Metro takes a file of it for an asset, and ${RN_CONFIG} removes none`)
  }
  return {
    ...metro,
    assetExts: assets,
    resolver: { ...metro.resolver, sourceExts: sources, assetResolutions: added(metro.resolver.assetResolutions ?? defaults.assetResolutions, assetResolutions.map(String)) },
    maxWorkers: maxWorkers ?? metro.maxWorkers,
  }
}

// A boolean flag: --name if given, else the config's `key`, else false; `by` names its source for errors.
export function flagOf(flag, config, key, name) {
  if (flag !== undefined) return { on: flag, by: `--${name}` }
  return { on: config[key] ?? false, by: `${RN_CONFIG}'s ${key}` }
}
