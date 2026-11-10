// pod.config.json, beside the Podfile.lock: what a Podfile said that the lockfile does not record. Every option
// has a default, so that a project whose targets all take every pod needs none; an unknown or mistyped one is
// an error.

import { PodError, quote } from './error.js'

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isName = (value) => typeof value === 'string' && value !== ''
const names = [(value) => Array.isArray(value) && value.every(isName), 'a list of names']
const boolean = [(value) => typeof value === 'boolean', 'true or false']
const settings = [(value) => isObject(value) && Object.values(value).every((one) => typeof one === 'string'), 'an object of build settings, each a string']

const POD = { modularHeaders: boolean, inhibitWarnings: boolean, buildSettings: settings }
const TARGET = { pods: names }
const OPTIONS = {
  // The directory of the podspecs committed for pods, each <name>.podspec.json or <name>.podspec, from the
  // config's own.
  podspecs: [isName, 'the path of a directory'],
  // The app's project, where its directory has more than one.
  project: [isName, 'the path of an .xcodeproj'],
  // `platform :ios, '<target>'`.
  platform: [(value) => isObject(value) && Object.keys(value).length === 1 && value.ios !== undefined && /^\d+(?:\.\d+)*$/u.test(value.ios), 'the platform and its deployment target, { "ios": "16.4" }'],
  // `use_frameworks!`: "static", "dynamic", or false for static libraries.
  frameworks: [(value) => value === 'static' || value === 'dynamic' || value === false, '"static", "dynamic" or false'],
  // `use_modular_headers!` and `inhibit_all_warnings!`.
  modularHeaders: boolean,
  inhibitWarnings: boolean,
  // What `pod '<name>', ...` said of one pod, and the build settings a post_install hook set on its target.
  pods: [(value) => isObject(value) && Object.values(value).every(isObject), 'an object of pods by name', POD],
  // The pods of each of the app's targets, where one takes fewer than all.
  targets: [(value) => isObject(value) && Object.values(value).every(isObject), "an object of the app's targets by name", TARGET],
  // Build settings a post_install hook set on every pod's target.
  buildSettings: settings,
  // The pods whose prepare_command is run, with bash, as CocoaPods runs it.
  prepareCommands: names,
}

function check(options, values, prefix) {
  for (const [key, value] of Object.entries(values)) {
    if (!Object.hasOwn(options, key)) throw new PodError(`${prefix}${key} is not an option`, 'pod.config.json')
    const [valid, description, nested] = options[key]
    if (!valid(value)) throw new PodError(`${prefix}${key} must be ${description}`, 'pod.config.json')
    if (nested !== undefined) for (const [name, inner] of Object.entries(value)) check(nested, inner, `${prefix}${key}[${quote(name)}].`)
  }
}

// The config of `text`, or of none where it is undefined.
export function readConfig(text) {
  let given = {}
  if (text !== undefined) {
    try {
      given = JSON.parse(text)
    } catch (error) {
      throw new PodError('is not JSON', 'pod.config.json', { cause: error })
    }
    if (!isObject(given)) throw new PodError('is not an object of options', 'pod.config.json')
  }
  check(OPTIONS, given, '')
  return {
    podspecs: given.podspecs ?? 'Podspecs',
    project: given.project,
    platform: { name: 'ios', target: given.platform?.ios },
    frameworks: given.frameworks ?? false,
    modularHeaders: given.modularHeaders ?? false,
    inhibitWarnings: given.inhibitWarnings ?? false,
    pods: given.pods ?? {},
    targets: given.targets ?? {},
    buildSettings: given.buildSettings ?? {},
    prepareCommands: given.prepareCommands ?? [],
  }
}
