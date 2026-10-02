// Cargo's feature resolver (core/resolver/features.rs) over linkCargo's
// graph. Resolver 2 and 3 keep host and target apart, and leave out
// platforms not built for and dev-dependencies not built; resolver 1
// unifies it all. It walks only what the build's own resolve turns on
// (activate.js); more is refused, as cargo would resolve it anew.

import { parsePlatform, platformMatches } from '../crate/cargo-platform.js'
import { LockfileError, quote } from '../error.js'
import { checkOptions } from '../shape.js'
import { featureValue } from './dependency.js'
import { activate, requestsOf, setOf } from './activate.js'
import { readPlatform, undecided } from './platform.js'

// Cargo's Workspace::members_with_features. A virtual workspace, or resolver
// 2 or 3, gives each selected member the features it has, `member/feature`
// and `dependency/feature`. Resolver 1 with a root package gives
// `--features` to the current package, resolved even where not selected,
// and `member/feature` to the other selected members, which keep their
// default features.

function parseFeatures(features) {
  if (!Array.isArray(features) || !features.every((item) => typeof item === 'string')) throw new TypeError('expected the features as strings')
  const texts = [...new Set(features.flatMap((item) => item.split(/[\p{White_Space},]+/u)).filter(Boolean))]
  return texts.map((text) => {
    const value = featureValue(text)
    if (value.feature === undefined) throw new LockfileError(`${quote(text)}: \`dep:\` is not taken on the command line`, 'features')
    if (value.dep !== undefined && value.feature.includes('/')) throw new LockfileError(`${quote(text)} has more than one "/"`, 'features')
    return { text, ...value }
  })
}

// The declaration of each name cargo's summary keeps last: the top tables
// (dependencies, dev-, build-), then each platform's in order
// (dependencies, build-, dev-).
function lastDeclared(pkg) {
  const rank = (dep) => (dep.target === undefined ? ['normal', 'dev', 'build'] : ['normal', 'build', 'dev']).indexOf(dep.kind)
  // No platform is empty, so the top tables' '' comes first.
  const order = pkg.dependencies.toSorted((a, b) => {
    const [x, y] = [a.target ?? '', b.target ?? '']
    return x === y ? rank(a) - rank(b) : (x < y ? -1 : 1)
  })
  return new Map(order.map((dep) => [dep.name, dep]))
}

function matching(pkg, values, found) {
  const deps = lastDeclared(pkg)
  const has = (feature) => feature in pkg.features || deps.get(feature)?.optional === true
  const take = (value) => {
    if (value.dep === undefined) return has(value.feature) ? value : undefined
    if (deps.has(value.dep)) return value
    return value.dep === pkg.name && has(value.feature) ? featureValue(value.feature) : undefined
  }
  return values.flatMap((value) => {
    const taken = take(value)
    if (taken === undefined) return []
    found.add(value.text)
    return [taken]
  })
}

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
  const isSpecific = (value) => value.dep !== undefined && graph.members.some((key) => key !== current && nameOf(key) === value.dep) && selected.some((key) => nameOf(key) === value.dep)
  const specific = Map.groupBy(values.filter(isSpecific), (value) => value.dep)
  for (const key of graph.members) {
    if (key === current) result.set(key, [values.filter((value) => !isSpecific(value)), !options.noDefaultFeatures])
    else if (selected.includes(key)) result.set(key, [(specific.get(nameOf(key)) ?? []).map((value) => featureValue(value.feature)), true])
  }
  return result
}

// A dependency a member lacks is refused here, as cargo's resolver refuses
// it; a feature it lacks only where the resolve comes to it.
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

// What a table the platforms leave undecided is taken as: on, for what a
// build may turn on, or off, for what it turns on for certain. Given only
// with platforms, and needed where one is known in part.
function readUndecided(options, platforms) {
  const { undecided: given } = options
  if (given === undefined) {
    if (platforms.some(undecided)) throw new TypeError("expected `undecided`, 'on' or 'off', as a platform leaves cfgs undecided")
    return false
  }
  if (given !== 'on' && given !== 'off') throw new TypeError("expected `undecided` to be 'on' or 'off'")
  if (options.targets === 'all') throw new TypeError("expected no `undecided` with targets 'all', which reads every platform")
  return given === 'on'
}

