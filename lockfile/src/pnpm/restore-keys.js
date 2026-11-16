// Each snapshot's key from its providers, as pnpm's resolver writes a peer
// suffix, and its entry with its peers among its dependencies, as in v9.

import { utf8fromString } from '@exodus/bytes/utf8.js'
import { compareCodePoints } from '../order.js'
import { sha256 } from '../sha256.js'
import { isAliasRef } from './key.js'
import { buildGraph } from './restore.js'
import { components } from './tarjan.js'

const DEFAULT_MAX_LENGTH = 1000

// pnpm's linkPathToPeerVersion.
function linkVersion(path) {
  let out = ''
  let plus = true
  for (const char of path.replace(/^\.+/u, '')) {
    if (!/[\p{Cc}"*+/:<>?\\|]/u.test(char)) {
      out += char
      plus = false
    } else if (!plus) {
      out += '+'
      plus = true
    }
  }
  const trimmed = out.replace(/[+.]+$/u, '')
  if (trimmed !== '') return trimmed
  return path === '' ? '' : '+'
}

// pnpm's createPeerDepGraphHash.
function peerSuffix(segments, maxLength) {
  const body = segments.toSorted(compareCodePoints).join(')(')
  return utf8fromString(body).length > maxLength ? `(${sha256(body).slice(0, 32)})` : `(${body})`
}

// As pnpm's get_patch_info, a directory's `file:` source its version.
function patchGroup(graph, sid, infos, patches) {
  if (patches.size === 0) return ''
  const key = graph.keys[sid]
  const name = graph.names[sid]
  const version = infos.get(key).version ?? key.slice(name.length + 1)
  const hash = patches.get(`${name}@${version}`) ?? patches.get(name)
  return hash === undefined ? '' : `(patch_hash=${hash})`
}

// The names on a cycle from a package's name to those of the peers it binds.
function cyclicNames(graph) {
  const index = new Map()
  const edges = []
  const intern = (name) => {
    if (!index.has(name)) index.set(name, edges.push(new Set()) - 1)
    return index.get(name)
  }
  for (const [sid, providers] of graph.providers.entries()) {
    if (providers.length === 0) continue
    const from = intern(graph.names[sid])
    for (const [name] of providers) edges[from].add(intern(name))
  }
  const names = [...index.keys()]
  const found = components(edges.length, (node) => [...edges[node]])
  return new Set(found.components.filter((component) => component.length > 1 || edges[component[0]].has(component[0])).flat().map((node) => names[node]))
}

// A provider is its own key, or `name@version` alone under dedupePeers, in
// a cycle of peers or for a name on a cycle of names.
function keysOf(graph, infos, { dedupePeers, peersSuffixMaxLength = DEFAULT_MAX_LENGTH }, patches) {
  const keys = Array.from({ length: graph.keys.length }, () => undefined)
  const order = components(graph.keys.length, (sid) => graph.providers[sid].flatMap(([, p]) => (p.snapshot === undefined ? [] : [p.snapshot])))
  const cyclic = dedupePeers ? new Set() : cyclicNames(graph)
  const keyOf = (sid) => {
    const base = `${graph.keys[sid]}${patchGroup(graph, sid, infos, patches)}`
    if (graph.providers[sid].length === 0) return base
    const component = order.componentOf.get(sid)
    const segments = graph.providers[sid].map(([name, provider]) => {
      if (provider.link !== undefined) return `${name}@${linkVersion(provider.link)}`
      if (provider.missing !== undefined) return provider.missing
      const collapsed = dedupePeers || component === order.componentOf.get(provider.snapshot) || cyclic.has(name)
      return collapsed ? graph.keys[provider.snapshot] : keys[provider.snapshot]
    })
    return `${base}${peerSuffix(segments, peersSuffixMaxLength)}`
  }
  // Each component follows its providers'.
  for (const members of order.components) for (const sid of members) keys[sid] = keyOf(sid)
  return keys
}

// The peers declared below each snapshot that nothing binds, less those it
// declares itself, which its dependents list.
function unboundBelow(graph, infos) {
  const declared = graph.keys.map((key) => Object.keys(infos.get(key).peerDependencies))
  const own = graph.entries.map((entry, sid) => declared[sid].filter((name) => !entry.own.has(name) && !entry.dependencies.has(name) && !entry.optionalDependencies.has(name)))
  const children = graph.children.map(({ list }) => list.map(([, child]) => child))
  const order = components(graph.keys.length, (sid) => children[sid])
  const below = Array.from({ length: graph.keys.length }, () => undefined)
  for (const members of order.components) {
    const component = order.componentOf.get(members[0])
    const set = new Set(members.flatMap((sid) => own[sid]))
    for (const child of new Set(members.flatMap((sid) => children[sid]))) {
      if (order.componentOf.get(child) !== component) for (const name of below[child]) set.add(name)
    }
    for (const sid of members) below[sid] = set
  }
  return (sid) => (declared[sid].length === 0 ? below[sid] : below[sid].difference(new Set(declared[sid])))
}

// The reference made to lead to the snapshot `to`, where one was chosen.
function restoredRef(version, to, keys) {
  if (to === undefined || version.startsWith('link:')) return version
  const key = keys[to]
  return isAliasRef(version) ? key : key.slice(key.indexOf('@', 1) + 1)
}

const sorted = (entries) => Object.fromEntries(entries.toSorted(([a], [b]) => compareCodePoints(a, b)))

function entryOf(graph, sid, keys, infos, unbound) {
  const entry = graph.entries[sid]
  const child = ([alias, ref]) => [alias, restoredRef(ref.version, graph.children[sid].byAlias.get(alias), keys)]
  const dependencies = [...entry.dependencies].map(child)
  const optionalDependencies = [...entry.optionalDependencies].map(child)
  const meta = infos.get(graph.keys[sid]).peerDependenciesMeta
  for (const [name, ref] of entry.own) {
    const provider = graph.providers[sid].find(([bound]) => bound === name)[1]
    ;(meta[name]?.optional ? optionalDependencies : dependencies).push([name, restoredRef(ref.version, provider.snapshot, keys)])
  }
  const transitive = new Set([...entry.below.keys(), ...(entry.unbound ?? unbound(sid))])
  const out = Object.create(null)
  if (dependencies.length > 0) out.dependencies = sorted(dependencies)
  if (optionalDependencies.length > 0) out.optionalDependencies = sorted(optionalDependencies)
  if (transitive.size > 0) out.transitivePeerDependencies = [...transitive].sort(compareCodePoints)
  if (entry.optional) out.optional = true
  return out
}

// A reference to a package the lockfile has none of is left for the v9
// reader to refuse.
export function restoreSections(packages, importers, settings, patches) {
  const graph = buildGraph(packages, importers)
  const infos = new Map(packages.entries().map(([key, { info }]) => [key, info]))
  const keys = keysOf(graph, infos, settings, patches)
  const unbound = unboundBelow(graph, infos)
  const snapshots = keys.map((key, sid) => [key, entryOf(graph, sid, keys, infos, unbound)])
  const versions = new Map(importers.entries().map(([id, importer]) => {
    const chosen = graph.importerChildren.get(id).byAlias
    return [id, new Map(importer.byAlias.entries().map(([alias, dep]) => [alias, restoredRef(dep.version, chosen.get(alias), keys)]))]
  }))
  return { snapshots, versions }
}
