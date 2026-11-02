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
//     config that sets it too is an error, so that what reads assetExts off
//     the project without running its Metro config (asset-exts.js) need
//     not read the config where this has them. It removes none: an
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

// metroOptions()'s `metro`, of what the config adds to its lists, after
// theirs (Metro's defaults: a list its Metro config sets too, an error),
// each once, and of its maxWorkers; `metro` itself where it has none of them.
export function extendedMetro(metro, config, fail) {
  const { assetExts = [], sourceExts = [], assetResolutions = [], maxWorkers } = config
  const set = (metro.ownLists ?? []).find((key) => config[key] !== undefined)
  if (set !== undefined) return fail(`${RN_CONFIG}: ${set} adds to Metro's defaults, and ${metro.file} sets resolver.${set} too: set it in one of them`)
  if (assetExts.length + sourceExts.length + assetResolutions.length === 0 && maxWorkers === undefined) return metro
  const added = (base, more) => [...base, ...more.filter((each, i) => !base.includes(each) && more.indexOf(each) === i)]
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
