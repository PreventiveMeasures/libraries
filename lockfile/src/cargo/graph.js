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

import { matches, parseVersion } from '../crate/semver.js'
import { LockfileError, at, quote } from '../error.js'
import { EMPTY, checkOptions } from '../shape.js'
import { featureValue, parseRequirement } from './dependency.js'
import { ANY_REGISTRY, keyOf, parseLockSource, patchKey, patchUrl, patchedAs, sourceIdentity } from './lock.js'

const PATH = 'path'

// The resolver the workspace root asks for, or its edition's.
function resolverOf(root) {
  const edition = root.package?.edition
  const byEdition = edition === '2024' ? 3 : edition === '2021' ? 2 : 1
  return root.workspace?.resolver ?? root.package?.resolver ?? byEdition
}

const within = (requirement, version) => requirement === undefined || matches(requirement, parseVersion(version))

// Whether a package of the lockfile is from `wanted`: that very source, or
// any registry where a registry is known by its name alone.
const from = (wanted, pkg) => pkg.identity === wanted || (wanted === ANY_REGISTRY && pkg.source !== undefined && !pkg.source.startsWith('git+'))

// Whether `patch` offers a package of the lockfile.
const offers = (patch, pkg) => pkg.name === patch.package && from(patch.identity, pkg) && within(patch.requirement, pkg.version)

// The lockfile's packages, each with the identity of its source.
const identify = (pkg, where) => ({ ...pkg, identity: pkg.source === undefined ? PATH : parseLockSource(pkg.source, where, false).identity })

// [patch] tables by the URL cargo keys each by: of two at one URL, the
// later by key, as cargo replaces the one with the other.
function tablesByUrl(patch, where, label) {
  const tables = new Map()
  for (const key of Object.keys(patch).toSorted()) {
    const here = at(where, key)
    const entries = Object.entries(patch[key]).map(([name, spec]) => ({ key, name, spec, where: at(here, name) }))
    tables.set(patchUrl(key), { key, where: here, label: `${label}[patch.${key}]`, entries })
  }
  return tables
}

// The [patch] entries cargo reads, the config's and the root's: at a URL
// both have a table at, the config's entries, then the root's of the names
// it has none of. Two tables at one source by URLs that differ but for being
// canonical cargo replaces one with the other in no set order: refused.
function patchEntries(root, config) {
  const tables = tablesByUrl(config?.patch ?? EMPTY, at('config', 'patch'), "the config's ")
  for (const [url, table] of tablesByUrl(root.patch, 'patch', '')) {
    const given = tables.get(url)
    if (given === undefined) tables.set(url, table)
    else given.entries.push(...table.entries.filter((entry) => !given.entries.some((other) => other.name === entry.name)))
  }
  const sources = new Map()
  for (const { key, where, label } of tables.values()) {
    const other = sources.get(patchKey(key))
    if (other !== undefined) throw new LockfileError(`patches the source ${other} does by another URL, and cargo would take either table`, where)
    sources.set(patchKey(key), label)
  }
  return [...tables.values()].flatMap((table) => table.entries)
}

// What a [patch] offers: the package, from the source it offers it from, of
// the versions its requirement takes there, as cargo refuses a patch whose
// location has none of them; by `table`, the source it patches, and by
// `target`, that and the package's name. Cargo refuses too a patch from the
// source it patches, whatever the git reference; a path's place only a
// filesystem tells.
function readPatches(entries) {
  return entries.map(({ key, spec, where }) => {
    const table = patchKey(key)
    if (patchedAs(spec.source) === table) throw new LockfileError('patches its source with itself, which cargo refuses', where)
    const requirement = spec.version === undefined ? undefined : parseRequirement(spec.version, where)
    return { table, target: `${table} ${spec.package}`, package: spec.package, identity: sourceIdentity(spec.source, PATH), requirement, where }
  })
}

// The first of `items` that cannot have one of `slots` to itself, `fits`
// saying which it can have, by a maximum matching of the two.
function unmatched(items, slots, fits) {
  const holder = slots.map(() => undefined)
  const take = (item, seen) => slots.some((slot, index) => {
    if (seen.has(index) || !fits(item, slot)) return false
    seen.add(index)
    if (holder[index] !== undefined && !take(holder[index], seen)) return false
    holder[index] = item
    return true
  })
  return items.find((item) => !take(item, new Set()))
}

