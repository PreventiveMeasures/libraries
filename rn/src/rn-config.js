// A project's rn.config.json, in the root where rn-bundle, rn-serve and rn-cli run: defaults for
// their flags, which override it. Its lists add to Metro's defaults; a Metro config that sets one
// differently is an error, so asset-exts.js can skip reading it. Unknown or mistyped options are errors.

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

// The first error of the options in `values`, of those in `options`, each named after `prefix`; or null.
const errorIn = (options, values, prefix) => Object.entries(values).map(([key, value]) => errorOf(options, key, value, `${prefix}${key}`)).find((error) => error !== null) ?? null

// The error of `value` as `key` of `options`, shown as `name`; or null.
function errorOf(options, key, value, name) {
  if (!Object.hasOwn(options, key)) return `no such option ${name}: it has ${Object.keys(options).join(', ')}`
  const option = options[key]
  if (Array.isArray(option)) return option[0](value) ? null : `${name} is ${option[1]}, not ${JSON.stringify(value)}`
  if (!isObject(value)) return `${name} is an object of options (${Object.keys(option).join(', ')}), not ${JSON.stringify(value)}`
  return errorIn(option, value, `${name}.`)
}

// The project's rn.config.json: {} if it has none.
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
  return error === null ? config : fail(`${RN_CONFIG}: ${error}`)
}

// metroOptions()'s `file`: --metro-config, else metroConfig (true is null: the one Metro finds).
export const metroConfigOf = (flag, { metroConfig = true }) => flag ?? (metroConfig === true ? null : metroConfig)

const LISTS = ['assetExts', 'sourceExts', 'assetResolutions']
// metroOptions()'s list, Metro's default where it has none (no config loaded).
const listIn = (metro, key) => (key === 'assetExts' ? metro.assetExts : metro.resolver[key]) ?? defaults[key]
// `base`, then each of `more` it lacks, once.
export const added = (base, more) => [...base, ...new Set(more).difference(new Set(base))]
// Whether two lists build alike: sourceExts in order, as imports try them in order; the rest as sets.
function alike(key, a, b) {
  const [ours, theirs] = [a, b].map((list) => new Set(list.map(String)))
  return key === 'sourceExts' ? isDeepStrictEqual([...ours], [...theirs]) : ours.symmetricDifference(theirs).size === 0
}
const shown = (list) => (list.length > 5 ? `${list.slice(0, 5).join(', ')} and ${list.length - 5} more` : list.join(', '))

// The error of a list rn.config.json adds `additions` to that the loaded Metro config (`metro`) sets
// other than a default does, with or without them; or null.
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

// A boolean flag: --name if given, else the config's `name`, else false; `by` names its source for errors.
export function flagOf(flag, config, name) {
  if (flag !== undefined) return { on: flag, by: `--${name}` }
  return { on: config[name] ?? false, by: `${RN_CONFIG}'s ${name}` }
}
