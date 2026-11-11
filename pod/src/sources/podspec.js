// A podspec as CocoaPods' cleaner reads it, from the JSON stage 1 holds to the lockfile: what its Consumer makes of
// the attributes that name a pod's files, on each platform. What CocoaPods would fail on, and what one release
// reads otherwise than another, is refused.

import { PodError, quote } from '../error.js'
import { CASE_UNSTABLE } from './unicode.js'

// What the lockfile reader refuses in a path: a backslash, and what reads otherwise than it is written.
const UNSAFE = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}\\]/u

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
const LISTS = ['source_files', 'exclude_files', 'resources', 'preserve_paths', 'vendored_frameworks', 'vendored_libraries']
// One path each, inherited: a subspec takes its parent's where it has none.
const PATHS = ['prefix_header_file', 'module_map']

export const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
// Given at all: a podspec leaves a value out as undefined, null or false.
export const given = (value) => value !== undefined && value !== null && value !== false
// Text a pattern or a path can be: not what reads otherwise than it is
// written, nor what CocoaPods compares by a case Ruby maps otherwise in one
// release than another.
const isText = (value) => typeof value === 'string' && value.isWellFormed() && !UNSAFE.test(value) && !CASE_UNSTABLE.test(value)

function readJson(bytes, where) {
  let json
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes))
  } catch {
    throw new PodError('its podspec is not JSON', where)
  }
  if (!isObject(json)) throw new PodError('its podspec is not a JSON object', where)
  return json
}

// A spec and those inside it, each with its name in full, `Root/Sub`, and
// its parent. `at` is where it is in the podspec, for a refusal.
function specOf(hash, parent, at, where) {
  const name = hash.name
  if (!isText(name) || name === '' || name.includes('/')) throw new PodError(`${at}name is not a spec's name`, where)
  const spec = { name: parent === undefined ? name : `${parent.name}/${name}`, attributes: hash, parent, children: [], at }
  for (const key of CHILDREN) {
    const list = hash[key]
    if (list === undefined || list === null) continue
    if (!Array.isArray(list)) throw new PodError(`${at}${key} is not a list of specs`, where)
    list.forEach((child, index) => {
      if (!isObject(child)) throw new PodError(`${at}${key}[${index}] is not a spec`, where)
      spec.children.push(specOf(child, spec, `${at}${key}[${index}].`, where))
    })
  }
  return spec
}

