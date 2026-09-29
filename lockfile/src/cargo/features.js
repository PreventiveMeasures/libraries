// The features a build turns on, by cargo's feature resolver
// (core/resolver/features.rs), over the graph linkCargo lays out. Resolver 2
// and 3 keep apart what is built for the host (build scripts, proc-macros
// and what they depend on) and what for the target, and leave out
// dependencies for platforms not built for, and the roots' dev-dependencies
// where no dev target is built. Resolver 1 does none of that: a package has
// one set of features, unified across all of it.
//
// It walks only the declarations the build's own resolve turns on
// (graph.js), as cargo's walks the graph its dependency resolver gives
// it: less than the lockfile has where the command line asks for less than
// every feature, and more is refused, where cargo would resolve anew.

import { LockfileError, quote } from '../error.js'
import { featureValue } from './dependency.js'
import { activate, setOf } from './graph.js'
import { parseCfg, parsePlatform, platformMatches } from './syntax.js'

// What cargo's command line asks of each member it builds: `-p`, and
// `--features`, `--all-features` and `--no-default-features` handed out as
// cargo's Workspace::members_with_features does. A virtual workspace, or
// resolver 2 or 3, gives each selected member the features it has,
// `member/feature` as its own, and `dependency/feature` where it has that
// dependency. Resolver 1 with a root package gives `--features` to the
// package cargo runs in, which is resolved whether selected or not, and
// `member/feature` to the other members selected, which keep their default
// features.

const SPACE = /\p{White_Space}+/u

function parseFeatures(features) {
  if (!Array.isArray(features) || !features.every((item) => typeof item === 'string')) throw new TypeError('expected the features as strings')
  const texts = [...new Set(features.flatMap((item) => item.split(SPACE)).flatMap((item) => item.split(',')).filter(Boolean))]
  return texts.map((text) => {
    const value = featureValue(text)
    if (value.feature === undefined) throw new LockfileError(`${quote(text)}: \`dep:\` is not taken on the command line`, 'features')
    if (value.dep !== undefined && value.feature.includes('/')) throw new LockfileError(`${quote(text)} has more than one "/"`, 'features')
    return { text, ...value }
  })
}

// A name's dependency as cargo's summary keeps it last: the top tables,
// then each platform's in order, dependencies before build- and
// dev-dependencies there.
function lastDeclared(pkg) {
  const rank = (dep) => (dep.target === undefined ? ['normal', 'dev', 'build'] : ['normal', 'build', 'dev']).indexOf(dep.kind)
  const order = [...pkg.dependencies].sort((a, b) => {
    if ((a.target === undefined) !== (b.target === undefined)) return a.target === undefined ? -1 : 1
    if (a.target !== b.target) return a.target < b.target ? -1 : 1
    return rank(a) - rank(b)
  })
  return new Map(order.map((dep) => [dep.name, dep]))
}

// What of the command line a member takes: a feature it has, a feature of
// a dependency it has, and `member/feature` as its own feature.
function matching(pkg, values, found) {
  const deps = lastDeclared(pkg)
  const has = (feature) => feature in pkg.features || deps.get(feature)?.optional === true
  const take = (value) => {
    if (value.dep === undefined) return has(value.feature) ? value : undefined
    if (deps.has(value.dep)) return value
    return value.dep === pkg.name && has(value.feature) ? featureValue(value.feature) : undefined
  }
  const own = []
  for (const value of values) {
    const taken = take(value)
    if (taken === undefined) continue
    own.push(taken)
    found.add(value.text)
  }
  return own
}

// Each member's share of `--features`, and whether it keeps its default
// features.
function share(graph, values, selected, options) {
  const result = new Map()
  if (graph.root === undefined || graph.resolver >= 2) {
    const found = new Set()
    for (const key of selected) result.set(key, [matching(graph.packages[key].manifest, values, found), !options.noDefaultFeatures])
    const unknown = values.filter((value) => !found.has(value.text))
    if (unknown.length > 0) throw new LockfileError(`no package selected has ${unknown.map((value) => quote(value.text)).join(', ')}`, 'features')
    return result
  }
  const current = options.current ?? graph.root
  if (!graph.members.includes(current)) throw new LockfileError(`${quote(current)} is not a member of the workspace`, 'current')
  const nameOf = (key) => graph.packages[key].name
  const specific = new Map()
  const cwd = []
  for (const value of values) {
    const member = value.dep !== undefined && graph.members.some((key) => key !== current && nameOf(key) === value.dep)
    if (member && selected.some((key) => nameOf(key) === value.dep)) specific.set(value.dep, [...(specific.get(value.dep) ?? []), featureValue(value.feature)])
    else cwd.push(value)
  }
  for (const key of graph.members) {
    if (key === current) result.set(key, [cwd, !options.noDefaultFeatures])
    else if (selected.includes(key)) result.set(key, [specific.get(nameOf(key)) ?? [], true])
  }
  return result
}

