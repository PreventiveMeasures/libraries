// A podspec as Specification.from_hash reads trunk's JSON, and what its Consumer makes of the attributes
// naming a pod's files on a platform: the spec's, the platform's over it, and an inherited one's parent's
// under both. What CocoaPods fails on, or one release reads otherwise than another, is refused.

import { DeptreeError, quote } from '../error.js'
import { UNSAFE } from '../mount.js'
import { CASE_UNSTABLE } from './unicode.js'

// The platforms by a podspec's names, and all in CocoaPods' order for a spec naming none; another case of a
// name, or `xros`, Platform takes from 1.16 alone
const PLATFORM_NAMES = { __proto__: null, osx: 'osx', macos: 'osx', ios: 'ios', tvos: 'tvos', visionos: 'visionos', watchos: 'watchos' }
const PLATFORMS = ['osx', 'ios', 'tvos', 'visionos', 'watchos']
// What Version.create takes of a deployment target, as trunk has them.
const DEPLOYMENT_TARGET = /^\d+(?:\.\d+)*$/u

// The keys from_hash takes the specs inside one from, each a list.
const CHILDREN = ['subspecs', 'testspecs', 'appspecs']

// The file patterns, each a list, none inherited.
const LISTS = ['source_files', 'exclude_files', 'resources', 'preserve_paths', 'vendored_frameworks', 'vendored_libraries']
// One path each, inherited: a subspec takes its parent's where it has none.
const PATHS = ['prefix_header_file', 'module_map']

export const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
// Given at all: a podspec leaves a value out as undefined, null or false.
export const given = (value) => value !== undefined && value !== null && value !== false
// Not what reads otherwise than written, nor what CocoaPods compares by a case releases map otherwise
const isText = (value) => typeof value === 'string' && value.isWellFormed() && !UNSAFE.test(value) && !CASE_UNSTABLE.test(value)

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

// A spec and those inside it, each named in full, `Root/Sub`; `at` is where it is, for a refusal
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

// The root spec, held to be the lockfile's `name` at `version`, as Pod::Version writes it back
export function readPodspec(bytes, name, version, where) {
  const root = specOf(readJson(bytes, where), undefined, '', where)
  if (root.name !== name) throw new DeptreeError(`its podspec is of ${quote(root.name)}`, where)
  if (root.attributes.version !== version) throw new DeptreeError(`its podspec is of version ${typeof root.attributes.version === 'string' ? quote(root.attributes.version) : 'none'}`, where)
  return root
}

// Every spec, depth first, as recursive_subspecs lists them
export function allSpecs(root) {
  return [root, ...root.children.flatMap((child) => allSpecs(child))]
}

export function specNamed(root, name) {
  return allSpecs(root).find((spec) => spec.name === name)
}

// Specification#platform_hash: a name, names, or names to deployment targets; anything else, none
function platformNames(spec, where) {
  const value = spec.attributes.platforms
  const named = typeof value === 'string' ? [[value, null]] : Array.isArray(value) ? value.map((name) => [name, null]) : isObject(value) ? Object.entries(value) : []
  return named.map(([name, target]) => {
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

// A platform's values, as the Consumer reads them; anything but a hash, null or false CocoaPods fails on
function platformHash(spec, platform, where) {
  const value = spec.attributes[platform]
  if (!given(value)) return undefined
  if (!isObject(value)) throw new DeptreeError(`${spec.at}${platform} is not a hash of values for the platform`, where)
  return value
}

// prepare_value: a value as a list of itself, nulls dropped, each a pattern, as File.fnmatch takes no other
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

// A path Pathname#+ joins to the pod's directory as it is, within it
function checkPath(path, what, where) {
  if (!isText(path) || path === '' || path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new DeptreeError(`${what} is not a path within the pod, as CocoaPods joins it to the pod's directory`, where)
  }
  return path
}

// prefix_header_file and module_map: the platform's over the spec's over its parent's; false or null none
function pathOf(spec, key, platform, where) {
  const [own, onPlatform] = rawValues(spec, key, platform, where)
  const value = onPlatform ?? own ?? (spec.parent === undefined ? undefined : pathOf(spec.parent, key, platform, where))
  if (!given(value)) return undefined
  if (typeof value !== 'string') throw new DeptreeError(`${spec.at}${key} is ${JSON.stringify(value)}, which CocoaPods fails on`, where)
  return checkPath(value, `${spec.at}${key}`, where)
}

// _prepare_on_demand_resources: patterns, or a hash of `paths` and a `category` name
function onDemandPatterns(patterns, what, where) {
  if (typeof patterns === 'string' || Array.isArray(patterns)) return patternsOf(patterns, what, where)
  if (!isObject(patterns)) throw new DeptreeError(`${what} is not file patterns, or a hash of them, which CocoaPods fails on`, where)
  if (Object.hasOwn(patterns, 'category') && typeof patterns.category !== 'string') throw new DeptreeError(`${what}.category is not a name, which CocoaPods fails on`, where)
  return patternsOf(patterns.paths, `${what}.paths`, where)
}

// resource_bundles and on_demand_resources: the platform's hash merged into the spec's, by name. A bundle
// in both has both's patterns; CocoaPods fails on an on-demand resource in both, adding them as strings.
function hashOf(spec, key, platform, where, prepare) {
  const result = new Map()
  const whats = [`${spec.at}${key}`, `${spec.at}${platform}.${key}`]
  for (const [index, value] of rawValues(spec, key, platform, where).entries()) {
    if (value === undefined || value === null) continue
    if (!isObject(value)) throw new DeptreeError(`${whats[index]} is not a hash, which CocoaPods fails on`, where)
    for (const [name, patterns] of Object.entries(value)) {
      const what = `${whats[index]}[${quote(name)}]`
      if (result.has(name) && prepare === onDemandPatterns) throw new DeptreeError(`${what} is given for the spec and for ${platform} too, which CocoaPods fails on`, where)
      result.set(name, [...result.get(name) ?? [], ...prepare(patterns, what, where)])
    }
  }
  return [...result.values()].flat()
}

// What a spec's Consumer gives on `platform` of each attribute that names files
export function consumerOf(spec, platform, where) {
  const values = {}
  for (const key of LISTS) values[key] = listOf(spec, key, platform, where)
  values.resource_bundles = hashOf(spec, 'resource_bundles', platform, where, patternsOf)
  values.on_demand_resources = hashOf(spec, 'on_demand_resources', platform, where, onDemandPatterns)
  for (const key of PATHS) values[key] = pathOf(spec, key, platform, where)
  return values
}

// The license file, as RootAttributesAccessors#license reads it: of a hash alone, its `text` text
export function licenseFileOf(root, where) {
  const license = root.attributes.license
  if (!isObject(license)) return undefined
  if (given(license.text) && typeof license.text !== 'string') throw new DeptreeError('license.text is not text, which CocoaPods fails on', where)
  const file = license.file
  if (!given(file)) return undefined
  if (typeof file !== 'string') throw new DeptreeError('license.file is not a path, which CocoaPods fails on', where)
  return checkPath(file, 'license.file', where)
}
