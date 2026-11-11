// A podspec as CocoaPods' cleaner reads it: what its Consumer makes of the attributes that name a pod's files, on a
// platform. The JSON is stage 1's, which load.js has read and held to the lockfile.

export const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
// Given at all: a podspec leaves a value out as undefined, null or false.
export const given = (value) => value !== undefined && value !== null && value !== false

// The file patterns, each a list, none inherited; and the paths a subspec takes its parent's of where it has none.
const LISTS = ['source_files', 'exclude_files', 'resources', 'preserve_paths', 'vendored_frameworks', 'vendored_libraries']
const PATHS = ['prefix_header_file', 'module_map']

// A path within the pod's directory, as CocoaPods joins it to that: else none.
const inside = (path) => (typeof path === 'string' && path !== '' && path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..') ? path : undefined)

// A spec and those inside it, test and app specs too, each by its name in full, `Root/Sub`.
function specOf(hash, parent) {
  const spec = { name: parent === undefined ? hash.name : `${parent.name}/${hash.name}`, attributes: hash, parent }
  spec.children = ['subspecs', 'testspecs', 'appspecs'].flatMap((key) => (Array.isArray(hash[key]) ? hash[key] : [])).filter(isObject).map((child) => specOf(child, spec))
  return spec
}
export const readPodspec = (bytes) => specOf(JSON.parse(Buffer.from(bytes).toString('utf8')), undefined)

const allSpecs = (spec) => [spec, ...spec.children.flatMap(allSpecs)]
export const specNamed = (root, name) => allSpecs(root).find((spec) => spec.name === name)

// prepare_value of a list: a value as a list of itself, nulls dropped.
const listOf = (value) => (value === undefined || value === null ? [] : [value].flat().filter((item) => item !== null))
// The values of `key` on `platform`: the spec's own, then the platform's.
function valuesOf(spec, key, platform) {
  const onPlatform = spec.attributes[platform]
  return [spec.attributes[key], isObject(onPlatform) ? onPlatform[key] : undefined]
}
// The patterns of resource_bundles and on_demand_resources, each a hash by name; an on-demand resource's may be a
// hash of its `paths`.
const hashPatterns = (values) => values.filter(isObject).flatMap((hash) => Object.values(hash)).flatMap((patterns) => listOf(isObject(patterns) ? patterns.paths : patterns))
// prefix_header_file and module_map: the platform's over the spec's, the spec's over its parent's; false for none.
function pathOf(spec, key, platform) {
  const [own, onPlatform] = valuesOf(spec, key, platform)
  return inside(onPlatform ?? own ?? (spec.parent === undefined ? undefined : pathOf(spec.parent, key, platform)))
}

// What a spec's Consumer on `platform` gives of each attribute that names files.
export function consumerOf(spec, platform) {
  const values = Object.fromEntries(LISTS.map((key) => [key, valuesOf(spec, key, platform).flatMap(listOf)]))
  values.resource_bundles = hashPatterns(valuesOf(spec, 'resource_bundles', platform))
  values.on_demand_resources = hashPatterns(valuesOf(spec, 'on_demand_resources', platform))
  for (const key of PATHS) values[key] = pathOf(spec, key, platform)
  return values
}

// The root's license file, where its license is a hash that names one.
export const licenseFileOf = (root) => (isObject(root.attributes.license) ? inside(root.attributes.license.file) : undefined)
