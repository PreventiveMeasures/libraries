// pnpm 12.20's next_format/read: each reference matched to a snapshot, each
// peer to its provider, by the scope a walk from the importers reaches it in.
// pnpm's orders decide ties, so they are kept; restore-keys.js builds keys.

import { compareCodePoints } from '../order.js'
import { refToKey } from './key.js'
import { sameWith } from './next-packages.js'

// pnpm's order of names: unscoped first, then by scope and name.
const partsOf = (name) => (name.startsWith('@') ? [name.slice(1, name.indexOf('/')), name.slice(name.indexOf('/') + 1)] : [undefined, name])
function compareNames(a, b) {
  const [[scopeA, bareA], [scopeB, bareB]] = [partsOf(a), partsOf(b)]
  if ((scopeA === undefined) !== (scopeB === undefined)) return scopeA === undefined ? -1 : 1
  return (scopeA === undefined ? 0 : compareCodePoints(scopeA, scopeB)) || compareCodePoints(bareA, bareB)
}

const nameOf = (key) => key.slice(0, key.indexOf('@', 1))
const resolveKey = (version, alias) => (version.startsWith('link:') ? undefined : refToKey(version, alias))
const bindingsOf = (entry) => [...entry.own, ...entry.below]

const namesBinding = (wanted, binding) => wanted.version === binding.version
  && (wanted.with === undefined || (binding.with === undefined ? wanted.with.size === 0 : sameWith(binding.with, wanted.with)))

function inScope(entry, name) {
  return entry.dependencies.get(name) ?? entry.optionalDependencies.get(name) ?? entry.own.get(name) ?? entry.below.get(name)
}

function sameTarget(name, a, b) {
  const [linkA, linkB] = [a.version.startsWith('link:'), b.version.startsWith('link:')]
  if (linkA || linkB) return linkA && linkB && a.version === b.version
  return resolveKey(a.version, name) === resolveKey(b.version, name)
}

function createGraph(packages, importers) {
  const graph = { keys: [], names: [], entries: [], byPackage: new Map(), importers }
  for (const [key, { snapshots }] of packages) {
    graph.byPackage.set(key, [graph.keys.length, snapshots.length])
    for (const entry of snapshots) {
      graph.keys.push(key)
      graph.names.push(nameOf(key))
      graph.entries.push(entry)
    }
  }
  return graph
}

// 1 agrees, 0 absent, -1 disagrees. A package is in the scope of its own
// dependencies.
function bindingInScope(graph, referrer, name, ref) {
  if (referrer.importer !== undefined) {
    const dep = graph.importers.get(referrer.importer).byAlias.get(name)
    if (dep === undefined) return 0
    return sameTarget(name, dep, ref) ? 1 : -1
  }
  const sid = referrer.snapshot
  const scoped = inScope(graph.entries[sid], name)
  if (scoped !== undefined) return sameTarget(name, scoped, ref) ? 1 : -1
  return graph.names[sid] === name && resolveKey(ref.version, name) === graph.keys[sid] ? 1 : 0
}

// Of those the scope does not disagree with, the one it agrees with most,
// then lacks fewest; the first where it disagrees with all.
function snapshotInScope(graph, start, count, referrer) {
  let best
  for (let sid = start; sid < start + count; sid++) {
    const stands = bindingsOf(graph.entries[sid]).map(([name, ref]) => bindingInScope(graph, referrer, name, ref))
    if (stands.includes(-1)) continue
    const agreeing = stands.filter((stand) => stand === 1).length
    const absent = stands.length - agreeing
    if (best === undefined || agreeing > best.agreeing || (agreeing === best.agreeing && absent < best.absent)) best = { sid, agreeing, absent }
  }
  return best?.sid ?? start
}

