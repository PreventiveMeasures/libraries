// A package's features, as cargo's feature map holds them, and the values
// in a feature's list.

import { LockfileError, at, quote } from '../error.js'
import { checkFeature, entries, strings } from './shape.js'

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
  for (const [name, list, here] of entries(value ?? Object.create(null), where)) written[checkFeature(name, here)] = strings(list, here)
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
