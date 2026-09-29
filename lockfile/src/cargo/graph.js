// The lockfile's graph with each package's manifest laid over it: every
// dependency a manifest declares, with the package the lockfile resolves
// it to. The lockfile names only packages; which declaration an edge is,
// of which kind, for which platform, asking for which features, is the
// manifest's. Cargo ties the two together by name, version requirement and
// source; so does this, and refuses where it cannot do so one way only:
// a declaration two edges could be, an edge no declaration is, a
// declaration the lockfile should resolve and does not. A declaration is
// active where the lockfile's resolve, every member's every feature on,
// turns it on; the lockfile's edges are the active declarations'.

import { LockfileError, at, quote } from '../error.js'
import { activate } from './resolve.js'
import { matches, parseRequirement, parseVersion } from './semver.js'
import { ANY_REGISTRY, parseLockSource, sourceIdentity } from './source.js'

const PATH = 'path'

// The resolver the workspace root asks for, or its edition's.
function resolverOf(root) {
  const edition = root.package?.edition
  const byEdition = edition === '2024' ? 3 : edition === '2021' ? 2 : 1
  return root.workspace?.resolver ?? root.package?.resolver ?? byEdition
}

// What a [patch] offers under a name, from whatever source it patches.
function patchesOf(root) {
  const patches = new Map()
  for (const specs of Object.values(root.patch)) {
    for (const spec of Object.values(specs)) {
      patches.set(spec.package, [...(patches.get(spec.package) ?? []), sourceIdentity(spec.source, PATH)])
    }
  }
  return patches
}

// `workspace` is the root's manifest; `members` the keys of the packages in
// the workspace, for which the lockfile resolves every dependency,
// dev-dependencies and optional ones among them.
export function linkCargo(lock, manifests, options) {
  const { workspace: root, members } = options ?? {}
  if (root?.patch === undefined || (root.workspace === undefined && root.package === undefined)) throw new TypeError('expected the manifest of the workspace root')
  if (!Array.isArray(members)) throw new TypeError('expected the members of the workspace')
  for (const key of members) {
    if (!(key in lock.packages) || lock.packages[key].source !== undefined) throw new LockfileError(`${quote(key)} is not a path package in the lockfile`, 'members')
  }
  const rootKey = root.package === undefined ? undefined : `${root.package.name} ${root.package.version}`
  if (rootKey !== undefined && !members.includes(rootKey)) throw new LockfileError(`the root package ${quote(rootKey)} is not among the members`, 'members')
  const identities = Object.create(null)
  for (const [key, pkg] of Object.entries(lock.packages)) identities[key] = pkg.source === undefined ? PATH : parseLockSource(pkg.source, key, false).identity
  const context = { lock, identities, patches: patchesOf(root) }
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
  const roots = new Map(members.map((key) => [key, Object.keys(packages[key].manifest.features).map((feature) => ({ dep: undefined, feature, weak: false }))]))
  const why = (dep) => (ambiguous.has(dep)
    ? `${quote(dep.name)} could be any of ${ambiguous.get(dep).map(quote).join(', ')}`
    : `the lockfile resolves no ${quote(dep.name)}, which the members' features turn on: is it out of date?`)
  for (const dep of activate(packages, roots, why)) dep.active = true
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
  const offered = patches.get(dep.package) ?? []
  return lock.packages[key].dependencies.filter((edge) => {
    const { name, version, source } = lock.packages[edge]
    if (name !== dep.package || (requirement !== undefined && !matches(requirement, parseVersion(version)))) return false
    return identities[edge] === wanted || offered.includes(identities[edge]) || (wanted === ANY_REGISTRY && source !== undefined && !source.startsWith('git+'))
  })
}
