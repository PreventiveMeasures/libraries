// The `packages` of a lockfile of 13.0 (@pnpm/lockfile, next_format/package.rs):
// one entry per package, with its snapshots listed where it has several, and
// references with no peer or patch group. Each held to what pnpm writes.

import { LockfileError, at, quote } from '../error.js'
import { checkName } from '../names.js'
import { boolean, field, flag, isMapping, mapping, orEmpty, record, sequence, string, text, texts } from '../shape.js'
import { packageKeyOf, refToKey, splitPackageKey } from './key.js'

const ENTRY = [
  'resolution', 'integrity', 'version', 'engines', 'cpu', 'os', 'libc', 'hasBin', 'bundledDependencies',
  'peerDependencies', 'specifiers', 'optional', 'dependencies', 'optionalDependencies', 'unboundPeerDependencies', 'snapshots',
]
const INFO = ['resolution', 'version', 'engines', 'cpu', 'os', 'libc', 'hasBin', 'bundledDependencies', 'peerDependencies', 'peerDependenciesMeta', 'specifiers']
const GRAPH = ['dependencies', 'optionalDependencies', 'peerDependencies', 'unboundPeerDependencies', 'optional']
const REFUSED = {
  prepare: 'a package to prepare after it is fetched is not supported',
  id: 'a snapshot id is not supported',
  deprecated: 'pnpm writes no deprecation in lockfileVersion 13.0',
}
const SNAPSHOT_REFUSED = { id: REFUSED.id }

// `{version, with}` where the bindings in `with` name the snapshot.
function readRef(value, where, alias) {
  if (isMapping(value)) {
    record(value, where, ['version', 'with'])
    if (value.with === undefined) throw new LockfileError('expected "with", as pnpm writes a reference that names no snapshot as its version alone', where)
    return { version: refVersion(value.version, at(where, 'version'), alias), with: readWith(value.with, at(where, 'with')) }
  }
  return { version: refVersion(value, where, alias), with: undefined }
}

export function refVersion(value, where, alias) {
  const version = text(value, where)
  if (version.startsWith('link:')) return version
  const key = refToKey(version, alias)
  if (packageKeyOf(key) !== key) throw new LockfileError(`${quote(version)} carries a peer or patch group, which no reference does in lockfileVersion 13.0`, where)
  return version
}

export const readWith = (value, where) => new Map(Object.entries(mapping(value, where, (item, here, name) => readRef(item, here, checkName(name, here)))))

// A peer: its range alone, or with its meta and binding, `below` where a
// dependency below needs it and the package does not declare it.
function readPeer(value, where, name) {
  if (typeof value === 'string') return { range: value }
  record(value, where, ['specifier', 'version', 'with', 'optional', 'below'])
  const { version, optional, below } = value
  if (below !== undefined && below !== true) throw new LockfileError('expected true, the only value pnpm writes', at(where, 'below'))
  if (version === undefined && (value.with !== undefined || below !== undefined)) throw new LockfileError('a binding with no version', where)
  if (version === undefined && optional === undefined) throw new LockfileError('expected the range alone, as pnpm writes a peer it says nothing more of', where)
  checkName(name, where)
  return {
    range: field(value, 'specifier', where, string),
    optional: field(value, 'optional', where, boolean),
    binding: version === undefined ? undefined : { version: refVersion(version, at(where, 'version'), name), with: field(value, 'with', where, readWith) },
    below: below === true,
  }
}

function readGraph(holder, where, peers) {
  const [own, below] = [new Map(), new Map()]
  for (const [name, peer] of peers) if (peer.binding !== undefined) (peer.below ? below : own).set(name, peer.binding)
  return {
    dependencies: readWith(orEmpty(holder.dependencies), at(where, 'dependencies')),
    optionalDependencies: readWith(orEmpty(holder.optionalDependencies), at(where, 'optionalDependencies')),
    own,
    below,
    unbound: field(holder, 'unboundPeerDependencies', where, texts),
    optional: flag(holder.optional, at(where, 'optional')),
  }
}

// A listed snapshot's peers are bindings alone.
function readSnapshot(value, where) {
  record(value, where, GRAPH, SNAPSHOT_REFUSED)
  const peers = mapping(orEmpty(value.peerDependencies), at(where, 'peerDependencies'), (item, here, name) => {
    record(item, here, ['version', 'with', 'below'])
    if (item.version === undefined) throw new LockfileError('a snapshot\'s peer is a binding, with a version', here)
    return readPeer(item, here, name)
  })
  return readGraph(value, where, Object.entries(peers))
}

const sameRef = (a, b) => a.version === b.version && sameWith(a.with, b.with)
export const sameWith = (a, b) => (a === undefined || b === undefined ? a === b : a.size === b.size && a.entries().every(([name, ref]) => b.has(name) && sameRef(ref, b.get(name))))
const MAPS = ['dependencies', 'optionalDependencies', 'own', 'below']
const MAP_FIELD = { dependencies: 'dependencies', optionalDependencies: 'optionalDependencies', own: 'peerDependencies', below: 'peerDependencies' }

