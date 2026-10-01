// The lockfile's graph with each package's manifest laid over it: every
// dependency a manifest declares, with the package the lockfile resolves
// it to. The lockfile names only packages; which declaration an edge is,
// of which kind, for which platform, asking for which features, is the
// manifest's. Cargo ties the two together by name, version requirement and
// source; so does this, and refuses where it cannot do so one way only:
// a declaration two edges could be, an edge no declaration is, a
// declaration the lockfile should resolve and does not, a package no member
// depends on, which cargo would have pruned. A declaration is
// active where the lockfile's resolve, every member's every feature on,
// turns it on; the lockfile's edges are the active declarations'.

import { LockfileError, at, quote } from '../error.js'
import { featureValue } from './dependency.js'
import { ANY_REGISTRY, parseLockSource, patchKey, patchedAs, sourceIdentity } from './lock.js'
import { matches, parseRequirement, parseVersion } from './syntax.js'

const PATH = 'path'

// The resolver the workspace root asks for, or its edition's.
function resolverOf(root) {
  const edition = root.package?.edition
  const byEdition = edition === '2024' ? 3 : edition === '2021' ? 2 : 1
  return root.workspace?.resolver ?? root.package?.resolver ?? byEdition
}

const within = (requirement, version) => requirement === undefined || matches(requirement, parseVersion(version))

// Whether a package of `identity`, written in the lockfile as `source`, is
// from `wanted`: that very source, or any registry where a registry is
// known by its name alone.
const from = (wanted, identity, source) => identity === wanted || (wanted === ANY_REGISTRY && source !== undefined && !source.startsWith('git+'))

// What a [patch] offers: the package, from the source it offers it from, of
// the versions its requirement takes there, as cargo refuses a patch whose
// location has none of them; by `target`, the source it patches and the
// package's name. Cargo refuses too a patch from the source it patches,
// whatever the git reference; a path's place only a filesystem tells.
function readPatches(root) {
  return Object.entries(root.patch).flatMap(([key, specs]) => Object.entries(specs).map(([name, spec]) => {
    const where = at(at('patch', key), name)
    if (patchedAs(spec.source) === patchKey(key)) throw new LockfileError('patches its source with itself, which cargo refuses', where)
    const requirement = spec.version === undefined ? undefined : parseRequirement(spec.version, where)
    return { target: `${patchKey(key)} ${spec.package}`, package: spec.package, identity: sourceIdentity(spec.source, PATH), requirement, where }
  }))
}

// Cargo resolves every patch, used or not, and keeps in the lockfile the
// package of each: among the packages where it is used, and where not, once
// under [[patch.unused]] for each patch that offers it, so twice for one
// two tables offer. So each patch is used, or takes an unused entry of its
// own, and none is left over.
function checkPatches(lock, identities, patches) {
  const offers = (patch, name, version, identity, source) => name === patch.package && from(patch.identity, identity, source) && within(patch.requirement, version)
  const unused = lock.unusedPatches.map((item) => ({ ...item, identity: item.source === undefined ? PATH : parseLockSource(item.source, 'patch.unused', false).identity }))
  // Which patch takes each entry, matched so that a patch taking any entry
  // of its version leaves another patch the one it alone can take.
  const taker = unused.map(() => undefined)
  const take = (patch, seen) => unused.some((item, index) => {
    if (seen.has(index) || !offers(patch, item.name, item.version, item.identity, item.source)) return false
    seen.add(index)
    if (taker[index] !== undefined && !take(taker[index], seen)) return false
    taker[index] = patch
    return true
  })
  for (const patch of patches) {
    if (Object.entries(lock.packages).some(([key, pkg]) => offers(patch, pkg.name, pkg.version, identities[key], pkg.source))) continue
    if (!take(patch, new Set())) throw new LockfileError('the lockfile has no package this patch offers, used or unused: is it out of date?', patch.where)
  }
  const stray = unused.find((item, index) => taker[index] === undefined)
  if (stray !== undefined) throw new LockfileError(`the lockfile lists ${quote(`${stray.name} ${stray.version}`)} unused where no [patch] does: is it out of date?`, 'patch.unused')
}

// Each member a path package of the lockfile, and no two of one name, as a
// workspace holds no two packages of one name.
function checkMembers(lock, members) {
  const named = new Map()
  for (const key of members) {
    if (!(key in lock.packages) || lock.packages[key].source !== undefined) throw new LockfileError(`${quote(key)} is not a path package in the lockfile`, 'members')
    const { name } = lock.packages[key]
    if (named.has(name) && named.get(name) !== key) throw new LockfileError(`${quote(named.get(name))} and ${quote(key)} are two members of one name, which cargo refuses`, 'members')
    named.set(name, key)
  }
}

// No two packages linking one native library, as cargo's resolver refuses.
function checkLinks(packages) {
  const linked = new Map()
  for (const [key, { manifest }] of Object.entries(packages)) {
    if (manifest.links === undefined) continue
    if (linked.has(manifest.links)) throw new LockfileError(`links the native library ${quote(manifest.links)}, as ${quote(linked.get(manifest.links))} does, which cargo refuses`, key)
    linked.set(manifest.links, key)
  }
}

