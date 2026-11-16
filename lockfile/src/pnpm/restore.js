// How pnpm 12.20 and later turn a lockfile of `lockfileVersion: '13.0'` back
// into the snapshots it installs from, keyed with their peers as a v9
// lockfile keys them (@pnpm/lockfile, next_format/read): this is the graph
// of it, and restore-keys.js the keys and entries.
//
// 1. Every reference is matched to one snapshot of the package it names. A
//    package of one snapshot needs no match. A reference with bindings
//    names its snapshot by them; any other is matched to the snapshot whose
//    bindings all agree with the referrer's scope, binding the most names.
// 2. Every peer a snapshot binds is matched to its provider: the snapshot
//    of it that the scope above links under the peer's name. A snapshot's
//    scope is that of the referrer that first reaches it, in a walk from
//    the importers in order.
// 3. Each snapshot's key is built from its providers by the rules pnpm's
//    resolver writes the peer suffix with.
//
// The orders pnpm takes, by name, by importer, by key, are taken here too,
// as each decides which snapshot a tie goes to.

import { refToKey } from './key.js'
import { sameWith } from './next-packages.js'

// Code point order, which is UTF-8's byte order, as Rust sorts a string.
export function byCodePoint(a, b) {
  const length = Math.min(a.length, b.length)
  for (let i = 0; i < length; i++) {
    if (a.codePointAt(i) !== b.codePointAt(i)) return a.codePointAt(i) - b.codePointAt(i)
  }
  return a.length - b.length
}

// pnpm's order of package names: by scope, a name of none first, then by
// the rest.
const partsOf = (name) => (name.startsWith('@') ? [name.slice(1, name.indexOf('/')), name.slice(name.indexOf('/') + 1)] : [undefined, name])
function compareNames(a, b) {
  const [[scopeA, bareA], [scopeB, bareB]] = [partsOf(a), partsOf(b)]
  if ((scopeA === undefined) !== (scopeB === undefined)) return scopeA === undefined ? -1 : 1
  return (scopeA === undefined ? 0 : byCodePoint(scopeA, scopeB)) || byCodePoint(bareA, bareB)
}

const nameOf = (key) => key.slice(0, key.indexOf('@', 1))
export const resolveKey = (version, alias) => (version.startsWith('link:') ? undefined : refToKey(version, alias))
export const bindingsOf = (entry) => [...entry.own, ...entry.below]

// Whether `binding` is the one `wanted` names: its version, and its
// bindings where `wanted` names any.
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

// How a binding stands to the referrer's scope: 1 agrees, 0 absent, -1
// disagrees. A package is in the scope of its own dependencies.
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

// The snapshot none of whose bindings the referrer's scope disagrees with,
// agreeing on the most, then binding the fewest it lacks; the first where
// every one disagrees.
function snapshotInScope(graph, start, count, referrer) {
  let best
  for (let sid = start; sid < start + count; sid++) {
    let [agreeing, absent] = [0, 0]
    const stands = bindingsOf(graph.entries[sid]).map(([name, ref]) => bindingInScope(graph, referrer, name, ref))
    if (stands.includes(-1)) continue
    for (const stand of stands) {
      if (stand === 1) agreeing++
      else absent++
    }
    if (best === undefined || agreeing > best.agreeing || (agreeing === best.agreeing && absent < best.absent)) best = { sid, agreeing, absent }
  }
  return best?.sid ?? start
}

// The snapshot that binds every peer `peers` names as it names it, of the
// fewest bindings.
function snapshotWithBindings(graph, start, count, peers) {
  let best
  for (let sid = start; sid < start + count; sid++) {
    const bindings = bindingsOf(graph.entries[sid])
    const binds = peers.entries().every(([name, wanted]) => bindings.some(([bound, ref]) => bound === name && namesBinding(wanted, ref)))
    if (binds && (best === undefined || bindings.length < best.count)) best = { sid, count: bindings.length }
  }
  return best?.sid
}