// Cargo's FeatureResolver, method for method. `fk` is what a package is
// built for, `normal` or `host`; `saved(fk)` is `normal` alone where
// resolver 1 unifies the two.
class FeatureResolver {
  constructor(graph, targeted, options) {
    this.graph = graph
    this.targeted = targeted
    const all = options.targets === 'all'
    this.host = all ? undefined : readPlatform(options.host, 'host')
    this.targets = all ? [] : (options.targets?.length > 0 ? options.targets : [options.host]).map((target, index) => readPlatform(target, `targets[${index}]`))
    this.undecided = readUndecided(options, all ? [] : [this.host, ...this.targets])
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

  deps(key, fk) {
    return this.graph.packages[key].dependencies
      .filter((dep) => this.targeted.has(dep) && !(dep.kind === 'dev' && this.decoupleDev) && (dep.target === undefined || !this.ignoreInactive || this.activeFor(dep, fk)))
      .map((dep) => ({ dep, depFk: this.trackForHost && this.forHost(dep) ? 'host' : fk }))
  }

  forHost(dep) {
    return dep.kind === 'build' || this.graph.packages[dep.resolved].manifest.procMacro
  }

  activeFor(dep, fk) {
    if (!this.platforms.has(dep.target)) this.platforms.set(dep.target, parsePlatform(dep.target))
    const platform = this.platforms.get(dep.target)
    const holds = (target) => platformMatches(platform, target) ?? this.undecided
    if (dep.kind === 'build' || fk === 'host') return holds(this.host)
    return this.targets.some(holds)
  }

  request(key, fk, feature, asker) {
    if (!(feature in this.features(key))) throw new LockfileError(`${quote(feature)} is asked of ${quote(key)}, which has no such feature`, asker)
    this.activateRec(key, fk, feature)
  }

  activatePkg(key, fk, requests, asker) {
    for (const feature of requests) this.request(key, fk, feature, asker)
    if (this.processed.has(`${fk} ${key}`)) return
    this.processed.add(`${fk} ${key}`)
    for (const { dep, depFk } of this.deps(key, fk)) {
      if (!dep.optional) this.activatePkg(dep.resolved, depFk, requestsOf(this.graph.packages, dep), key)
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
    for (const { dep, depFk } of this.deps(key, fk).filter((item) => item.dep.name === name)) {
      for (const feature of waiting) this.request(dep.resolved, depFk, feature, key)
      this.activatePkg(dep.resolved, depFk, requestsOf(this.graph.packages, dep), key)
    }
  }

  // `name?/feature` waits for something else to turn `name` on.
  activateDepFeature(key, fk, name, feature, weak) {
    for (const { dep, depFk } of this.deps(key, fk).filter((item) => item.dep.name === name)) {
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

  // But built for the host only where its library is a proc-macro, or where
  // dev targets are built and one is a proc-macro, which pulls the library
  // along; and for the target too, in case it has more targets.
  builtKinds(key) {
    const { procMacro, procMacroTarget } = this.graph.packages[key].manifest
    return procMacro || (procMacroTarget && this.dev) ? ['normal', 'host'] : ['normal']
  }

  // A root with any proc-macro target is resolved for the host too.
  resolveRoot(key, values) {
    for (const fk of this.trackForHost && this.graph.packages[key].manifest.procMacroTarget ? ['normal', 'host'] : ['normal']) {
      for (const value of values) this.activateValue(key, fk, value)
      this.activatePkg(key, fk, [], 'roots')
    }
  }

  // What cargo's unit graph reaches from `starts`, along what `follow` takes;
  // dev-dependencies only from a start's own targets.
  reach(starts, follow) {
    const reached = new Map()
    const visit = (key, fk) => {
      if (!reached.has(`${fk} ${key}`)) reached.set(`${fk} ${key}`, [key, fk])
    }
    for (const [key, fk] of starts) visit(key, fk)
    const own = new Set(reached.keys())
    for (const [key, fk] of reached.values()) {
      const on = this.activatedDeps.get(`${this.saved(fk)} ${key}`)
      for (const dep of this.graph.packages[key].dependencies) {
        if (!this.targeted.has(dep) || (dep.optional && !on?.has(dep.name))) continue
        if (dep.kind === 'dev' && !(this.dev && own.has(`${fk} ${key}`))) continue
        if (dep.target !== undefined && this.host !== undefined && !this.activeFor(dep, fk)) continue
        if (follow(key, dep)) visit(dep.resolved, fk === 'host' || this.forHost(dep) ? 'host' : 'normal')
      }
    }
    return reached
  }

  // Listed from the packages built, which under resolver 1 may be fewer than
  // the roots resolved. Two names for one package are looked for from each
  // member's library or binary, and its tests where dev targets are built, not
  // from what is listed for the target in case a proc-macro has more targets.
  result(built) {
    const libraries = built.map((key) => [key, this.graph.packages[key].manifest.procMacro ? 'host' : 'normal'])
    this.reach(libraries, (key, dep) => this.checkNamed(key, dep))
    const reached = this.reach(built.flatMap((key) => this.builtKinds(key).map((fk) => [key, fk])), () => true)
    const result = Object.create(null)
    for (const key of Object.keys(this.graph.packages)) {
      const [normal, host] = ['normal', 'host'].map((fk) => (reached.has(`${fk} ${key}`) ? [...this.enabled(key, fk)].sort() : undefined))
      if (normal !== undefined || host !== undefined) result[key] = { normal, host }
    }
    return result
  }

  // Cargo refuses to build a crate whose declarations the build turns on, of
  // any kind or platform, name one package two ways, `-` read as `_`. The
  // library is taken to be named after its package.
  checkNamed(key, dep) {
    const named = (item) => item.name.replaceAll('-', '_')
    const other = this.graph.packages[key].dependencies.find((item) => this.targeted.has(item) && item.resolved === dep.resolved && named(item) !== named(dep))
    if (other !== undefined) throw new LockfileError(`depends on ${quote(dep.resolved)} as both ${quote(dep.name)} and ${quote(other.name)}, which cargo refuses to build`, key)
    return true
  }
}

export function resolveCargoFeatures(graph, options) {
  checkOptions(options, ['packages', 'features', 'allFeatures', 'noDefaultFeatures', 'current', 'dev', 'host', 'targets', 'undecided'])
  const roots = membersWithFeatures(graph, options)
  const why = (dep) => `the build turns on ${quote(dep.name)}, which the lockfile does not resolve to one package, and cargo would anew`
  const resolver = new FeatureResolver(graph, activate(graph.packages, roots, why), options)
  for (const [key, values] of roots) resolver.resolveRoot(key, values)
  return resolver.result(options.packages)
}
