// A project's rn.config.json, in its root (where rn-bundle and rn-serve run,
// and rn-cli, as Xcode and Gradle run it): the defaults of their flags, each
// flag over it. Its options:
//   metroConfig: whether the project's Metro config is loaded: true (the
//     default), the one Metro finds; false, none, as of a project with no
//     metro.config.js (Metro's defaults as @react-native/metro-config has
//     them); a path, from the root, that file. --metro-config over it.
//   esm: --esm's default (false); --esm and --no-esm over it.
//   devTools: rn-serve's --dev-tools' default (false): React Native DevTools
//     opened for each app as it connects (devtools.js); --dev-tools and
//     --no-dev-tools over it. rn-bundle leaves it.
// An option it doesn't know, or of a value of another type, is an error.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const RN_CONFIG = 'rn.config.json'

const boolean = [(value) => typeof value === 'boolean', 'true or false']
const OPTIONS = {
  metroConfig: [(value) => typeof value === 'boolean' || (typeof value === 'string' && value !== ''), 'true, false or the path of a Metro config'],
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

// A boolean flag's value: the flag's (`flag`, undefined where not given),
// else the config's (`key` of it), else false. -> { on, by }: whether it
// is on, and what set it, for its errors: `--name`, or the config's key.
export function flagOf(flag, config, key, name) {
  if (flag !== undefined) return { on: flag, by: `--${name}` }
  return { on: config[key] ?? false, by: `${RN_CONFIG}'s ${key}` }
}