// `workspace` is the root's manifest; `members` the keys of the packages in
// the workspace, for which the lockfile resolves every dependency,
// dev-dependencies and optional ones among them.
export function linkCargo(lock, manifests, options) {
  const { workspace: root, members } = options ?? {}
  if (root?.patch === undefined || (root.workspace === undefined && root.package === undefined)) throw new TypeError('expected the manifest of the workspace root')
  if (!Array.isArray(members)) throw new TypeError('expected the members of the workspace')
  checkMembers(lock, members)
  const rootKey = root.package === undefined ? undefined : `${root.package.name} ${root.package.version}`
  if (rootKey !== undefined && !members.includes(rootKey)) throw new LockfileError(`the root package ${quote(rootKey)} is not among the members`, 'members')
  const identities = Object.create(null)
  for (const [key, pkg] of Object.entries(lock.packages)) identities[key] = pkg.source === undefined ? PATH : parseLockSource(pkg.source, key, false).identity
  const patches = readPatches(root)
  const context = { lock, identities, patches: Map.groupBy(patches, (patch) => patch.target) }
  const packages = Object.create(null)
  const ambiguous = new Map()
  for (const [key, pkg] of Object.entries(lock.packages)) {
    const manifest = manifests[key]?.package
    if (manifest === undefined) throw new LockfileError('no manifest of this package is given', key)
    if (manifest.name !== pkg.name || manifest.version !== pkg.version) {
      throw new LockfileError(`the manifest given is of ${quote(`${manifest.name} ${manifest.version}`)}`, key)
    }
    const member = members.includes(key)
    const dependencies = manifest.dependencies.map((dep, index) => {
      const where = at(at(key, 'dependencies'), String(index))
      const found = member || dep.kind !== 'dev' ? candidates(dep, key, context, where) : []
      const linked = { ...dep, resolved: found.length === 1 ? found[0] : undefined, active: false }
      if (found.length > 1) ambiguous.set(linked, found)
      return linked
    })
    packages[key] = { name: pkg.name, version: pkg.version, source: pkg.source, checksum: pkg.checksum, manifest, dependencies }
  }
  // The lockfile resolves what every feature of every member turns on.
  const roots = new Map(members.map((key) => [key, Object.keys(packages[key].manifest.features).map(featureValue)]))
  const why = (dep) => (ambiguous.has(dep)
    ? `${quote(dep.name)} could be any of ${ambiguous.get(dep).map(quote).join(', ')}`
    : `the lockfile resolves no ${quote(dep.name)}, which the members' features turn on: is it out of date?`)
  const reached = new Set(members)
  for (const dep of activate(packages, roots, why)) {
    dep.active = true
    reached.add(dep.resolved)
  }
  const lost = Object.keys(packages).find((key) => !reached.has(key))
  if (lost !== undefined) throw new LockfileError('no member depends on it, directly or not: is the lockfile out of date?', lost)
  checkLinks(packages)
  checkPatches(lock, identities, patches)
  for (const [key, pkg] of Object.entries(packages)) {
    const claimed = new Set(pkg.dependencies.filter((dep) => dep.active).map((dep) => dep.resolved))
    const stray = lock.packages[key].dependencies.find((dep) => !claimed.has(dep))
    if (stray !== undefined) throw new LockfileError(`the lockfile's edge to ${quote(stray)} is no dependency the members' features turn on: is it out of date?`, key)
  }
  return { resolver: resolverOf(root), root: rootKey, members: [...members], packages }
}

// The packages among the lockfile's edges from `key` that `dep` could be:
// by name, by the requirement, and by source, a [patch] of the name aside.
function candidates(dep, key, { lock, identities, patches }, where) {
  const requirement = dep.version === undefined ? undefined : parseRequirement(dep.version, where)
  const wanted = sourceIdentity(dep.source, identities[key])
  const offered = patches.get(`${patchedAs(dep.source)} ${dep.package}`) ?? []
  return lock.packages[key].dependencies.filter((edge) => {
    const { name, version, source } = lock.packages[edge]
    if (name !== dep.package || !within(requirement, version)) return false
    return from(wanted, identities[edge], source) || offered.some((patch) => from(patch.identity, identities[edge], source) && within(patch.requirement, version))
  })
}

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

export function setOf(map, key) {
  if (!map.has(key)) map.set(key, new Set())
  return map.get(key)
}

// What a declaration asks of its package: its features, and `default` where
// it keeps the default features and the package has them.
export function requestsOf(packages, dep) {
  return dep.defaultFeatures && 'default' in packages[dep.resolved].manifest.features ? [...dep.features, 'default'] : dep.features
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

// `roots` is by key, what each is asked for as feature values; `why` says
// why a declaration turned on that is not one package of the lockfile is
// refused. Gives the declarations turned on.
export function activate(packages, roots, why) {
  return new Activation(packages, why).run(roots)
}