// By member built, the feature values it is asked for: its share of
// `--features`, then its default features and all of them where the flags
// say so. A dependency it lacks is refused, as cargo's resolver refuses it;
// a feature it lacks, where the resolve comes to it.
function membersWithFeatures(graph, options) {
  const { packages } = options
  if (!Array.isArray(packages) || packages.length === 0) throw new TypeError('expected the packages built, as keys of members')
  for (const key of packages) {
    if (!graph.members.includes(key)) throw new LockfileError(`${quote(key)} is not a member of the workspace`, 'packages')
  }
  const selected = graph.members.filter((key) => packages.includes(key))
  const roots = new Map()
  for (const [key, [values, defaults]] of share(graph, parseFeatures(options.features ?? []), selected, options)) {
    const { features, dependencies } = graph.packages[key].manifest
    const missing = values.find((value) => value.dep !== undefined && !dependencies.some((dep) => dep.name === value.dep))
    if (missing !== undefined) throw new LockfileError(`${quote(key)} has no dependency ${quote(missing.dep)}`, 'features')
    const flagged = [...(defaults && 'default' in features ? ['default'] : []), ...(options.allFeatures ? Object.keys(features) : [])]
    roots.set(key, [...values, ...flagged.map(featureValue)])
  }
  return roots
}

function readPlatform(value, where) {
  if (typeof value?.name !== 'string' || !Array.isArray(value.cfg)) throw new TypeError(`expected ${where} as { name, cfg }`)
  return { name: value.name, cfg: new Set(value.cfg.map((line) => parseCfg(line, where))) }
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
    this.dev = options.dev === true
    this.decoupleHost = graph.resolver >= 2
    this.decoupleDev = graph.resolver >= 2 && !this.dev
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
  kindsOf(key) {
    return this.graph.packages[key].manifest.procMacroTarget ? ['normal', 'host'] : ['normal']
  }

  resolveRoot(key, values) {
    for (const fk of this.trackForHost ? this.kindsOf(key) : ['normal']) {
      for (const value of values) this.activateValue(key, fk, value)
      this.activatePkg(key, fk, [], 'roots')
    }
  }

  // What the build compiles, as cargo's unit graph reaches it: from the
  // roots, along what the build's resolve turns on, for the platforms built,
  // and to dev-dependencies only from a root's own targets, which are for the
  // host too where it is a proc-macro. The resolver walks more under
  // resolver 1, and so gives packages features that are not built; each
  // package built has its features whatever the resolver.
  result(roots) {
    const reached = new Map()
    const visit = (key, fk) => {
      if (!reached.has(`${fk} ${key}`)) reached.set(`${fk} ${key}`, [key, fk])
    }
    for (const key of roots.keys()) for (const fk of this.kindsOf(key)) visit(key, fk)
    const own = new Set(reached.keys())
    for (const [key, fk] of reached.values()) {
      const on = this.activatedDeps.get(`${this.saved(fk)} ${key}`)
      for (const dep of this.graph.packages[key].dependencies) {
        if (!this.targeted.has(dep) || (dep.optional && !on?.has(dep.name))) continue
        if (dep.kind === 'dev' && !(this.dev && own.has(`${fk} ${key}`))) continue
        if (dep.target !== undefined && this.host !== undefined && !this.activeFor(dep, fk)) continue
        visit(dep.resolved, fk === 'host' || dep.kind === 'build' || this.graph.packages[dep.resolved].manifest.procMacro ? 'host' : 'normal')
      }
    }
    const result = Object.create(null)
    for (const key of Object.keys(this.graph.packages)) {
      const [normal, host] = ['normal', 'host'].map((fk) => (reached.has(`${fk} ${key}`) ? [...this.enabled(key, fk)].sort() : undefined))
      if (normal !== undefined || host !== undefined) result[key] = { normal, host }
    }
    return result
  }
}

export function resolveCargoFeatures(graph, options) {
  if (typeof options !== 'object' || options === null) throw new TypeError('expected the build')
  const roots = membersWithFeatures(graph, options)
  const why = (dep) => `the build turns on ${quote(dep.name)}, which the lockfile does not resolve to one package, and cargo would anew`
  const resolver = new FeatureResolver(graph, activate(graph.packages, roots, why), options)
  for (const [key, values] of roots) resolver.resolveRoot(key, values)
  return resolver.result(roots)
}