// Of those binding all `peers` name, the one of the fewest bindings.
function snapshotWithBindings(graph, start, count, peers) {
  if (peers === undefined) return undefined
  let best
  for (let sid = start; sid < start + count; sid++) {
    const { own, below } = graph.entries[sid]
    const binds = peers.entries().every(([name, wanted]) => {
      const bound = own.get(name) ?? below.get(name)
      return bound !== undefined && namesBinding(wanted, bound)
    })
    if (binds && (best === undefined || own.size + below.size < best.count)) best = { sid, count: own.size + below.size }
  }
  return best?.sid
}

function snapshotOf(graph, key, peers, otherwise) {
  const range = graph.byPackage.get(key)
  if (range === undefined) return undefined
  const [start, count] = range
  if (count === 1) return start
  return snapshotWithBindings(graph, start, count, peers) ?? otherwise(start, count)
}

function childrenOf(graph, refs, referrer) {
  const list = []
  for (const [alias, ref] of refs) {
    const key = resolveKey(ref.version, alias)
    const sid = key === undefined ? undefined : snapshotOf(graph, key, ref.with, (start, count) => snapshotInScope(graph, start, count, referrer))
    if (sid !== undefined) list.push([alias, sid])
  }
  list.sort(([a], [b]) => compareNames(a, b))
  return { list, byAlias: new Map(list) }
}

// The first referrer of each snapshot: a depth-first walk from each importer
// in order, then from each snapshot none reaches, in key order.
function parentsOf(graph) {
  const count = graph.keys.length
  const parent = Array.from({ length: count }, () => undefined)
  const visited = Array.from({ length: count }, () => false)
  const queue = []
  const reach = (sid, referrer) => {
    parent[sid] ??= referrer
    queue.push(sid)
  }
  const drain = () => {
    while (queue.length > 0) {
      const sid = queue.pop()
      if (visited[sid]) continue
      visited[sid] = true
      for (const [, child] of graph.children[sid].list) if (!visited[child]) reach(child, { snapshot: sid })
    }
  }
  for (const id of [...graph.importerChildren.keys()].sort(compareCodePoints)) {
    for (const [, child] of graph.importerChildren.get(id).list) reach(child, { importer: id })
    drain()
  }
  const unreached = parent.keys().filter((sid) => parent[sid] === undefined).toArray()
  unreached.sort((a, b) => compareCodePoints(graph.keys[a], graph.keys[b]))
  for (const sid of unreached) {
    queue.push(sid)
    drain()
  }
  return parent
}

// The candidate linked as `name` by the nearest referrer up the parents;
// a parent is reached before its child, so the walk ends.
function linkedAbove(graph, sid, name, start, count) {
  let referrer = graph.parent[sid]
  while (referrer !== undefined) {
    const linked = referrer.importer === undefined
      ? graph.children[referrer.snapshot].byAlias.get(name) ?? (graph.names[referrer.snapshot] === name ? referrer.snapshot : undefined)
      : graph.importerChildren.get(referrer.importer).byAlias.get(name)
    if (linked !== undefined && linked >= start && linked < start + count) return linked
    referrer = referrer.importer === undefined ? graph.parent[referrer.snapshot] : undefined
  }
  return undefined
}

function providerOf(graph, sid, name, ref) {
  if (ref.version.startsWith('link:')) return { link: ref.version.slice(5) }
  const key = resolveKey(ref.version, name)
  const snapshot = snapshotOf(graph, key, ref.with, (start, count) => linkedAbove(graph, sid, name, start, count) ?? snapshotInScope(graph, start, count, { snapshot: sid }))
  return snapshot === undefined ? { missing: key } : { snapshot }
}

export function buildGraph(packages, importers) {
  const graph = createGraph(packages, importers)
  graph.children = graph.entries.map((entry, sid) => childrenOf(graph, [...entry.dependencies, ...entry.optionalDependencies], { snapshot: sid }))
  graph.importerChildren = new Map(importers.entries().map(([id, importer]) => [id, childrenOf(graph, importer.byAlias, { importer: id })]))
  graph.parent = parentsOf(graph)
  graph.providers = graph.entries.map((entry, sid) => bindingsOf(entry).map(([name, ref]) => [name, providerOf(graph, sid, name, ref)]))
  return graph
}
