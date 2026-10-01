// A dependency as a manifest declares it: a version requirement alone, a
// table, or `workspace = true` and what [workspace.dependencies] has under
// its name; under [dependencies], [dev-dependencies], [build-dependencies]
// and each [target.<platform>]'s.
//
// And a package's features, as cargo's feature map holds them, and the
// values in a feature's list.

import { parsePlatform } from '../crate/cargo-platform.js'
import { parseVersionReq } from '../crate/semver.js'
import { LockfileError, at, quote } from '../error.js'
import { EMPTY } from '../shape.js'
import { isTable } from '../toml/value.js'
import { boolean, checkFeature, checkName, entries, optional, refuse, string, strings, table } from './shape.js'
import { differ, sourceOf } from './sources.js'

export const NIGHTLY = 'which only a nightly cargo reads, is not supported'

// A version requirement, by the semver crate cargo reads it with.
export function parseRequirement(text, where) {
  const comparators = parseVersionReq(text)
  if (comparators === undefined) throw new LockfileError(`${quote(text)} is not a version requirement`, where)
  return comparators
}

// A [target.<platform>] table's platform, by the cargo-platform crate.
function checkPlatform(text, where) {
  if (parsePlatform(text) === undefined) throw new LockfileError(`${quote(text)} is neither a target's name nor a cfg(…) cargo reads`, where)
}

const DETAILED = [
  'version', 'registry', 'registry-index', 'path', 'git', 'branch', 'tag', 'rev', 'features', 'optional',
  'default-features', 'default_features', 'package', 'public',
]
const DETAILED_REFUSED = {
  base: `a path base, ${NIGHTLY}`,
  artifact: `an artifact dependency, ${NIGHTLY}`,
  lib: `an artifact dependency, ${NIGHTLY}`,
  target: `an artifact dependency, ${NIGHTLY}`,
}
const INHERITED = ['workspace', 'features', 'default-features', 'default_features', 'optional', 'public']
const KINDS = [['dependencies', 'normal'], ['dev-dependencies', 'dev'], ['build-dependencies', 'build']]

// `dev_dependencies` for `dev-dependencies` and the like: gone in the 2024
// edition, and ambiguous beside the other.
export function dashed(value, where, key, edition) {
  const old = key.replaceAll('-', '_')
  if (old === key || value[old] === undefined) return value[key]
  const here = at(where ?? '', old)
  if (edition === '2024') throw new LockfileError(`not supported in the 2024 edition: use ${quote(key)}`, here)
  if (value[key] !== undefined) throw new LockfileError(`given beside ${quote(key)}`, here)
  return value[old]
}

function checkUrl(value, where) {
  const url = URL.parse(string(value, where))
  if (url === null) throw new LockfileError(`${quote(value)} is not a URL`, where)
  return url
}

// The features a dependency asks for: its own, by name.
function readFeatures(value, where) {
  const features = optional(strings)(value, where) ?? []
  for (const [index, feature] of features.entries()) {
    const here = `${where}[${index}]`
    if (feature.includes('/')) throw new LockfileError(`${quote(feature)}: a dependency's feature cannot name another's`, here)
    if (feature.startsWith('dep:')) throw new LockfileError(`${quote(feature)}: a dependency's feature cannot be \`dep:\``, here)
  }
  return features
}

// What one entry of a dependency table says, `workspace = true` aside: a
// version requirement alone, or a table.
export function readSpec(value, where, name, edition) {
  if (typeof value === 'string') {
    parseRequirement(value, where)
    return { package: name, version: value, source: { type: 'registry', registry: undefined, index: undefined }, optional: false, defaultFeatures: true, features: [] }
  }
  table(value, where, DETAILED, DETAILED_REFUSED)
  const read = (key, reader) => optional(reader)(value[key], at(where, key))
  const version = read('version', string)
  if (version !== undefined) parseRequirement(version, at(where, 'version'))
  const registry = read('registry', checkName)
  const index = read('registry-index', string)
  if (index !== undefined) checkUrl(index, at(where, 'registry-index'))
  const path = read('path', string)
  const git = read('git', string)
  const reference = ['branch', 'tag', 'rev'].filter((key) => value[key] !== undefined)
  const ambiguous = [
    git !== undefined && (registry !== undefined || index !== undefined) && '`git` or a registry',
    registry !== undefined && index !== undefined && '`registry` or `registry-index`',
    git !== undefined && path !== undefined && '`git` or `path`',
    reference.length > 1 && '`branch`, `tag` or `rev`',
  ].find(Boolean)
  if (ambiguous) throw new LockfileError(`ambiguous: only one of ${ambiguous} is taken`, where)
  if (git === undefined && reference.length > 0) throw new LockfileError(`\`${reference[0]}\` is only for a git dependency`, at(where, reference[0]))
  if (version === undefined && path === undefined && git === undefined) throw new LockfileError('names no version, path or git repository', where)
  let source = { type: 'registry', registry, index }
  if (path !== undefined) source = { type: 'path', path }
  if (git !== undefined) {
    const url = checkUrl(git, at(where, 'git'))
    if (url.search !== '' || url.hash !== '') throw new LockfileError(`${quote(git)} has a query or a fragment, which cargo drops or misreads`, at(where, 'git'))
    source = { type: 'git', url: git, branch: read('branch', string), tag: read('tag', string), rev: read('rev', string) }
  }
  const features = readFeatures(value.features, at(where, 'features'))
  read('public', boolean)
  const defaultFeatures = optional(boolean)(dashed(value, where, 'default-features', edition), at(where, 'default-features')) ?? true
  return { package: read('package', checkName) ?? name, version, source, optional: read('optional', boolean) ?? false, defaultFeatures, features }
}

