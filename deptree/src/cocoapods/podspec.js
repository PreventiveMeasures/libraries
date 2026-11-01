// A podspec as CocoaPods reads one from trunk's JSON, Specification.from_hash,
// and what its Consumer makes of the attributes that say which of a pod's
// files are used, on a platform: each spec's own value, the platform's laid
// over it, and for an inherited attribute the parent's under both. What
// CocoaPods would fail on, and what one release reads otherwise than
// another, is refused.

import { DeptreeError, quote } from '../error.js'
import { UNSAFE } from '../mount.js'

// The platforms CocoaPods takes, by the names a podspec gives them, and
// all of them, in its order, for a spec that names none; Platform takes
// another case of a name, or `xros`, from 1.16 alone.
const PLATFORM_NAMES = { __proto__: null, osx: 'osx', macos: 'osx', ios: 'ios', tvos: 'tvos', visionos: 'visionos', watchos: 'watchos' }
const PLATFORMS = ['osx', 'ios', 'tvos', 'visionos', 'watchos']
// What Version.create takes of a deployment target, as trunk has them.
const DEPLOYMENT_TARGET = /^\d+(?:\.\d+)*$/u

// The keys from_hash takes the specs inside one from, each a list.
const CHILDREN = ['subspecs', 'testspecs', 'appspecs']

// The file patterns, each a list, none inherited.
export const LISTS = ['source_files', 'exclude_files', 'resources', 'preserve_paths', 'vendored_frameworks', 'vendored_libraries']
// One path each, inherited: a subspec takes its parent's where it has none.
const PATHS = ['prefix_header_file', 'module_map']

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isText = (value) => typeof value === 'string' && value.isWellFormed() && !UNSAFE.test(value)

function readJson(bytes, where) {
  let json
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes))
  } catch {
    throw new DeptreeError('its podspec is not JSON, as trunk serves one', where)
  }
  if (!isObject(json)) throw new DeptreeError('its podspec is not a JSON object', where)
  return json
}

// A spec and those inside it, each with its name in full, `Root/Sub`, and
// its parent. `at` is where it is in the podspec, for a refusal.
function specOf(hash, parent, at, where) {
  const name = hash.name
  if (!isText(name) || name === '' || name.includes('/')) throw new DeptreeError(`${at}name is not a spec's name`, where)
  const spec = { name: parent === undefined ? name : `${parent.name}/${name}`, attributes: hash, parent, children: [], at }
  for (const key of CHILDREN) {
    const list = hash[key]
    if (list === undefined || list === null) continue
    if (!Array.isArray(list)) throw new DeptreeError(`${at}${key} is not a list of specs`, where)
    list.forEach((child, index) => {
      if (!isObject(child)) throw new DeptreeError(`${at}${key}[${index}] is not a spec`, where)
      spec.children.push(specOf(child, spec, `${at}${key}[${index}].`, where))
    })
  }
  return spec
}

// The root spec of `bytes`, held to be the lockfile's: of `name` at
// `version`, as Pod::Version writes it back.
export function readPodspec(bytes, name, version, where) {
  const root = specOf(readJson(bytes, where), undefined, '', where)
  if (root.name !== name) throw new DeptreeError(`its podspec is of ${quote(root.name)}`, where)
  if (root.attributes.version !== version) throw new DeptreeError(`its podspec is of version ${typeof root.attributes.version === 'string' ? quote(root.attributes.version) : 'none'}`, where)
  return root
}

// Every spec, the root first, then each inside one after it, depth first,
// as recursive_subspecs lists them.
export function allSpecs(root) {
  return [root, ...root.children.flatMap((child) => allSpecs(child))]
}

export function specNamed(root, name) {
  return allSpecs(root).find((spec) => spec.name === name)
}

// Specification#platform_hash: a name, a list of names, or names to
// deployment targets; anything else, none.
function platformNames(spec, where) {
  const value = spec.attributes.platforms
  const given = typeof value === 'string' ? [[value, null]] : Array.isArray(value) ? value.map((name) => [name, null]) : isObject(value) ? Object.entries(value) : []
  return given.map(([name, target]) => {
    if (typeof name !== 'string' || PLATFORM_NAMES[name] === undefined) throw new DeptreeError(`${spec.at}platforms names ${typeof name === 'string' ? quote(name) : 'what is no name'}, not a platform CocoaPods takes alike in each release`, where)
    if (target !== null && !(typeof target === 'string' && DEPLOYMENT_TARGET.test(target))) throw new DeptreeError(`${spec.at}platforms.${name} is not a deployment target`, where)
    return PLATFORM_NAMES[name]
  })
}

// available_platforms: its own, else its parent's, else all of them.
export function platformsOf(spec, where) {
  for (let at = spec; at !== undefined; at = at.parent) {
    const names = platformNames(at, where)
    if (names.length > 0) return [...new Set(names)]
  }
  return PLATFORMS
}

