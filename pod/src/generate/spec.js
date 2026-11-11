// A podspec as cocoapods-core 1.16 reads one from JSON, and its Consumer's attributes on a platform: a spec's own
// value, the platform's over it, and an inherited attribute's parent's under both. Test and app specs are skipped.

import { PodError, quote } from '../error.js'

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const HI = { container: 'hash', inherited: true }
const kind = (attribute, names) => Object.fromEntries(names.map((name) => [name, attribute]))
// The attributes a Consumer gives, by kind: its container, whether a subspec inherits it, whether it is a flag
// (the last one given stands), and its default.
const ATTRIBUTES = {
  ...kind({ container: 'array' }, ['script_phases', 'source_files', 'public_header_files', 'project_header_files', 'private_header_files', 'vendored_frameworks', 'vendored_libraries', 'resources', 'exclude_files']),
  ...kind({ container: 'array', inherited: true }, ['frameworks', 'weak_frameworks', 'libraries', 'compiler_flags']),
  ...kind(HI, ['dependencies', 'xcconfig', 'pod_target_xcconfig', 'user_target_xcconfig']),
  ...kind({ inherited: true }, ['prefix_header_contents', 'header_dir', 'header_mappings_dir']),
  ...kind({ flag: true, inherited: true }, ['prefix_header_file', 'module_map']),
  requires_arc: { flag: true, inherited: true, default: true },
  resource_bundles: { container: 'hash' },
}
// Specification#c99ext_identifier, of ASCII, which I18n.transliterate leaves as it is.
function c99ext(name, where) {
  if (name === undefined || name === null) return undefined
  if (typeof name !== 'string' || !/^[ -~]*$/u.test(name)) throw new PodError(`${quote(String(name))} is not a name in ASCII, which a module is named after`, where)
  return name.replace(/^(\d)/u, '_$1').replaceAll(/[^a-zA-Z0-9_]/gu, '_').replaceAll(/_+/gu, '_')
}

function specOf(hash, parent, where) {
  if (!isObject(hash) || typeof hash.name !== 'string' || hash.name === '' || hash.name.includes('/')) throw new PodError('its podspec has a spec with no name', where)
  const spec = { name: parent === undefined ? hash.name : `${parent.name}/${hash.name}`, attributes: hash, parent, subspecs: [], root: parent?.root }
  spec.root ??= spec
  for (const key of ['subspecs', 'testspecs', 'appspecs']) {
    const list = hash[key] ?? []
    if (!Array.isArray(list)) throw new PodError(`its podspec's ${key} is not a list`, where)
    // A test or an app spec is not built for an app.
    if (key === 'subspecs') spec.subspecs.push(...list.map((child) => specOf(child, spec, where)))
  }
  return spec
}

// The root spec of a podspec's JSON, held to be of `name` at `version`.
export function readSpec(bytes, name, version, where) {
  let json
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes))
  } catch {
    throw new PodError('its podspec is not JSON', where)
  }
  const root = specOf(json, undefined, where)
  if (root.name !== name) throw new PodError(`its podspec is of ${quote(root.name)}`, where)
  if (root.attributes.version !== version) throw new PodError(`its podspec is of version ${quote(String(root.attributes.version))}, not ${quote(version)}`, where)
  return root
}

const allSpecs = (spec) => [spec, ...spec.subspecs.flatMap((child) => allSpecs(child))]
export const specNamed = (root, name) => allSpecs(root).find((spec) => spec.name === name)

// Specification#platform_hash and #deployment_target.
function platformHash(spec) {
  const value = spec.attributes.platforms
  if (typeof value === 'string') return { [value]: null }
  if (Array.isArray(value)) return Object.fromEntries(value.map((name) => [name, null]))
  return isObject(value) ? value : {}
}
export function deploymentTarget(spec, platform) {
  for (let at = spec; at !== undefined; at = at.parent) {
    const target = platformHash(at)[platform]
    if (target !== undefined && target !== null) return String(target)
  }
  return undefined
}
// Whether a spec is for `platform`: by its own platforms, else its parent's; none is all.
export function supports(spec, platform) {
  for (let at = spec; at !== undefined; at = at.parent) {
    const names = Object.keys(platformHash(at))
    if (names.length > 0) return names.includes(platform)
  }
  return true
}

