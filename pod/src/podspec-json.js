// A specification as CocoaPods' DSL builds one from a podspec, and the JSON it writes of it, to_pretty_json:
// what `pod install` keeps as Pods/Local Podspecs/<name>.podspec.json, and Podfile.lock has the sha1 of. A hash
// is a Map, so that its keys stay in the order they were given.

import { PodError, quote } from './error.js'
import { compareVersions } from './targets.js'

const SINGULAR = {
  author: 'authors', swift_version: 'swift_versions', screenshot: 'screenshots', framework: 'frameworks', weak_framework: 'weak_frameworks', library: 'libraries',
  compiler_flag: 'compiler_flags', script_phase: 'script_phases', vendored_framework: 'vendored_frameworks', vendored_library: 'vendored_libraries',
  on_demand_resource: 'on_demand_resources', resource_bundle: 'resource_bundles', resource: 'resources', preserve_path: 'preserve_paths', default_subspec: 'default_subspecs',
}
// The attributes of the root alone, and those a platform can have its own value of.
const ROOT = new Set(['name', 'version', 'swift_versions', 'cocoapods_version', 'authors', 'social_media_url', 'license', 'homepage', 'readme', 'changelog', 'source', 'summary', 'description', 'screenshots', 'documentation_url', 'prepare_command', 'static_framework', 'deprecated', 'deprecated_in_favor_of', 'module_name', 'default_subspecs', 'platforms', 'test_type'])
const PER_PLATFORM = new Set(['info_plist', 'requires_arc', 'frameworks', 'weak_frameworks', 'libraries', 'compiler_flags', 'pod_target_xcconfig', 'user_target_xcconfig', 'xcconfig', 'prefix_header_contents', 'prefix_header_file', 'header_dir', 'header_mappings_dir', 'script_phases', 'source_files', 'public_header_files', 'project_header_files', 'private_header_files', 'vendored_frameworks', 'vendored_libraries', 'on_demand_resources', 'resource_bundles', 'resources', 'exclude_files', 'preserve_paths', 'module_map', 'requires_app_host', 'app_host_name', 'scheme'])
export const PLATFORMS = ['osx', 'ios', 'tvos', 'visionos', 'watchos']

export const newSpec = (parent, name, kind = 'library') => ({ attributes: new Map([['name', name], ...(kind === 'test' ? [['test_type', 'unit']] : [])]), subspecs: [], parent, kind })

// ActiveSupport's strip_heredoc and Ruby's strip, which Specification#store_attribute puts a string through.
function stripped(text) {
  const indents = [...text.matchAll(/^[ \t]*(?=\S)/gmu)].map((match) => match[0]).sort()
  const dedented = indents.length === 0 || indents[0] === '' ? text : text.replaceAll(new RegExp(`^${indents[0]}`, 'gmu'), '')
  return dedented.replace(/^[\t\n\v\f\r ]+/u, '').replace(/[\t\n\v\f\r \0]+$/u, '')
}

// `writer` is an attribute's name as a podspec sets it, `s.<writer> = value`; `platform` where it is
// `s.<platform>.<writer> = value`.
export function setAttribute(spec, writer, value, platform, fail) {
  if (writer === 'platform' && platform === undefined) {
    const [name, target] = Array.isArray(value) ? value : [value]
    return void spec.attributes.set('platforms', name === null || name === undefined ? new Map() : new Map([[name === 'macos' ? 'osx' : String(name), target ?? null]]))
  }
  if (writer === 'deployment_target') {
    if (platform === undefined) fail('a deployment target that is of no platform')
    if (!(spec.attributes.get('platforms') instanceof Map)) spec.attributes.set('platforms', new Map())
    return void spec.attributes.get('platforms').set(platform, value)
  }
  const name = SINGULAR[writer] ?? writer
  if (!ROOT.has(name) && !PER_PLATFORM.has(name)) fail(`the attribute ${quote(writer)}`)
  const stored = typeof value === 'string' ? stripped(value) : value
  if (platform === undefined) return void spec.attributes.set(name, stored)
  if (!PER_PLATFORM.has(name)) fail(`${quote(writer)} set for a platform`)
  if (!spec.attributes.has(platform)) spec.attributes.set(platform, new Map())
  return void spec.attributes.get(platform).set(name, stored)
}

// Specification#dependency: a name and its requirements, each a string.
export function addDependency(spec, args, platform, fail) {
  const [name, ...requirements] = args
  if (typeof name !== 'string' || requirements.some((one) => typeof one !== 'string')) fail('a dependency that is not a name and requirements')
  const holder = platform === undefined ? spec.attributes : spec.attributes.get(platform) ?? spec.attributes.set(platform, new Map()).get(platform)
  if (!holder.has('dependencies')) holder.set('dependencies', new Map())
  holder.get('dependencies').set(name, requirements)
}

