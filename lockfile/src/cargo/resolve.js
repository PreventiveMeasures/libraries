// Which declarations cargo's dependency resolver turns on, from the roots
// and what each is asked for: the lockfile's resolve, with every member
// asked for every feature, or a build's, with what its command line asks.
//
// A package has one set of features however it is reached, and a
// declaration is turned on where it is not optional, or a feature in that
// set turns it on; a weak `name?/feature` turns it on here, as it does
// there. A root's dev-dependencies are turned on too, and asked only for
// what the root's own request asks of them: cargo resolves a root's
// dev-dependencies when it takes the root's request, and never again.
//
// Refused, as cargo's resolver refuses it: a feature asked of a package
// that has none such, a feature that enables itself. Refused, as it would
// be read two ways: a declaration turned on that is not one package of the
// lockfile, where cargo would resolve it anew or could take either.

import { LockfileError, quote } from '../error.js'
import { featureValue } from './featuremap.js'

export function setOf(map, key) {
  if (!map.has(key)) map.set(key, new Set())
  return map.get(key)
}

// What a package is asked for, and what that turns on: its features, the
// optional dependencies turned on, and the features asked of each
// dependency, by name.
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

  // Adds `feature`, and what it enables, to what `into` asks of `key`.
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
    if (value.dep === undefined) {
      this.require(key, into, value.feature, asker)
      return
    }
    const { features, dependencies } = this.packages[key].manifest
    const isOptional = dependencies.some((dep) => dep.name === value.dep && dep.optional)
    if (value.feature !== undefined && !value.weak && isOptional && value.dep in features) this.require(key, into, value.dep, asker)
    into.enabled.add(value.dep)
    if (value.feature !== undefined) setOf(into.asked, value.dep).add(value.feature)
    this.dirty.add(key)
  }

  // Asks `dep`'s package for what `dep` and `extra` ask.
  ask(dep, extra, key) {
    if (dep.resolved === undefined) throw new LockfileError(this.why(dep), key)
    this.active.add(dep)
    const target = this.requestOf(dep.resolved)
    const defaults = dep.defaultFeatures && 'default' in this.packages[dep.resolved].manifest.features ? ['default'] : []
    for (const feature of [...dep.features, ...defaults, ...extra]) this.require(dep.resolved, target, feature, key)
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

// `roots` is by key, what each is asked for as feature values; `why` says
// why a declaration turned on that is not one package of the lockfile is
// refused. Gives the declarations turned on.
export function activate(packages, roots, why) {
  return new Activation(packages, why).run(roots)
}