function choose(graph, key, peers, referrer) {
  const range = graph.byPackage.get(key)
  if (range === undefined) return undefined
  const [start, count] = range
  if (count === 1) return start
  return (peers === undefined ? undefined : snapshotWithBindings(graph, start, count, peers)) ?? snapshotInScope(graph, start, count, referrer)
}

// A referrer's children, by alias, in pnpm's order of names.
function childrenOf(graph, refs, referrer) {
  const list = []
  for (const [alias, ref] of refs) {
    const key = resolveKey(ref.version, alias)
    const sid = key === undefined ? undefined : choose(graph, key, ref.with, referrer)
    if (sid !== undefined) list.push([alias, sid])
  }
  list.sort(([a], [b]) => compareNames(a, b))
  return { list, byAlias: new Map(list) }
}

// The first referrer of each snapshot, in a walk from the importers in
// order, each one's children pushed in order and taken last first; a
// snapshot no importer reaches starts a walk of its own, in key order.
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
  for (const id of [...graph.importerChildren.keys()].sort(byCodePoint)) {
    for (const [, child] of graph.importerChildren.get(id).list) reach(child, { importer: id })
    drain()
  }
  const unreached = parent.keys().filter((sid) => parent[sid] === undefined).toArray()
  const indexOf = (sid) => sid - graph.byPackage.get(graph.keys[sid])[0]
  unreached.sort((a, b) => byCodePoint(graph.keys[a], graph.keys[b]) || indexOf(a) - indexOf(b))
  for (const sid of unreached) {
    queue.push(sid)
    drain()
  }
  return parent
}

// The snapshot of `start..start + count` linked as `name` in the scope
// `sid` was reached in: under its parent, its parent's parent, and so on up
// to an importer.
function linkedAbove(graph, sid, name, start, count) {
  let referrer = graph.parent[sid]
  for (let steps = 0; referrer !== undefined && steps <= graph.keys.length; steps++) {
    const linked = referrer.importer === undefined
      ? graph.children[referrer.snapshot].byAlias.get(name) ?? (graph.names[referrer.snapshot] === name ? referrer.snapshot : undefined)
      : graph.importerChildren.get(referrer.importer).byAlias.get(name)
    if (linked !== undefined && linked >= start && linked < start + count) return linked
    referrer = referrer.importer === undefined ? graph.parent[referrer.snapshot] : undefined
  }
  return undefined
}

// What provides the peer `name` that `sid` binds to `ref`: a snapshot, a
// link, or a package the lockfile has none of.
function providerOf(graph, sid, name, ref) {
  if (ref.version.startsWith('link:')) return { link: ref.version.slice(5) }
  const key = resolveKey(ref.version, name)
  const range = graph.byPackage.get(key)
  if (range === undefined) return { missing: key }
  const [start, count] = range
  if (count === 1) return { snapshot: start }
  const named = ref.with === undefined ? undefined : snapshotWithBindings(graph, start, count, ref.with)
  return { snapshot: named ?? linkedAbove(graph, sid, name, start, count) ?? snapshotInScope(graph, start, count, { snapshot: sid }) }
}

// `packages` by package key, each with its snapshots; `importers` by id,
// each with its dependencies by alias, `byAlias`, every kind together.
export function buildGraph(packages, importers) {
  const graph = createGraph(packages, importers)
  graph.children = graph.entries.map((entry, sid) => childrenOf(graph, [...entry.dependencies, ...entry.optionalDependencies], { snapshot: sid }))
  graph.importerChildren = new Map(importers.entries().map(([id, importer]) => [id, childrenOf(graph, importer.byAlias, { importer: id })]))
  graph.parent = parentsOf(graph)
  graph.providers = graph.entries.map((entry, sid) => bindingsOf(entry).map(([name, ref]) => [name, providerOf(graph, sid, name, ref)]))
  return graph
}
