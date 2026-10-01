// [patch], from the root's manifest and cargo's configuration: what each
// offers, and how the lockfile accounts for each, used or unused.

import { matches, parseVersion } from '../crate/semver.js'
import { LockfileError, at, quote } from '../error.js'
import { EMPTY } from '../shape.js'
import { parseRequirement } from './dependency.js'
import { ANY_REGISTRY, keyOf, parseLockSource, patchKey, patchUrl, patchedAs, sourceIdentity } from './lock.js'

const PATH = 'path'

// Whether `version` meets `requirement`, where there is one.
export const within = (requirement, version) => requirement === undefined || matches(requirement, parseVersion(version))

// Whether a package of the lockfile is from `wanted`: that very source, or
// any registry where a registry is known by its name alone.
export const from = (wanted, pkg) => pkg.identity === wanted || (wanted === ANY_REGISTRY && pkg.source !== undefined && !pkg.source.startsWith('git+'))

// Whether `patch` offers a package of the lockfile.
export const offers = (patch, pkg) => pkg.name === patch.package && from(patch.identity, pkg) && within(patch.requirement, pkg.version)

// A package of the lockfile, or an unused entry, with its key and the
// identity of its source.
export const identify = (pkg, where) => ({
  ...pkg,
  key: keyOf(pkg.name, pkg.version, pkg.source),
  identity: pkg.source === undefined ? PATH : parseLockSource(pkg.source, where, false).identity,
})

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

// What each [patch] cargo reads offers: the package, from the source it
// offers it from, of the versions its requirement takes there, as cargo
// refuses a patch whose location has none of them; by `table`, the source it
// patches, and by `target`, that and the package's name. Cargo refuses too a
// patch from the source it patches, whatever the git reference; a path's
// place only a filesystem tells.
export function readPatches(root, config) {
  return patchEntries(root, config).map(({ key, spec, where }) => {
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
export function checkPatches(locked, unusedPatches, patches, patched) {
  const unused = unusedPatches.map((item) => identify(item, 'patch.unused'))
  const used = unused.find((item) => item.source !== undefined && locked.has(item.key))
  if (used !== undefined) throw new LockfileError(`the lockfile lists ${quote(used.key)} unused, and among its packages: is it out of date?`, 'patch.unused')
  const slots = new Map()
  for (const patch of patches) {
    for (const pkg of locked.values()) if (offers(patch, pkg)) slots.set(`${patch.table} ${pkg.key}`, { ...pkg, table: patch.table })
  }
  const fits = (patch, slot) => (slot.table === undefined || slot.table === patch.table) && offers(patch, slot)
  const lost = unmatched(patches, [...slots.values(), ...unused], fits)
  if (lost !== undefined) throw new LockfileError('the lockfile has no package of its own this patch offers, used or unused: is it out of date?', lost.where)
  const stray = unmatched([...[...patched].map((slot) => slots.get(slot)), ...unused], patches, (slot, patch) => fits(patch, slot))
  if (stray?.table !== undefined) throw new LockfileError('a dependency resolves to it by a [patch], and no patch is left that offers it: is the lockfile out of date?', stray.key)
  if (stray !== undefined) throw new LockfileError(`the lockfile lists ${quote(`${stray.name} ${stray.version}`)} unused where no [patch] does: is it out of date?`, 'patch.unused')
}
