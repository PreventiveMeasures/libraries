// What `pnpm install --prod` installs of a lockfile, as
// @pnpm/lockfile.filtering's filterLockfileByImportersAndEngine filters it
// with devDependencies left out: every project's devDependencies dropped, and
// of the snapshots those the rest reach, through dependencies,
// optionalDependencies and `link:`s, which lead only to projects, all of them
// installed anyway. The root's specifiers stay, which pnpm 9 hoists by.
//
// From pnpm 11.28 and 12.8.1 on (@pnpm/lockfile.peer-edges), an edge to an
// optional peer that a snapshot has only as the projects that reach it list
// the peer themselves is not walked, and is dropped from the snapshot where
// nothing else reaches the peer: a devDependency only there to satisfy an
// optional peer of a production one is left out. From 11.28.7 and 12.15.0,
// only an edge to a peer the snapshot's key binds is such an edge, or any of
// one whose key ends in a hash of its peers; before, any edge by the name of
// an optional peer was, though the snapshot resolved it as its own.

import { compareVersions } from '@preventive/upstream/semver.js'
import { packageKeyOf } from '@preventive/lockfile/pnpm.js'
import { reachable } from './nm-hoist.js'

// undefined where there is no such edge; else whether the key must bind it.
function ruleOf(pnpm, major) {
  const since = (version) => compareVersions(pnpm, version) >= 0
  if (major < 11 || (major === 11 && !since('11.28.0'))) return undefined
  return { bound: since(major === 11 ? '11.28.7' : '12.15.0') }
}

const edgesOf = (deps) => Object.values(deps).filter((target) => !target.startsWith('link:'))
const prodEdgesOf = ({ dependencies, optionalDependencies }) => edgesOf({ ...dependencies, ...optionalDependencies })

// The groups that end a key, each without its parentheses, the patch hash's
// first where the key has one; a key the lockfile reader takes has them
// balanced.
function groupsOf(key) {
  const groups = []
  let open = 0
  let start = 0
  const suffix = key.slice(packageKeyOf(key).length)
  for (let i = 0; i < suffix.length; i++) {
    if (suffix[i] === '(' && open++ === 0) start = i + 1
    else if (suffix[i] === ')' && --open === 0) groups.push(suffix.slice(start, i))
  }
  return groups
}

const PATCH = 'patch_hash='

// pnpm's removePeersSuffix: a key with its patch hash and without its peers.
function withoutPeers(key) {
  const [first] = groupsOf(key)
  return packageKeyOf(key) + (first?.startsWith(PATCH) ? `(${first})` : '')
}

// pnpm's getBoundPeerProviders: null where the key has no peers, undefined
// where it has a hash in their place, else each peer it binds.
function boundOf(key) {
  const peers = groupsOf(key).filter((group) => !group.startsWith(PATCH))
  if (peers.length === 0) return null
  if (peers.length === 1 && /^[\da-f]{32}$/u.test(peers[0])) return undefined
  return new Set(peers.filter((peer) => peer.indexOf('@', 1) !== -1).map(withoutPeers))
}

// Each snapshot's edges to its optional peers, `bound` holding them to the
// peers its key binds.
function optionalPeerEdges(packages, bound) {
  const entries = []
  for (const [parent, pkg] of Object.entries(packages)) {
    const providers = bound ? boundOf(parent) : undefined
    if (providers === null) continue
    for (const deps of [pkg.dependencies, pkg.optionalDependencies]) {
      for (const [alias, target] of Object.entries(deps)) {
        if (target.startsWith('link:') || !Object.hasOwn(pkg.peerDependencies, alias) || pkg.peerDependenciesMeta[alias]?.optional !== true) continue
        if (providers === undefined || providers.has(withoutPeers(target))) entries.push({ parent, alias, target })
      }
    }
  }
  return entries
}

const directOf = ({ dependencies, devDependencies, optionalDependencies }) => edgesOf({ ...dependencies, ...devDependencies, ...optionalDependencies })

// pnpm's collectPeerSatisfactionEdges: by each edge's target, the projects
// that do not list it among their own (none, where it is the root's
// devDependency and resolvePeersFromWorkspaceRoot is set); an edge is one to
// skip where nothing those projects list reaches its snapshot.
function satisfactionEdges(lockfile, rule, fromRoot) {
  const entries = optionalPeerEdges(lockfile.packages, rule.bound)
  const edges = new Map()
  if (entries.length === 0) return edges
  const importers = Object.values(lockfile.importers)
  const direct = importers.map((importer) => new Set(directOf(importer)))
  const rootDev = fromRoot && lockfile.importers['.'] !== undefined ? new Set(edgesOf(lockfile.importers['.'].devDependencies)) : new Set()
  const next = (key) => (key in lockfile.packages ? prodEdgesOf(lockfile.packages[key]) : [])
  const groups = Map.groupBy(entries, ({ target }) => (rootDev.has(target) ? '' : direct.flatMap((keys, i) => (keys.has(target) ? [] : [i])).join(',')))
  for (const [listing, group] of groups) {
    const seeds = listing === '' ? [] : listing.split(',').flatMap((i) => directOf(importers[Number(i)]))
    const reached = reachable(seeds, next)
    for (const { parent, alias } of group) {
      if (reached.has(parent)) continue
      if (!edges.has(parent)) edges.set(parent, new Set())
      edges.get(parent).add(alias)
    }
  }
  return edges
}

// Each snapshot `edges` names, without those of its edges `drop` takes.
function without(packages, edges, drop) {
  const kept = { ...packages }
  for (const [parent, aliases] of edges) {
    const pkg = packages[parent]
    if (pkg === undefined) continue
    const keep = (deps) => Object.fromEntries(Object.entries(deps).filter(([alias, target]) => !aliases.has(alias) || !drop(target)))
    kept[parent] = { ...pkg, dependencies: keep(pkg.dependencies), optionalDependencies: keep(pkg.optionalDependencies) }
  }
  return kept
}

// `walked`, what pnpm walks to leave out what the host cannot run: every
// snapshot, but for the edges it does not walk; `installing`, the lockfile
// the tree is laid out from: the snapshots reached, each but for those edges
// to a snapshot not reached. Each importer's devDependencies are empty.
export function productionLockfile(lockfile, { pnpm, major, resolvePeersFromWorkspaceRoot }) {
  const importers = Object.fromEntries(Object.entries(lockfile.importers).map(([id, importer]) => [id, { ...importer, devDependencies: {} }]))
  const rule = ruleOf(pnpm, major)
  const edges = rule === undefined ? new Map() : satisfactionEdges(lockfile, rule, resolvePeersFromWorkspaceRoot)
  const walked = { ...lockfile, importers, packages: without(lockfile.packages, edges, () => true) }
  const starts = Object.values(importers).flatMap(prodEdgesOf)
  const picked = reachable(starts, (key) => prodEdgesOf(walked.packages[key]))
  const packages = Object.fromEntries(Object.entries(lockfile.packages).filter(([key]) => picked.has(key)))
  return { walked, installing: { ...lockfile, importers, packages: without(packages, edges, (target) => !picked.has(target)) } }
}
