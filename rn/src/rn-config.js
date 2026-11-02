// A project's rn.config.json, in its root (where rn-bundle and rn-serve run,
// and rn-cli, as Xcode and Gradle run it): the defaults of their flags, each
// flag over it. Its options:
//   metroConfig: whether the project's Metro config is loaded: true (the
//     default), the one Metro finds; false, none, as of a project with no
//     metro.config.js (Metro's defaults as @react-native/metro-config has
//     them), but a package's exports read (unstable_enablePackageExports),
//     whatever Metro's default (on from 0.82); a path, from the root, that
//     file. --metro-config over it.
//   assetExts, sourceExts, assetResolutions: what it adds to Metro's
//     defaults of the resolver's lists, after them: the extensions of assets
//     (["riv"]) and of code (["mjs"]), and the scales an asset's files are
//     of (["0.75"], or [0.75]). Each list it has is the project's: a Metro
//     config loaded (but of metroConfig false, none is) that sets it
//     otherwise is an error, so that what reads assetExts off the project
//     without running its Metro config (asset-exts.js) need not read the
//     config where this has them; one that sets it alike (Metro's defaults
//     and the same, as sets, but sourceExts in order, which an import tries
//     them in) is none. It removes none: an
//     extension it adds to one of assetExts and sourceExts the other has is
//     an error (Metro takes a file of it for an asset).
//   maxWorkers: --max-workers' default, over the Metro config's.
//   esm: --esm's default (false); --esm and --no-esm over it.
//   devTools: rn-serve's --dev-tools' default (false): React Native DevTools
//     opened for each app as it connects (devtools.js); --dev-tools and
//     --no-dev-tools over it. rn-bundle leaves it.
// An option it doesn't know, or of a value of another type, is an error.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { defaults } from './defaults.js'

export const RN_CONFIG = 'rn.config.json'

const boolean = [(value) => typeof value === 'boolean', 'true or false']
const listOf = (valid) => (value) => Array.isArray(value) && value.every(valid)
// An extension, as Metro lists them: without its dot, of no directory.
const extensions = [listOf((value) => typeof value === 'string' && /^[^./\\][^/\\]*$/u.test(value)), 'a list of extensions, each without its dot ("riv")']
// A scale, as Metro's assetResolutions has it, a string (`@0.75x`), or as a
// number has it.
const isScale = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0) || (typeof value === 'string' && /^\d+(?:\.\d+)?$/u.test(value) && Number(value) > 0)
const OPTIONS = {
  metroConfig: [(value) => typeof value === 'boolean' || (typeof value === 'string' && value !== ''), 'true, false or the path of a Metro config'],
  assetExts: extensions,
  sourceExts: extensions,
  assetResolutions: [listOf(isScale), 'a list of scales ("0.75", or 0.75)'],
  maxWorkers: [(value) => Number.isSafeInteger(value) && value > 0, 'a number of workers, 1 or more'],
  esm: boolean,
  devTools: boolean,
}

// The project's rn.config.json, as it has its options: {} where it has none.
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
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return fail(`${RN_CONFIG}: not an object of options`)
  for (const [key, value] of Object.entries(config)) {
    if (!Object.hasOwn(OPTIONS, key)) return fail(`${RN_CONFIG}: no such option ${key}: it has ${Object.keys(OPTIONS).join(', ')}`)
    const [valid, what] = OPTIONS[key]
    if (!valid(value)) return fail(`${RN_CONFIG}: ${key} is ${what}, not ${JSON.stringify(value)}`)
  }
  return config
}

// The Metro config metroOptions() loads (its `file`): --metro-config's
// (`flag`), else the config's metroConfig: null, the one Metro finds; false,
// none; else that file.
export const metroConfigOf = (flag, { metroConfig = true }) => flag ?? (metroConfig === true ? null : metroConfig)

const LISTS = ['assetExts', 'sourceExts', 'assetResolutions']
// `base`, and what of `more` it has none of, after it, each once.
const added = (base, more) => [...base, ...more.filter((each, i) => !base.includes(each) && more.indexOf(each) === i)]
// Whether two of a list build alike: sourceExts in order, which an import
// tries them in; the others as sets.
function alike(key, a, b) {
  const [ours, theirs] = [[...new Set(a.map(String))], [...new Set(b.map(String))]]
  return ours.length === theirs.length && (key === 'sourceExts' ? ours.every((each, i) => each === theirs[i]) : ours.every((each) => theirs.includes(each)))
}
const shown = (list) => (list.length > 5 ? `${list.slice(0, 5).join(', ')} and ${list.length - 5} more` : list.join(', '))

// The error of a list the config has that the Metro config loaded
// (`metro`'s) sets otherwise than Metro's defaults and it, or null: of
// how it differs from @react-native/metro-config's defaults and it.
function listConflict(metro, config) {
  for (const key of LISTS) {
    if (config[key] === undefined || metro.defaultLists == null) continue
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

// metroOptions()'s `metro`, of what the config adds to its lists, after
// theirs (Metro's defaults: a list its Metro config sets otherwise, an
// error), each once, and of its maxWorkers; `metro` itself where it has
// none of them.
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

// A boolean flag's value: the flag's (`flag`, undefined where not given),
// else the config's (`key` of it), else false. -> { on, by }: whether it
// is on, and what set it, for its errors: `--name`, or the config's key.
export function flagOf(flag, config, key, name) {
  if (flag !== undefined) return { on: flag, by: `--${name}` }
  return { on: config[key] ?? false, by: `${RN_CONFIG}'s ${key}` }
}