// pnpm writes what every snapshot has alike once, on the package, and on no
// snapshot again.
function overShared(shared, list, where) {
  if (list.length < 2) throw new LockfileError('expected more than one snapshot, as pnpm writes a package of one with none listed', where)
  const [first, ...rest] = list
  for (const map of MAPS) {
    const common = first[map].entries().find(([name, ref]) => rest.every((other) => other[map].has(name) && sameRef(other[map].get(name), ref)))
    if (common !== undefined) throw new LockfileError(`every snapshot has ${quote(common[0])} alike, which pnpm writes once, on the package`, at(`${where}[0]`, MAP_FIELD[map]))
    for (const [index, snapshot] of list.entries()) {
      const again = snapshot[map].keys().find((name) => shared[map].has(name))
      if (again !== undefined) throw new LockfileError(`${quote(again)} is on the package already`, at(at(`${where}[${index}]`, MAP_FIELD[map]), again))
    }
  }
  if (list.every((snapshot) => snapshot.optional)) throw new LockfileError('every snapshot is optional, which pnpm writes once, on the package', where)
  if (shared.optional && list.some((snapshot) => snapshot.optional)) throw new LockfileError('optional on the package already', where)
  const unbound = list.map((snapshot) => snapshot.unbound)
  if (shared.unbound !== undefined && unbound.some((names) => names !== undefined)) throw new LockfileError('unboundPeerDependencies on the package already', where)
  if (unbound[0] !== undefined && unbound.every((names) => names?.join('\0') === unbound[0].join('\0'))) throw new LockfileError('every snapshot has the same unboundPeerDependencies, which pnpm writes once, on the package', where)
  return list.map((snapshot) => ({
    ...Object.fromEntries(MAPS.map((map) => [map, new Map([...snapshot[map], ...shared[map]])])),
    unbound: snapshot.unbound ?? shared.unbound,
    optional: snapshot.optional || shared.optional,
  }))
}

// The resolution as v9 writes it: an integrity alone is a registry tarball's,
// none a directory's of the `file:` key, a tarball's is kept apart.
function resolutionOf(key, entry, where) {
  const { resolution, integrity } = entry
  const { ref } = splitPackageKey(key, where)
  const directory = ref.startsWith('file:') ? ref.slice(5) : undefined
  if (resolution === undefined) {
    if (integrity !== undefined) return { integrity }
    if (directory === undefined) throw new LockfileError('records no resolution, and its key is no directory\'s', where)
    return { type: 'directory', directory }
  }
  const tarball = isMapping(resolution) && resolution.type === undefined
  if (tarball && Object.keys(resolution).every((name) => name === 'integrity')) throw new LockfileError('expected the integrity alone, as pnpm writes a registry package\'s resolution', at(where, 'resolution'))
  if (tarball && resolution.integrity !== undefined) throw new LockfileError('expected the integrity beside the resolution, as pnpm writes it', at(at(where, 'resolution'), 'integrity'))
  if (!tarball && integrity !== undefined) throw new LockfileError('an integrity is a tarball\'s, and pnpm writes none beside another resolution', at(where, 'integrity'))
  if (isMapping(resolution) && resolution.type === 'directory' && resolution.directory === directory) throw new LockfileError('the directory of the key, which pnpm writes no resolution for', at(where, 'resolution'))
  return tarball && integrity !== undefined ? { integrity, ...resolution } : resolution
}

function checkDisjoint({ dependencies, optionalDependencies, own, below }, where) {
  const twice = [...own.keys(), ...below.keys()].find((name) => dependencies.has(name) || optionalDependencies.has(name) || (own.has(name) && below.has(name)))
  const both = dependencies.keys().find((alias) => optionalDependencies.has(alias))
  if (both !== undefined) throw new LockfileError('listed under dependencies too', at(at(where, 'optionalDependencies'), both))
  if (twice !== undefined) throw new LockfileError(`${quote(twice)} is bound as a peer and a dependency, or twice`, at(where, 'peerDependencies'))
}

// Its metadata as a v9 `packages` entry, and its snapshots.
export function readEntry(key, entry, where) {
  record(entry, where, ENTRY, REFUSED)
  const peers = Object.entries(mapping(orEmpty(entry.peerDependencies), at(where, 'peerDependencies'), readPeer))
  const shared = readGraph(entry, where, peers)
  const list = entry.snapshots === undefined ? undefined : sequence(entry.snapshots, at(where, 'snapshots')).map((item, index) => readSnapshot(item, `${at(where, 'snapshots')}[${index}]`))
  const fields = {
    ...entry,
    resolution: resolutionOf(key, entry, where),
    peerDependencies: Object.fromEntries(peers.filter(([, peer]) => peer.range !== undefined).map(([name, peer]) => [name, peer.range])),
    peerDependenciesMeta: Object.fromEntries(peers.filter(([, peer]) => peer.optional !== undefined).map(([name, peer]) => [name, { optional: peer.optional }])),
  }
  const info = Object.fromEntries(INFO.filter((name) => fields[name] !== undefined).map((name) => [name, fields[name]]))
  const snapshots = list === undefined ? [shared] : overShared(shared, list, at(where, 'snapshots'))
  for (const snapshot of snapshots) checkDisjoint(snapshot, where)
  return { info, snapshots }
}
