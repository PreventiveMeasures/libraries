// The lockfile's edges tied to the manifests' declarations, as cargo ties
// them: by name, version requirement and source. A declaration is active
// where the lockfile's resolve, every member's every feature on, turns it
// on; the lockfile's edges are exactly the active declarations'.

import { LockfileError, at, quote } from '../error.js'
import { checkOptions, optional } from '../shape.js'
import { activate } from './activate.js'
import { featureValue, parseRequirement } from './dependency.js'
import { keyOf, lockedOf, patchedAs, sourceIdentity } from './lock.js'
import { checkPatches, from, identify, offers, readPatches, within } from './patch.js'

function resolverOf(root) {
  const edition = root.package?.edition
  return root.workspace?.resolver ?? root.package?.resolver ?? (edition === '2024' ? 3 : edition === '2021' ? 2 : 1)
}

function checkMembers(lock, members) {
  const named = new Map()
  for (const key of members) {
    if (!(key in lock.packages) || lock.packages[key].source !== undefined) throw new LockfileError(`${quote(key)} is not a path package in the lockfile`, 'members')
    const { name } = lock.packages[key]
    if (named.has(name) && named.get(name) !== key) throw new LockfileError(`${quote(named.get(name))} and ${quote(key)} are two members of one name, which cargo refuses`, 'members')
    named.set(name, key)
  }
}

function checkLinks(packages) {
  const linked = new Map()
  for (const [key, { manifest }] of Object.entries(packages)) {
    if (manifest.links === undefined) continue
    if (linked.has(manifest.links)) throw new LockfileError(`links the native library ${quote(manifest.links)}, as ${quote(linked.get(manifest.links))} does, which cargo refuses`, key)
    linked.set(manifest.links, key)
  }
}

// `ambiguous`: declarations more than one edge could be; `patched`: those
// resolved through a [patch], by table and package key. The lockfile
// resolves the dev-dependencies of members alone.
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
    packages[key] = { ...lockedOf(pkg), manifest, dependencies }
  }
  return { packages, ambiguous, patched }
}

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

export function linkCargo(lock, manifests, options) {
  const { workspace: root, members, config } = checkOptions(options, ['workspace', 'members', 'config'])
  if (root?.patch === undefined || (root.workspace === undefined && root.package === undefined)) throw new TypeError('expected the manifest of the workspace root')
  if (!Array.isArray(members)) throw new TypeError('expected the members of the workspace')
  if (config !== undefined && config?.patch === undefined) throw new TypeError('expected the config, as parseCargoConfig gives it')
  checkMembers(lock, members)
  const rootKey = root.package === undefined ? undefined : keyOf(root.package.name, root.package.version)
  if (rootKey !== undefined && !members.includes(rootKey)) throw new LockfileError(`the root package ${quote(rootKey)} is not among the members`, 'members')
  const locked = new Map(Object.entries(lock.packages).map(([key, pkg]) => [key, identify(pkg, key)]))
  const patches = readPatches(root, config)
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

// The edges `dep` could be, by name, requirement and source, or as offered
// by a [patch] of its source, which `slot` then names.
function candidates(dep, key, { locked, patches }, where) {
  const requirement = optional(parseRequirement)(dep.version, where)
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
