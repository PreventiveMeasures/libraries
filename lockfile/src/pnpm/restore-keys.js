// The keys and entries of the snapshots restore.js matched up: each key
// built from its providers as pnpm's resolver writes the peer suffix, and
// each entry with its peers among its dependencies again, as a v9 lockfile
// has them (@pnpm/lockfile, next_format/read/keys.rs, entries.rs,
// unbound.rs).

import { sha256 } from '../sha256.js'
import { buildGraph, byCodePoint } from './restore.js'
import { components } from './tarjan.js'

const DEFAULT_MAX_LENGTH = 1000
const UTF8 = new TextEncoder()

// pnpm's linkPathToPeerVersion: a link's path as a peer's version, each run
// of what a file name cannot hold one `+`.
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

// pnpm's createPeerDepGraphHash: the peers sorted and each in parentheses,
// or the sha256 of them in place of them all past `maxLength` bytes.
function peerSuffix(segments, maxLength) {
  const body = segments.toSorted(byCodePoint).join(')(')
  return UTF8.encode(body).length > maxLength ? `(${sha256(body).slice(0, 32)})` : `(${body})`
}

// `(patch_hash=...)` where `patchedDependencies` patches the package: by its
// name and version, else its name, as pnpm's get_patch_info finds it, with
// a version that is none but the key's source taken for one.
function patchGroup(graph, sid, infos, patches) {
  const key = graph.keys[sid]
  const name = graph.names[sid]
  const version = infos.get(key).version ?? key.slice(name.length + 1)
  const hash = patches.get(`${name}@${version}`) ?? patches.get(name)
  return hash === undefined ? '' : `(patch_hash=${hash})`
}

// The peer names on a cycle of the graph from a package's name to the names
// of the peers it binds, which pnpm writes as `name@version` alone.
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
  const found = components(edges.length, (node) => [...edges[node]], () => true)
  return new Set(found.components.filter((component) => component.length > 1 || edges[component[0]].has(component[0])).flat().map((node) => names[node]))
}

// Each snapshot's key: its package's, its patch group, and its peers, each
// a provider's own key or, under dedupePeers, in a peer cycle or for a name
// on a cycle of names, its name and version alone; built providers first.
function keysOf(graph, infos, { dedupePeers, peersSuffixMaxLength = DEFAULT_MAX_LENGTH }, patches) {
  const count = graph.keys.length
  const keys = Array.from({ length: count }, () => undefined)
  const order = components(count, (sid) => graph.providers[sid].flatMap(([, p]) => (p.snapshot === undefined ? [] : [p.snapshot])), (sid) => graph.providers[sid].length > 0)
  const cyclic = dedupePeers ? new Set() : cyclicNames(graph)
  const keyOf = (sid) => {
    const base = `${graph.keys[sid]}${patchGroup(graph, sid, infos, patches)}`
    if (graph.providers[sid].length === 0) return base
    const component = order.componentOf.get(sid)
    const segments = graph.providers[sid].map(([name, provider]) => {
      if (provider.link !== undefined) return `${name}@${linkVersion(provider.link)}`
      if (provider.missing !== undefined) return provider.missing
      const collapsed = dedupePeers || keys[provider.snapshot] === undefined || component === order.componentOf.get(provider.snapshot) || cyclic.has(name)
      // A provider collapsed is its name and version, which its package's
      // key is: `name@version`, of no patch.
      return collapsed ? graph.keys[provider.snapshot] : keys[provider.snapshot]
    })
    return `${base}${peerSuffix(segments, peersSuffixMaxLength)}`
  }
  for (const [sid, providers] of graph.providers.entries()) if (providers.length === 0) keys[sid] = keyOf(sid)
  // Components come after those of their providers, so each is built once
  // every provider outside it is; one built at once takes none of its own.
  for (const members of order.components) {
    const built = members.filter((sid) => graph.providers[sid].length > 0).map((sid) => [sid, keyOf(sid)])
    for (const [sid, key] of built) keys[sid] = key
  }
  return keys
}

