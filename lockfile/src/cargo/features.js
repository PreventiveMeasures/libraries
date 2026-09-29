// The features a build turns on, by cargo's feature resolver
// (core/resolver/features.rs), over the graph linkCargo lays out. Resolver 2
// and 3 keep apart what is built for the host (build scripts, proc-macros
// and what they depend on) and what for the target, and leave out
// dependencies for platforms not built for, and the roots' dev-dependencies
// where no dev target is built. Resolver 1 does none of that: a package has
// one set of features, unified across all of it.
//
// It walks only the declarations the build's own resolve turns on
// (resolve.js), as cargo's walks the graph its dependency resolver gives
// it: less than the lockfile has where the command line asks for less than
// every feature, and more is refused, where cargo would resolve anew.

import { LockfileError, quote } from '../error.js'
import { membersWithFeatures } from './command.js'
import { featureValue } from './featuremap.js'
import { activate } from './resolve.js'
import { parseCfg, parsePlatform, platformMatches } from './platform.js'

function readPlatform(value, where) {
  if (typeof value?.name !== 'string' || !Array.isArray(value.cfg)) throw new TypeError(`expected ${where} as { name, cfg }`)
  return { name: value.name, cfg: new Set(value.cfg.map((line) => parseCfg(line, where))) }
}

function setOf(map, key) {
  if (!map.has(key)) map.set(key, new Set())
  return map.get(key)
}

// Cargo's FeatureResolver, method for method. `fk` is what a package is
// built for, `normal` or `host`; the features found are kept by `saved(fk)`,
// which is `normal` alone where resolver 1 unifies the two.
class FeatureResolver {
  constructor(graph, targeted, options) {
    this.graph = graph
    this.targeted = targeted
    const all = options.targets === 'all'
    this.host = all ? undefined : readPlatform(options.host, 'host')
    this.targets = all ? [] : (options.targets ?? [options.host]).map((target, index) => readPlatform(target, `targets[${index}]`))
    this.decoupleHost = graph.resolver >= 2
    this.decoupleDev = graph.resolver >= 2 && options.dev !== true
    this.ignoreInactive = graph.resolver >= 2 && !all
    this.trackForHost = this.decoupleHost || this.ignoreInactive
    this.platforms = new Map()
    this.activated = new Map()
    this.activatedDeps = new Map()
    this.processed = new Set()
    this.deferred = new Map()
  }

  saved(fk) {
    return this.decoupleHost ? fk : 'normal'
  }

  enabled(key, fk) {
    return setOf(this.activated, `${this.saved(fk)} ${key}`)
  }

  features(key) {
    return this.graph.packages[key].manifest.features
  }

  // The declarations of `key` in the build for `fk`, each with what the
  // package it resolves to is built for: those the build's resolve turns
  // on, less what it does not build.
  deps(key, fk) {
    const list = []
    for (const dep of this.graph.packages[key].dependencies) {
      if (!this.targeted.has(dep) || (dep.kind === 'dev' && this.decoupleDev)) continue
      if (dep.target !== undefined && this.ignoreInactive && !this.activeFor(dep, fk)) continue
      const hostDep = fk !== 'host' && this.trackForHost && (dep.kind === 'build' || this.graph.packages[dep.resolved].manifest.procMacro)
      list.push({ dep, depFk: hostDep ? 'host' : fk })
    }
    return list
  }

  activeFor(dep, fk) {
    if (!this.platforms.has(dep.target)) this.platforms.set(dep.target, parsePlatform(dep.target))
    const platform = this.platforms.get(dep.target)
    if (dep.kind === 'build' || fk === 'host') return platformMatches(platform, this.host)
    return this.targets.some((target) => platformMatches(platform, target))
  }

  // A feature asked of a package from outside it, which it has to have.
  request(key, fk, feature, asker) {
    if (!(feature in this.features(key))) throw new LockfileError(`${quote(feature)} is asked of ${quote(key)}, which has no such feature`, asker)
    this.activateRec(key, fk, feature)
  }

  requestsOf(dep) {
    return dep.defaultFeatures && 'default' in this.features(dep.resolved) ? [...dep.features, 'default'] : dep.features
  }

  activatePkg(key, fk, requests, asker) {
    this.enabled(key, fk)
    for (const feature of requests) this.request(key, fk, feature, asker)
    if (this.processed.has(`${fk} ${key}`)) return
    this.processed.add(`${fk} ${key}`)
    for (const { dep, depFk } of this.deps(key, fk)) {
      if (!dep.optional) this.activatePkg(dep.resolved, depFk, this.requestsOf(dep), key)
    }
  }