const listOf = (value) => (value === undefined || value === null ? [] : isObject(value) ? [value] : (Array.isArray(value) ? value : [value]).filter((item) => item !== null))

// Consumer#prepare_value.
function prepare(name, attribute, value) {
  if (attribute.container === 'array') return listOf(value)
  if (value === undefined || value === null) return undefined
  if (name === 'resource_bundles') return Object.fromEntries(Object.entries(value).map(([key, patterns]) => [key, listOf(patterns)]))
  if (name === 'prefix_header_contents') return (Array.isArray(value) ? value.join('\n') : String(value)).replace(/\n$/u, '')
  return value
}

// Consumer#merge_values: a flag's last value; lists one after the other; hashes merged, a key both have joined by
// a space, or as one list.
function merge(attribute, existing, value) {
  if (value === undefined) return existing
  if (existing === undefined) return value
  if (attribute.flag) return value
  if (attribute.container === 'array') return [...existing, ...value]
  if (attribute.container !== 'hash') return value
  const merged = { ...existing }
  for (const [key, one] of Object.entries(value)) {
    if (!Object.hasOwn(existing, key)) merged[key] = one
    else if (Array.isArray(one) || Array.isArray(existing[key])) merged[key] = [...listOf(existing[key]), ...listOf(one)]
    else merged[key] = `${existing[key]} ${one}`
  }
  return merged
}

function raw(spec, name, attribute, platform) {
  const own = prepare(name, attribute, spec.attributes[name])
  const onPlatform = spec.attributes[platform]
  return isObject(onPlatform) ? merge(attribute, own, prepare(name, attribute, onPlatform[name])) : own
}
function inherited(spec, name, attribute, platform) {
  const value = raw(spec, name, attribute, platform)
  return spec.parent === undefined || !attribute.inherited ? value : merge(attribute, inherited(spec.parent, name, attribute, platform), value)
}

// Consumer#_prepare_script_phases: the position is `any` where none is given.
const scriptPhases = (phases) => phases.filter(isObject).map((phase) => ({ ...phase, execution_position: phase.execution_position ?? 'any' }))

// A spec's Consumer on `platform`: every attribute, a list or hash empty where none is given; both xcconfigs with
// the legacy `xcconfig` under them; and the names it depends on.
export function consumerOf(spec, platform) {
  const values = { spec, name: spec.name }
  for (const [name, attribute] of Object.entries(ATTRIBUTES)) {
    const value = inherited(spec, name, attribute, platform)
    values[name] = value ?? attribute.default ?? (attribute.container === 'array' ? [] : attribute.container === 'hash' ? {} : undefined)
  }
  values.pod_target_xcconfig = merge(HI, values.xcconfig, values.pod_target_xcconfig)
  values.user_target_xcconfig = merge(HI, values.xcconfig, values.user_target_xcconfig)
  values.script_phases = scriptPhases(values.script_phases)
  values.dependencies = Object.keys(values.dependencies)
  return values
}

// The attributes of the root alone.
export function rootOf(root, where) {
  const { attributes } = root
  const license = attributes.license
  return {
    version: attributes.version,
    moduleName: attributes.module_name ?? c99ext(attributes.header_dir, where) ?? c99ext(attributes.name, where),
    swiftVersions: listOf(attributes.swift_versions ?? attributes.swift_version).map(String),
    staticFramework: attributes.static_framework === true,
    license: isObject(license) ? license : typeof license === 'string' ? { type: license } : {},
    infoPlist: isObject(attributes.info_plist) ? attributes.info_plist : {},
  }
}