function platformHash(spec) {
  const value = spec.attributes.get('platforms')
  if (typeof value === 'string') return new Map([[value, null]])
  if (Array.isArray(value)) return new Map(value.map((name) => [name, null]))
  return value instanceof Map ? value : new Map()
}
function deploymentTarget(spec, name) {
  for (let at = spec; at !== undefined; at = at.parent) if ((platformHash(at).get(name) ?? null) !== null) return String(platformHash(at).get(name))
  return null
}
// Specification#available_platforms: its own, else its parent's, else all of them; each with its target.
function availablePlatforms(spec) {
  let names = []
  for (let at = spec; at !== undefined && names.length === 0; at = at.parent) names = [...platformHash(at).keys()]
  if (names.some((name) => !PLATFORMS.includes(name))) throw new PodError(`its podspec names the platform ${quote(String(names.find((name) => !PLATFORMS.includes(name))))}`)
  return (names.length === 0 ? PLATFORMS : names).map((name) => [name, deploymentTarget(spec, name)])
}
const samePlatforms = (a, b) => a.length === b.length && a.every(([name, target], i) => name === b[i][0] && (target === b[i][1] || (target !== null && b[i][1] !== null && compareVersions(target, b[i][1]) === 0)))

// The root's swift_version, as to_hash writes it: the greatest of its swift_versions.
function swiftVersion(spec) {
  const versions = [spec.attributes.get('swift_versions'), spec.attributes.get('swift_version')].flat().filter((one) => one !== undefined && one !== null).map(String)
  return versions.length === 0 ? undefined : versions.reduce((most, one) => (compareVersions(one, most) > 0 ? one : most))
}

// Specification#to_hash.
function toHash(spec) {
  const hash = new Map(spec.attributes)
  const platforms = availablePlatforms(spec)
  if (spec.parent === undefined || !samePlatforms(platforms, availablePlatforms(spec.parent))) hash.set('platforms', new Map(platforms))
  for (const [key, kind] of [['testspecs', 'test'], ['appspecs', 'app'], ['subspecs', 'library']]) {
    hash.delete(key)
    const specs = spec.subspecs.filter((one) => one.kind === kind)
    if (specs.length > 0) hash.set(key, specs.map(toHash))
  }
  hash.delete('swift_version')
  const swift = swiftVersion(spec)
  if (swift !== undefined) hash.set('swift_version', swift)
  return hash
}

// JSON.pretty_generate, of what a specification holds. Ruby's json wrote an empty list and an empty hash over
// lines until 2.10, and writes them closed since: `compact` is the latter.
function pretty(value, indent, compact) {
  const deeper = `${indent}  `
  if (value instanceof Map) {
    if (value.size === 0) return compact ? '{}' : `{\n${indent}}`
    return `{\n${[...value].map(([key, item]) => `${deeper}${JSON.stringify(String(key))}: ${pretty(item, deeper, compact)}`).join(',\n')}\n${indent}}`
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return compact ? '[]' : `[\n\n${indent}]`
    return `[\n${value.map((item) => `${deeper}${pretty(item, deeper, compact)}`).join(',\n')}\n${indent}]`
  }
  if (value === undefined || value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  throw new PodError('its podspec has a value that is no text, number, list or hash')
}

// Specification#to_pretty_json of a root specification, as each of the two forms Ruby's json has written it in:
// which of them a lockfile has the checksum of is by the Ruby that wrote the lockfile.
export function specJson(root) {
  const hash = toHash(root)
  return [false, true].map((compact) => `${pretty(hash, '', compact)}\n`)
}

// Specification.from_hash, of a podspec given as JSON that CocoaPods has not written itself: its attributes
// as they are, in their order, and the specs inside it. to_pretty_json of it is what CocoaPods keeps.
function fromHash(hash, parent, kind) {
  if (hash === null || typeof hash !== 'object' || Array.isArray(hash)) throw new PodError('its podspec is no hash of attributes')
  const ordered = (value) => {
    if (Array.isArray(value)) return value.map(ordered)
    if (value === null || typeof value !== 'object') return value
    if (Object.keys(value).some((key) => /^(?:0|[1-9]\d*)$/u.test(key))) throw new PodError('its podspec has a hash with a number for a key, whose place is not known')
    return new Map(Object.entries(value).map(([key, item]) => [key, ordered(item)]))
  }
  const spec = { attributes: new Map(), subspecs: [], parent, kind }
  for (const [key, value] of Object.entries(hash)) {
    const inner = { subspecs: 'library', testspecs: 'test', appspecs: 'app' }[key]
    if (inner === undefined) spec.attributes.set(key, ordered(value))
    else if (Array.isArray(value)) spec.subspecs.push(...value.map((child) => fromHash(child, spec, inner)))
  }
  return spec
}
export const jsonSpecJson = (text) => specJson(fromHash(JSON.parse(text), undefined, 'library'))