// `workspace = true`: the entry of [workspace.dependencies], with this
// entry's features added, and optional where this entry says so. Default
// features stay on where the workspace has them on.
function inherit(value, where, name, context) {
  table(value, where, INHERITED)
  if (value.workspace !== true) throw refuse('true', value.workspace, at(where, 'workspace'))
  if (context.workspace === undefined) throw new LockfileError('inherits from a workspace, and no workspace root is given', where)
  const spec = context.workspace.dependencies[name]
  if (spec === undefined) throw new LockfileError(`${quote(name)} is not in [workspace.dependencies]`, where)
  const features = readFeatures(value.features, at(where, 'features'))
  optional(boolean)(value.public, at(where, 'public'))
  const defaultFeatures = optional(boolean)(dashed(value, where, 'default-features', context.edition), at(where, 'default-features'))
  if (defaultFeatures === false && spec.defaultFeatures && context.edition === '2024') {
    throw new LockfileError('`default-features = false` cannot turn off the workspace\'s default features', where)
  }
  return {
    ...spec,
    features: [...spec.features, ...features],
    defaultFeatures: defaultFeatures === true || spec.defaultFeatures,
    optional: optional(boolean)(value.optional, at(where, 'optional')) ?? false,
    inherited: true,
  }
}

function readDependencies(value, where, kind, target, context) {
  for (const [name, item, here] of entries(value, where)) {
    checkName(name, here)
    const spec = isTable(item) && 'workspace' in item ? inherit(item, here, name, context) : { ...readSpec(item, here, name, context.edition), inherited: false }
    if (spec.optional && kind === 'dev') throw new LockfileError('a dev-dependency cannot be optional', here)
    const source = sourceOf(spec.source, spec.inherited)
    const seen = context.sources.get(name) ?? []
    if (seen.some((other) => differ(other, source))) throw new LockfileError(`${quote(name)} is given another source elsewhere, which cargo refuses`, here)
    context.sources.set(name, [...seen, source])
    context.list.push({ name, kind, target, ...spec })
  }
}

// Tables of dependencies at the top and under each [target.<platform>];
// `workspace` is the root's [workspace], for what is inherited from it.
export function gatherDependencies(doc, workspace, edition) {
  const context = { workspace, edition, list: [], sources: new Map() }
  const gather = (value, where, target) => {
    for (const [key, kind] of KINDS) {
      const deps = dashed(value, where, key, context.edition)
      if (deps !== undefined) readDependencies(deps, at(where ?? '', key), kind, target, context)
    }
  }
  gather(doc, undefined, undefined)
  for (const [platform, value, here] of entries(doc.target ?? EMPTY, 'target')) {
    checkPlatform(platform, here)
    table(value, here, KINDS.flatMap(([key]) => [key, key.replaceAll('-', '_')]))
    gather(value, here, platform)
  }
  return context.list
}

// A value in a feature's list, or one asked for: `name`, `dep:name`,
// `name/feature` or `name?/feature`.
export function featureValue(text) {
  const slash = text.indexOf('/')
  if (slash !== -1) {
    const weak = text[slash - 1] === '?'
    return { dep: text.slice(0, weak ? slash - 1 : slash), feature: text.slice(slash + 1), weak }
  }
  return text.startsWith('dep:') ? { dep: text.slice(4), feature: undefined, weak: false } : { dep: undefined, feature: text, weak: false }
}

// Cargo's feature map: the [features] table, and a feature for each
// optional dependency that no feature is named after or enables by `dep:`,
// as cargo's build_feature_map makes it and checks it.
export function featureMap(value, where, dependencies) {
  const written = Object.create(null)
  for (const [name, list, here] of entries(value ?? EMPTY, where)) written[checkFeature(name, here)] = strings(list, here)
  const optionalDep = new Map()
  for (const dep of dependencies) optionalDep.set(dep.name, (optionalDep.get(dep.name) ?? false) || dep.optional)
  const values = Object.values(written).flat().map(featureValue)
  const explicit = new Set(values.filter((item) => item.feature === undefined).map((item) => item.dep))
  const map = Object.assign(Object.create(null), written)
  for (const dep of dependencies) {
    if (dep.optional && !(dep.name in written) && !explicit.has(dep.name)) map[dep.name] = [`dep:${dep.name}`]
  }
  const used = new Set()
  for (const [feature, list] of Object.entries(map)) {
    for (const item of list) {
      const fail = (why) => {
        throw new LockfileError(`${quote(item)} ${why}`, at(where, feature))
      }
      const { dep, feature: named, weak } = featureValue(item)
      if (dep === undefined) {
        if (named in written) continue
        if (!optionalDep.has(named)) fail('is neither a feature nor a dependency')
        if (!optionalDep.get(named)) fail('is a dependency, but not an optional one')
        if (!(named in map)) fail(`is an optional dependency with no feature of its name: use "dep:${named}"`)
        continue
      }
      used.add(dep)
      if (named?.includes('/')) fail('has more than one "/"')
      if (dep.startsWith('dep:')) fail('has both "dep:" and "/"')
      if (!optionalDep.has(dep)) fail(`names ${quote(dep)}, which is not a dependency`)
      if ((named === undefined || weak) && !optionalDep.get(dep)) fail(`names ${quote(dep)}, which is not an optional dependency`)
    }
  }
  const unused = [...optionalDep].find(([name, isOptional]) => isOptional && !used.has(name))
  if (unused !== undefined) throw new LockfileError(`optional dependency ${quote(unused[0])} is in no feature: add "dep:${unused[0]}" to one`, where)
  return map
}