// The root spec of `bytes`, held to be the lockfile's: of `name` at
// `version`, as Pod::Version writes it back.
export function readPodspec(bytes, name, version, where) {
  const root = specOf(readJson(bytes, where), undefined, '', where)
  if (root.name !== name) throw new PodError(`its podspec is of ${quote(root.name)}`, where)
  if (root.attributes.version !== version) throw new PodError(`its podspec is of version ${typeof root.attributes.version === 'string' ? quote(root.attributes.version) : 'none'}`, where)
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
  const named = typeof value === 'string' ? [[value, null]] : Array.isArray(value) ? value.map((name) => [name, null]) : isObject(value) ? Object.entries(value) : []
  return named.map(([name, target]) => {
    if (typeof name !== 'string' || PLATFORM_NAMES[name] === undefined) throw new PodError(`${spec.at}platforms names ${typeof name === 'string' ? quote(name) : 'what is no name'}, not a platform CocoaPods takes alike in each release`, where)
    if (target !== null && !(typeof target === 'string' && DEPLOYMENT_TARGET.test(target))) throw new PodError(`${spec.at}platforms.${name} is not a deployment target`, where)
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
  if (!given(value)) return undefined
  if (!isObject(value)) throw new PodError(`${spec.at}${platform} is not a hash of values for the platform`, where)
  return value
}

// prepare_value of a list: a value as a list of itself, nulls dropped;
// each has to be a pattern, as File.fnmatch takes nothing else.
function patternsOf(value, what, where) {
  if (value === undefined || value === null) return []
  const list = Array.isArray(value) ? value.filter((item) => item !== null) : [value]
  for (const item of list) if (!isText(item)) throw new PodError(`${what} is not a file pattern, or a list of them`, where)
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
    throw new PodError(`${what} is not a path within the pod, as CocoaPods joins it to the pod's directory`, where)
  }
  return path
}

// prefix_header_file and module_map: a path, or false or null for none,
// the platform's over the spec's, the spec's over its parent's.
function pathOf(spec, key, platform, where) {
  const [own, onPlatform] = rawValues(spec, key, platform, where)
  const value = onPlatform ?? own ?? (spec.parent === undefined ? undefined : pathOf(spec.parent, key, platform, where))
  if (!given(value)) return undefined
  if (typeof value !== 'string') throw new PodError(`${spec.at}${key} is ${JSON.stringify(value)}, which CocoaPods fails on`, where)
  return checkPath(value, `${spec.at}${key}`, where)
}

// _prepare_on_demand_resources: patterns, or a hash of its `paths` and a
// `category`, which has to be a name.
function onDemandPatterns(patterns, what, where) {
  if (typeof patterns === 'string' || Array.isArray(patterns)) return patternsOf(patterns, what, where)
  if (!isObject(patterns)) throw new PodError(`${what} is not file patterns, or a hash of them, which CocoaPods fails on`, where)
  if (Object.hasOwn(patterns, 'category') && typeof patterns.category !== 'string') throw new PodError(`${what}.category is not a name, which CocoaPods fails on`, where)
  return patternsOf(patterns.paths, `${what}.paths`, where)
}

// resource_bundles and on_demand_resources: a hash, the platform's merged into the spec's by name, each its
// patterns as `prepare` reads them. A bundle in both has both's; an on-demand resource fails CocoaPods.
function hashOf(spec, key, platform, where, prepare) {
  const result = new Map()
  const whats = [`${spec.at}${key}`, `${spec.at}${platform}.${key}`]
  for (const [index, value] of rawValues(spec, key, platform, where).entries()) {
    if (value === undefined || value === null) continue
    if (!isObject(value)) throw new PodError(`${whats[index]} is not a hash, which CocoaPods fails on`, where)
    for (const [name, patterns] of Object.entries(value)) {
      const what = `${whats[index]}[${quote(name)}]`
      if (result.has(name) && prepare === onDemandPatterns) throw new PodError(`${what} is given for the spec and for ${platform} too, which CocoaPods fails on`, where)
      result.set(name, [...result.get(name) ?? [], ...prepare(patterns, what, where)])
    }
  }
  return [...result.values()].flat()
}

// What a spec's Consumer on `platform` gives of each attribute that names
// files: the lists of patterns, those of its resource bundles and its
// on-demand resources, and the prefix header's and module map's paths.
export function consumerOf(spec, platform, where) {
  const values = {}
  for (const key of LISTS) values[key] = listOf(spec, key, platform, where)
  values.resource_bundles = hashOf(spec, 'resource_bundles', platform, where, patternsOf)
  values.on_demand_resources = hashOf(spec, 'on_demand_resources', platform, where, onDemandPatterns)
  for (const key of PATHS) values[key] = pathOf(spec, key, platform, where)
  return values
}

// The root's license file, as RootAttributesAccessors#license reads it: of
// a hash alone, where its `text`, which CocoaPods strips, is text.
export function licenseFileOf(root, where) {
  const license = root.attributes.license
  if (!isObject(license)) return undefined
  if (given(license.text) && typeof license.text !== 'string') throw new PodError('license.text is not text, which CocoaPods fails on', where)
  const file = license.file
  if (!given(file)) return undefined
  if (typeof file !== 'string') throw new PodError('license.file is not a path, which CocoaPods fails on', where)
  return checkPath(file, 'license.file', where)
}
