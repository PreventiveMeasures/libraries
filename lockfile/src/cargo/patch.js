import { matches, parseVersion } from '../crate/semver.js'
import { LockfileError, at, quote } from '../error.js'
import { optional, orEmpty } from '../shape.js'
import { parseRequirement } from './dependency.js'
import { ANY_REGISTRY, keyOf, parseLockSource, patchKey, patchUrl, patchedAs, sourceIdentity } from './lock.js'

const PATH = 'path'

// What parseCargoManifest gives as a dependency's source.
const SOURCE = {
  __proto__: null,
  registry: { registry: false, index: false },
  git: { url: true, branch: false, tag: false, rev: false },
  path: { path: true },
}

function checkSource(source) {
  const fields = SOURCE[source?.type]
  const fits = fields !== undefined && Object.entries(fields).every(([key, needed]) => typeof source[key] === 'string' || (!needed && source[key] === undefined))
  if (!fits) throw new TypeError('expected a source, as parseCargoManifest gives one')
}

// As linkCargo matches a [patch] table to a dependency.
export function patchesCargoSource(key, source) {
  if (typeof key !== 'string') throw new TypeError('expected the key of a [patch] table')
  checkSource(source)
  return patchedAs(source) === patchKey(key)
}

export const within = (requirement, version) => requirement === undefined || matches(requirement, parseVersion(version))

export const from = (wanted, pkg) => pkg.identity === wanted || (wanted === ANY_REGISTRY && pkg.source !== undefined && !pkg.source.startsWith('git+'))

export const offers = (patch, pkg) => pkg.name === patch.package && from(patch.identity, pkg) && within(patch.requirement, pkg.version)

export const identify = (pkg, where) => ({
  ...pkg,
  key: keyOf(pkg.name, pkg.version, pkg.source),
  identity: pkg.source === undefined ? PATH : parseLockSource(pkg.source, where, false).identity,
})

// Of two tables at one URL, cargo keeps the later by key.
function tablesByUrl(patch, where, label) {
  const tables = new Map()
  for (const key of Object.keys(patch).toSorted()) {
    const here = at(where, key)
    const entries = Object.entries(patch[key]).map(([name, spec]) => ({ key, name, spec, where: at(here, name) }))
    tables.set(patchUrl(key), { key, where: here, label: `${label}[patch.${key}]`, entries })
  }
  return tables
}

// The config's tables override the root's entry by entry. Two tables for
// one source by URLs that differ until canonical replace each other in
// cargo in hash order, so they are refused.
function patchEntries(root, config) {
  const tables = tablesByUrl(orEmpty(config?.patch), at('config', 'patch'), "the config's ")
  for (const [url, table] of tablesByUrl(root.patch, 'patch', '')) {
    const given = tables.get(url)
    if (given === undefined) tables.set(url, table)
    else given.entries.push(...table.entries.filter((entry) => !given.entries.some((other) => other.name === entry.name)))
  }
  const sources = new Map()
  for (const { key, where, label } of tables.values()) {
    const source = patchKey(key)
    const other = sources.get(source)
    if (other !== undefined) throw new LockfileError(`patches the source ${other} does by another URL, and cargo would take either table`, where)
    sources.set(source, label)
  }
  return [...tables.values()].flatMap((table) => table.entries)
}

// A path's own location only a filesystem knows, so a path patch is never
// refused as patching its own source.
export function readPatches(root, config) {
  return patchEntries(root, config).map(({ key, spec, where }) => {
    const table = patchKey(key)
    if (patchedAs(spec.source) === table) throw new LockfileError('patches its source with itself, which cargo refuses', where)
    const requirement = optional(parseRequirement)(spec.version, where)
    return { table, target: `${table} ${spec.package}`, package: spec.package, identity: sourceIdentity(spec.source, PATH), requirement, where }
  })
}

// The first of `items` left without a slot by a maximum matching (Kuhn's).
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

// Cargo resolves every patch to one package, and no two patches of one table
// to the same one. A used patch's package is among the lockfile's; an unused
// one's is listed under [[patch.unused]] once per patch, so twice where two
// tables offer it. So two matchings: each patch to a package of its own, per
// table, or an unused entry; and each unused entry, and each package a
// dependency reaches through a patch, to a patch. Where both exist, one
// matching does both (Mendelsohn–Dulmage). Path patches are told apart by
// version and table alone, and two directories may hold one version, so a
// path package may be both used and unused.
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