  activateValue(key, fk, value) {
    if (value.dep === undefined) this.activateRec(key, fk, value.feature)
    else if (value.feature === undefined) this.activateDependency(key, fk, value.dep)
    else this.activateDepFeature(key, fk, value.dep, value.feature, value.weak)
  }

  activateRec(key, fk, feature) {
    const set = this.enabled(key, fk)
    if (set.has(feature)) return
    set.add(feature)
    const list = this.features(key)[feature] ?? []
    if (list.includes(feature)) throw new LockfileError(`feature ${quote(feature)} enables itself, which cargo refuses`, key)
    for (const item of list) this.activateValue(key, fk, featureValue(item))
  }

  activateDependency(key, fk, name) {
    setOf(this.activatedDeps, `${this.saved(fk)} ${key}`).add(name)
    const waiting = this.deferred.get(`${fk} ${key} ${name}`) ?? []
    this.deferred.delete(`${fk} ${key} ${name}`)
    for (const { dep, depFk } of this.deps(key, fk)) {
      if (dep.name !== name) continue
      for (const feature of waiting) this.request(dep.resolved, depFk, feature, key)
      this.activatePkg(dep.resolved, depFk, this.requestsOf(dep), key)
    }
  }

  // `name/feature`, and `name?/feature`, which waits for `name` to be
  // turned on by something else.
  activateDepFeature(key, fk, name, feature, weak) {
    for (const { dep, depFk } of this.deps(key, fk)) {
      if (dep.name !== name) continue
      if (dep.optional) {
        if (weak && !this.activatedDeps.get(`${this.saved(fk)} ${key}`)?.has(name)) {
          setOf(this.deferred, `${fk} ${key} ${name}`).add(feature)
          continue
        }
        this.activateDependency(key, fk, name)
        if (!weak && name in this.features(key)) this.activateRec(key, fk, name)
      }
      this.request(dep.resolved, depFk, feature, key)
    }
  }

  // A proc-macro root is built for the host, and for the target too where
  // it has more targets than its library.
  resolveRoot(key, values) {
    const fks = this.trackForHost && this.graph.packages[key].manifest.procMacroTarget ? ['normal', 'host'] : ['normal']
    for (const fk of fks) {
      this.enabled(key, fk)
      for (const value of values) this.activateValue(key, fk, value)
      this.activatePkg(key, fk, [], 'roots')
    }
  }

  result() {
    const result = Object.create(null)
    for (const key of Object.keys(this.graph.packages)) {
      const [normal, host] = ['normal', 'host'].map((fk) => (this.activated.has(`${fk} ${key}`) ? [...this.activated.get(`${fk} ${key}`)].sort() : undefined))
      if (normal !== undefined || host !== undefined) result[key] = { normal, host }
    }
    return result
  }
}

// What the command line asks of a root, checked as cargo's dependency
// resolver checks it: a feature the root has, or a feature of a dependency
// it has.
function rootValues(pkg, key, asked) {
  const map = pkg.manifest.features
  const values = []
  for (const value of asked.values) {
    const text = value.dep === undefined ? value.feature : `${value.dep}${value.weak ? '?' : ''}/${value.feature}`
    if (value.dep === undefined && !(value.feature in map)) throw new LockfileError(`${quote(key)} has no feature ${quote(text)}`, 'features')
    if (value.dep !== undefined && !pkg.dependencies.some((dep) => dep.name === value.dep)) throw new LockfileError(`${quote(key)} has no dependency ${quote(value.dep)}`, 'features')
    values.push(value)
  }
  if (asked.defaultFeatures && 'default' in map) values.push({ dep: undefined, feature: 'default', weak: false })
  if (asked.allFeatures) values.push(...Object.keys(map).map((feature) => ({ dep: undefined, feature, weak: false })))
  return values
}

export function resolveCargoFeatures(graph, options) {
  if (typeof options !== 'object' || options === null) throw new TypeError('expected the build')
  const roots = new Map([...membersWithFeatures(graph, options)].map(([key, asked]) => [key, rootValues(graph.packages[key], key, asked)]))
  const why = (dep) => `the build turns on ${quote(dep.name)}, which the lockfile does not resolve to one package, and cargo would anew`
  const resolver = new FeatureResolver(graph, activate(graph.packages, roots, why), options)
  for (const [key, values] of roots) resolver.resolveRoot(key, values)
  return resolver.result()
}