// The hash of a platform's values where a spec gives one, as the Consumer
// reads it; anything else but null or false CocoaPods fails on, or reads as
// a string.
function platformHash(spec, platform, where) {
  const value = spec.attributes[platform]
  if (value === undefined || value === null || value === false) return undefined
  if (!isObject(value)) throw new DeptreeError(`${spec.at}${platform} is not a hash of values for the platform`, where)
  return value
}

// prepare_value of a list: a value as a list of itself, nulls dropped;
// each has to be a pattern, as File.fnmatch takes nothing else.
function patternsOf(value, what, where) {
  if (value === undefined || value === null) return []
  const list = Array.isArray(value) ? value.filter((item) => item !== null) : [value]
  for (const item of list) if (!isText(item)) throw new DeptreeError(`${what} is not a file pattern, or a list of them`, where)
  return list
}

// The raw value of `key` on `platform`, its own and the platform's.
function rawValues(spec, key, platform, where) {
  return [spec.attributes[key], platformHash(spec, platform, where)?.[key]]
}

function listOf(spec, key, platform, where) {
  const [own, onPlatform] = rawValues(spec, key, platform, where)
  return [...patternsOf(own, `${spec.at}${key}`, where), ...patternsOf(onPlatform, `${spec.at}${platform}.${key}`, where)]
}

// A path given as it is joined to the pod's directory, as Pathname#+ joins
// it: one this keeps as it is, within the directory.
function checkPath(path, what, where) {
  if (!isText(path) || path === '' || path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new DeptreeError(`${what} is not a path within the pod, as CocoaPods joins it to the pod's directory`, where)
  }
  return path
}

// prefix_header_file and module_map: a path, or false or null for none,
// the platform's over the spec's, the spec's over its parent's.
function pathOf(spec, key, platform, where) {
  const [own, onPlatform] = rawValues(spec, key, platform, where)
  const value = onPlatform ?? own ?? (spec.parent === undefined ? undefined : pathOf(spec.parent, key, platform, where))
  if (value === undefined || value === null || value === false) return undefined
  if (typeof value !== 'string') throw new DeptreeError(`${spec.at}${key} is ${JSON.stringify(value)}, which CocoaPods fails on`, where)
  return checkPath(value, `${spec.at}${key}`, where)
}

// resource_bundles and on_demand_resources: a hash, the platform's merged
// into the spec's, by name.
function hashOf(spec, key, platform, where, prepare) {
  const result = new Map()
  for (const [value, what] of [[spec.attributes[key], `${spec.at}${key}`], [platformHash(spec, platform, where)?.[key], `${spec.at}${platform}.${key}`]]) {
    if (value === undefined || value === null) continue
    if (!isObject(value)) throw new DeptreeError(`${what} is not a hash, which CocoaPods fails on`, where)
    for (const [name, patterns] of Object.entries(value)) {
      const prepared = prepare(patterns, `${what}[${quote(name)}]`)
      if (result.has(name) && key === 'on_demand_resources') throw new DeptreeError(`${what}[${quote(name)}] is given for the spec and for ${platform} too, which CocoaPods fails on`, where)
      result.set(name, [...result.get(name) ?? [], ...prepared])
    }
  }
  return [...result.values()].flat()
}

const bundlePatterns = (where) => (patterns, what) => patternsOf(patterns, what, where)

// _prepare_on_demand_resources: patterns, or a hash of its `paths` and a
// `category`, which has to be a name.
const onDemandPatterns = (where) => (patterns, what) => {
  if (typeof patterns === 'string' || Array.isArray(patterns)) return patternsOf(patterns, what, where)
  if (!isObject(patterns)) throw new DeptreeError(`${what} is not file patterns, or a hash of them, which CocoaPods fails on`, where)
  if (Object.hasOwn(patterns, 'category') && typeof patterns.category !== 'string') throw new DeptreeError(`${what}.category is not a name, which CocoaPods fails on`, where)
  return patternsOf(patterns.paths, `${what}.paths`, where)
}

// What a spec's Consumer on `platform` gives of each attribute that names
// files: the lists of patterns, those of its resource bundles and its
// on-demand resources, and the prefix header's and module map's paths.
export function consumerOf(spec, platform, where) {
  const values = {}
  for (const key of LISTS) values[key] = listOf(spec, key, platform, where)
  values.resource_bundles = hashOf(spec, 'resource_bundles', platform, where, bundlePatterns(where))
  values.on_demand_resources = hashOf(spec, 'on_demand_resources', platform, where, onDemandPatterns(where))
  for (const key of PATHS) values[key] = pathOf(spec, key, platform, where)
  return values
}

// The root's license file, as RootAttributesAccessors#license reads it: of
// a hash alone, where its `text`, which CocoaPods strips, is text.
export function licenseFileOf(root, where) {
  const license = root.attributes.license
  if (!isObject(license)) return undefined
  if (license.text !== undefined && license.text !== null && license.text !== false && typeof license.text !== 'string') throw new DeptreeError('license.text is not text, which CocoaPods fails on', where)
  const file = license.file
  if (file === undefined || file === null || file === false) return undefined
  if (typeof file !== 'string') throw new DeptreeError('license.file is not a path, which CocoaPods fails on', where)
  return checkPath(file, 'license.file', where)
}