// Cargo resolves every patch, used or not, to one package, and keeps it in
// the lockfile: among the packages where it is used, and where not, once
// under [[patch.unused]] for each patch it is the package of, so twice for
// one two tables offer; and no two patches of one table resolve to one
// package, as cargo refuses. So each patch has a package of its own, of the
// lockfile's, which it shares with no patch of its table, or an unused
// entry, which it shares with none; and each unused entry is a patch's, and
// each package a dependency resolves to by a patch, `patched` by its table,
// a patch's of that table. As a matching that takes every patch can be had,
// and one that takes every entry and package that has to be taken, one that
// takes both can be. And an unused entry is no package of the lockfile
// too, unless both are by path, as two directories may hold one name's one
// version. Patches by path are told apart by version and table, not by
// path: which two paths are one directory, and what version each holds,
// only a filesystem tells.
function checkPatches(locked, unusedPatches, patches, patched) {
  const unused = unusedPatches.map((item) => identify(item, 'patch.unused'))
  const used = unused.find((item) => item.source !== undefined && locked.has(keyOf(item.name, item.version, item.source)))
  if (used !== undefined) throw new LockfileError(`the lockfile lists ${quote(keyOf(used.name, used.version, used.source))} unused, and among its packages: is it out of date?`, 'patch.unused')
  const slots = new Map()
  for (const patch of patches) {
    for (const [key, pkg] of locked) if (offers(patch, pkg)) slots.set(`${patch.table} ${key}`, { ...pkg, key, table: patch.table })
  }
  const fits = (patch, slot) => (slot.table === undefined || slot.table === patch.table) && offers(patch, slot)
  const lost = unmatched(patches, [...slots.values(), ...unused], fits)
  if (lost !== undefined) throw new LockfileError('the lockfile has no package of its own this patch offers, used or unused: is it out of date?', lost.where)
  const stray = unmatched([...[...patched].map((slot) => slots.get(slot)), ...unused], patches, (slot, patch) => fits(patch, slot))
  if (stray?.table !== undefined) throw new LockfileError('a dependency resolves to it by a [patch], and no patch is left that offers it: is the lockfile out of date?', stray.key)
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

// Each package of the lockfile with its manifest, and each declaration with
// the package it resolves to, where the lockfile's edges from the package
// leave it one; by `ambiguous` the declarations they leave more, and by
// `patched` those resolved by a [patch], with the table's and package's key.
function linkPackages(lock, manifests, members, context) {
  const packages = Object.create(null)
  const ambiguous = new Map()
  const patched = new Map()
  for (const [key, pkg] of Object.entries(lock.packages)) {
    const manifest = manifests[key]?.package
    if (manifest === undefined) throw new LockfileError('no manifest of this package is given', key)
    if (manifest.name !== pkg.name || manifest.version !== pkg.version) {
      throw new LockfileError(`the manifest given is of ${quote(`${manifest.name} ${manifest.version}`)}`, key)
    }
    const member = members.includes(key)
    const dependencies = manifest.dependencies.map((dep, index) => {
      const found = member || dep.kind !== 'dev' ? candidates(dep, key, context, at(at(key, 'dependencies'), String(index))) : []
      const linked = { ...dep, resolved: found.length === 1 ? found[0].key : undefined, active: false }
      if (found.length > 1) ambiguous.set(linked, found.map((item) => item.key))
      if (found.length === 1 && found[0].slot !== undefined) patched.set(linked, found[0].slot)
      return linked
    })
    packages[key] = { name: pkg.name, version: pkg.version, source: pkg.source, checksum: pkg.checksum, manifest, dependencies }
  }
  return { packages, ambiguous, patched }
}

// Each of the lockfile's edges a declaration turned on, and so each package
// reached from a member.
function checkActive(lock, packages, members) {
  const reached = new Set(members)
  for (const pkg of Object.values(packages)) for (const dep of pkg.dependencies) if (dep.active) reached.add(dep.resolved)
  const lost = Object.keys(packages).find((key) => !reached.has(key))
  if (lost !== undefined) throw new LockfileError('no member depends on it, directly or not: is the lockfile out of date?', lost)
  for (const [key, pkg] of Object.entries(packages)) {
    const claimed = new Set(pkg.dependencies.filter((dep) => dep.active).map((dep) => dep.resolved))
    const stray = lock.packages[key].dependencies.find((dep) => !claimed.has(dep))
    if (stray !== undefined) throw new LockfileError(`the lockfile's edge to ${quote(stray)} is no dependency the members' features turn on: is it out of date?`, key)
  }
}

// `workspace` is the root's manifest; `members` the keys of the packages in
// the workspace, for which the lockfile resolves every dependency,
// dev-dependencies and optional ones among them.
export function linkCargo(lock, manifests, options) {
  const { workspace: root, members, config } = checkOptions(options, ['workspace', 'members', 'config'])
  if (root?.patch === undefined || (root.workspace === undefined && root.package === undefined)) throw new TypeError('expected the manifest of the workspace root')
  if (!Array.isArray(members)) throw new TypeError('expected the members of the workspace')
  if (config !== undefined && config?.patch === undefined) throw new TypeError('expected the config, as parseCargoConfig gives it')
  checkMembers(lock, members)
  const rootKey = root.package === undefined ? undefined : `${root.package.name} ${root.package.version}`
  if (rootKey !== undefined && !members.includes(rootKey)) throw new LockfileError(`the root package ${quote(rootKey)} is not among the members`, 'members')
  const locked = new Map(Object.entries(lock.packages).map(([key, pkg]) => [key, identify(pkg, key)]))
  const patches = readPatches(patchEntries(root, config))
  const { packages, ambiguous, patched } = linkPackages(lock, manifests, members, { locked, patches: Map.groupBy(patches, (patch) => patch.target) })
  // The lockfile resolves what every feature of every member turns on.
  const roots = new Map(members.map((key) => [key, Object.keys(packages[key].manifest.features).map(featureValue)]))
  const why = (dep, key) => {
    if (ambiguous.has(dep)) return `${quote(dep.name)} could be any of ${ambiguous.get(dep).map(quote).join(', ')}`
    const named = lock.packages[key].dependencies.filter((edge) => lock.packages[edge].name === dep.package)
    if (named.length === 0) return `the lockfile resolves no ${quote(dep.name)}, which the members' features turn on: is it out of date?`
    return `the lockfile resolves ${quote(dep.name)} to none but ${named.map(quote).join(', ')}, of another source or version: is it out of date, or [patch]ed by a config not given?`
  }
  for (const dep of activate(packages, roots, why)) dep.active = true
  checkActive(lock, packages, members)
  checkLinks(packages)
  const slots = Object.values(packages).flatMap((pkg) => pkg.dependencies.filter((dep) => dep.active && patched.has(dep)).map((dep) => patched.get(dep)))
  checkPatches(locked, lock.unusedPatches, patches, new Set(slots))
  return { resolver: resolverOf(root), root: rootKey, members: [...members], packages }
}

// The packages among the lockfile's edges from `key` that `dep` could be:
// by name, by the requirement, and by source, a [patch] of the name aside;
// each by its key, and where it is a patch's, the table's and its key.
function candidates(dep, key, { locked, patches }, where) {
  const requirement = dep.version === undefined ? undefined : parseRequirement(dep.version, where)
  const wanted = sourceIdentity(dep.source, locked.get(key).identity)
  const table = patchedAs(dep.source)
  const offered = patches.get(`${table} ${dep.package}`) ?? []
  return locked.get(key).dependencies.flatMap((edge) => {
    const pkg = locked.get(edge)
    if (pkg.name !== dep.package || !within(requirement, pkg.version)) return []
    if (from(wanted, pkg)) return [{ key: edge, slot: undefined }]
    return offered.some((patch) => offers(patch, pkg)) ? [{ key: edge, slot: `${table} ${edge}` }] : []
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

// `roots` is by key, what each is asked for as feature values; `why` says
// why a declaration turned on that is not one package of the lockfile is
// refused. Gives the declarations turned on.
export function activate(packages, roots, why) {
  return new Activation(packages, why).run(roots)
}
