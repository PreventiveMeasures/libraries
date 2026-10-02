// Cargo's dependency resolver over the lockfile's edges: which declarations
// it turns on. Unlike the feature resolver, a package has one set of
// features however it is reached, and `name?/feature` turns `name` on. A
// root's dev-dependencies get only the root's own request, as cargo resolves
// them once, with it.

import { LockfileError, quote } from '../error.js'
import { featureValue } from './dependency.js'

export function setOf(map, key) {
  if (!map.has(key)) map.set(key, new Set())
  return map.get(key)
}

export function requestsOf(packages, dep) {
  return dep.defaultFeatures && 'default' in packages[dep.resolved].manifest.features ? [...dep.features, 'default'] : dep.features
}

// `enabled`: the optional dependencies turned on; `asked`: the features
// asked of each dependency, by name.
const request = () => ({ features: new Set(), enabled: new Set(), asked: new Map() })

class Activation {
  constructor(packages, why) {
    this.packages = packages
    this.why = why
    this.requests = new Map()
    this.active = new Set()
    this.dirty = new Set()
  }

  requestOf(key) {
    if (!this.requests.has(key)) {
      this.requests.set(key, request())
      this.dirty.add(key)
    }
    return this.requests.get(key)
  }

  require(key, into, feature, asker) {
    const map = this.packages[key].manifest.features
    if (!(feature in map)) throw new LockfileError(`${quote(feature)} is asked of ${quote(key)}, which has no such feature`, asker)
    if (into.features.has(feature)) return
    into.features.add(feature)
    this.dirty.add(key)
    if (map[feature].includes(feature)) throw new LockfileError(`feature ${quote(feature)} enables itself, which cargo refuses`, key)
    for (const item of map[feature]) this.requireValue(key, into, featureValue(item), key)
  }

  // `name/feature` turns on `name`, and its feature of that name where it
  // has one; `name?/feature` only `name`.
  requireValue(key, into, value, asker) {
    if (value.dep === undefined) return this.require(key, into, value.feature, asker)
    const { features, dependencies } = this.packages[key].manifest
    const isOptional = dependencies.some((dep) => dep.name === value.dep && dep.optional)
    if (value.feature !== undefined && !value.weak && isOptional && value.dep in features) this.require(key, into, value.dep, asker)
    into.enabled.add(value.dep)
    if (value.feature !== undefined) setOf(into.asked, value.dep).add(value.feature)
    this.dirty.add(key)
  }

  ask(dep, extra, key) {
    if (dep.resolved === undefined) throw new LockfileError(this.why(dep, key), key)
    this.active.add(dep)
    const target = this.requestOf(dep.resolved)
    for (const feature of [...requestsOf(this.packages, dep), ...extra]) this.require(dep.resolved, target, feature, key)
  }

  run(roots) {
    for (const [key, values] of roots) {
      const [own, union] = [request(), this.requestOf(key)]
      for (const value of values) {
        this.requireValue(key, own, value, 'features')
        this.requireValue(key, union, value, 'features')
      }
      for (const dep of this.packages[key].dependencies) {
        if (dep.kind === 'dev') this.ask(dep, own.asked.get(dep.name) ?? [], key)
      }
    }
    while (this.dirty.size > 0) {
      const key = this.dirty.values().next().value
      this.dirty.delete(key)
      const union = this.requestOf(key)
      for (const dep of this.packages[key].dependencies) {
        if (dep.kind === 'dev' || (dep.optional && !union.enabled.has(dep.name))) continue
        this.ask(dep, union.asked.get(dep.name) ?? [], key)
      }
    }
    return this.active
  }
}

// `why(dep, key)` words the refusal of a declaration turned on that is not
// one package of the lockfile.
export function activate(packages, roots, why) {
  return new Activation(packages, why).run(roots)
}