// The peers each snapshot and everything below it declare and nothing
// binds, a cycle of dependencies sharing one set; by each snapshot, less
// those its package declares, as its dependents list those.
function unboundBelow(graph, infos) {
  const count = graph.keys.length
  const declared = (sid) => Object.keys(infos.get(graph.keys[sid]).peerDependencies ?? {})
  const own = graph.entries.map((entry, sid) => declared(sid).filter((name) => !entry.own.has(name) && !entry.dependencies.has(name) && !entry.optionalDependencies.has(name)))
  const children = (sid) => graph.children[sid].list.map(([, child]) => child)
  const order = components(count, children, () => true)
  const below = Array.from({ length: count }, () => undefined)
  for (const members of order.components) {
    const component = order.componentOf.get(members[0])
    const outside = members.flatMap(children).filter((child) => order.componentOf.get(child) !== component)
    const set = new Set([...members.flatMap((sid) => own[sid]), ...outside.flatMap((child) => [...below[child]])])
    for (const sid of members) below[sid] = set
  }
  return (sid) => below[sid].difference(new Set(declared(sid)))
}

// A reference made to lead to `key`, in the shape it has: an alias's whole
// key, a version's key past the name.
function withKey(version, key) {
  if (version.startsWith('link:')) return version
  return /^[^:(]*@/u.test(version) ? key : key.slice(key.indexOf('@', 1) + 1)
}

const sorted = (entries) => Object.fromEntries(entries.toSorted(([a], [b]) => byCodePoint(a, b)))

function entryOf(graph, sid, keys, infos, unbound) {
  const entry = graph.entries[sid]
  const child = (alias, ref) => {
    const to = graph.children[sid].byAlias.get(alias)
    return [alias, to === undefined ? ref.version : withKey(ref.version, keys[to])]
  }
  const dependencies = [...entry.dependencies].map(([alias, ref]) => child(alias, ref))
  const optionalDependencies = [...entry.optionalDependencies].map(([alias, ref]) => child(alias, ref))
  const meta = infos.get(graph.keys[sid]).peerDependenciesMeta ?? {}
  for (const [name, ref] of entry.own) {
    const provider = graph.providers[sid].find(([bound]) => bound === name)[1]
    const restored = provider.snapshot === undefined ? ref.version : withKey(ref.version, keys[provider.snapshot])
    ;(meta[name]?.optional ? optionalDependencies : dependencies).push([name, restored])
  }
  const transitive = new Set([...entry.below.keys(), ...(entry.unbound ?? unbound(sid))])
  const out = Object.create(null)
  if (dependencies.length > 0) out.dependencies = sorted(dependencies)
  if (optionalDependencies.length > 0) out.optionalDependencies = sorted(optionalDependencies)
  if (transitive.size > 0) out.transitivePeerDependencies = [...transitive].sort(byCodePoint)
  if (entry.optional) out.optional = true
  return out
}

// The snapshots by their keys, as the v9 `snapshots` are, and each
// importer's dependencies with their versions leading to them, as the v9
// `importers` have them. A reference to a package the lockfile has none of
// is left as it is, for the reader of those to refuse.
export function restoreSections(packages, importers, settings, patches) {
  const graph = buildGraph(packages, importers)
  const infos = new Map(packages.entries().map(([key, { info }]) => [key, info]))
  const keys = keysOf(graph, infos, settings, patches)
  const unbound = unboundBelow(graph, infos)
  const snapshots = keys.map((key, sid) => [key, entryOf(graph, sid, keys, infos, unbound)])
  const versions = new Map(importers.entries().map(([id, importer]) => [id, new Map(importer.byAlias.entries().map(([alias, dep]) => {
    const to = graph.importerChildren.get(id).byAlias.get(alias)
    return [alias, to === undefined ? dep.version : withKey(dep.version, keys[to])]
  }))]))
  return { snapshots, versions }
}
