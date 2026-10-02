// The packages a lockfile holds: one for each of its `snapshots`, with the
// `packages` entry it is a snapshot of folded in, as pnpm itself reads them.
// A snapshot is a package as resolved in one place in the tree — its peers
// and its patch are in its key — and the entry is what the package is
// wherever it is. Every snapshot has its entry and every entry a snapshot.

import { LockfileError, at, quote } from '../error.js'
import { checkOptional } from '../graph.js'
import { checkName, checkRelative, checkVersion, isVersion, joinRelative } from '../names.js'
import { entries, field, flag, mapping, orEmpty, record, text, textMap, texts } from '../shape.js'
import { refToKey, splitPackageKey, splitSnapshotKey } from './key.js'
import { readResolution } from './resolution.js'

const INFO = ['resolution', 'version', 'name', 'engines', 'cpu', 'os', 'libc', 'deprecated', 'hasBin', 'bundledDependencies', 'peerDependencies', 'peerDependenciesMeta']
const SNAPSHOT = ['dependencies', 'optionalDependencies', 'optional', 'transitivePeerDependencies']

// The prefixes pnpm keeps from naming a registry (its
// RESERVED_VERSION_PREFIXES): a key's source after one of these is a
// directory, a tarball or a repository. Any other `prefix:version` is a
// registry named in the settings, which pnpm 11 writes, and `runtime:` is a
// node, bun or deno binary; neither is read here.
const SOURCES = new Set(['bitbucket', 'catalog', 'custom', 'file', 'git', 'github', 'gitlab', 'http', 'https', 'jsr', 'link', 'npm', 'ssh', 'workspace'])

// A key and its resolution say the same thing twice, and pnpm's reader
// trusts one of them or the other depending on which case it is in, so they
// are held to agree as its writer makes them: a registry version is a
// tarball with an integrity and takes its version from the key; `file:` is
// the very directory or tarball resolved; anything else is fetched from a
// URL, a git repository or a tarball, and carries its version in a field.
// A directory has no version in the lockfile at all.
function readVersion(ref, entry, resolution, where) {
  const { type, tarball } = resolution
  const local = tarball?.startsWith('file:')
  if (isVersion(ref)) {
    if (type !== 'tarball' || resolution.integrity === undefined || local || resolution.gitHosted || resolution.path !== undefined) {
      throw new LockfileError(`expected a registry tarball with an integrity, for the version ${quote(ref)}`, at(where, 'resolution'))
    }
    if (entry.version !== undefined) throw new LockfileError('a registry package has its version in its key', at(where, 'version'))
    return ref
  }
  const scheme = /^([A-Za-z][\w+.-]*):/u.exec(ref)?.[1]
  if (scheme === undefined) throw new LockfileError(`${quote(ref)} is neither a version nor a source`, where)
  if (scheme === 'runtime' || (!SOURCES.has(scheme) && isVersion(ref.slice(scheme.length + 1)))) {
    throw new LockfileError(`${quote(ref)} is from a runtime or a named registry, which is not supported`, where)
  }
  const agrees = scheme === 'file'
    ? ref === (type === 'directory' ? `file:${resolution.directory}` : tarball)
    : type === 'git' || (type === 'tarball' && tarball !== undefined && !local)
  if (!agrees) throw new LockfileError(`${quote(ref)} is not where the resolution says the package comes from`, at(where, 'resolution'))
  if (type === 'directory') {
    if (entry.version !== undefined) throw new LockfileError('a directory has no version in the lockfile', at(where, 'version'))
    return undefined
  }
  if (entry.version === undefined) throw new LockfileError('expected a version, for a package not from the registry', where)
  return checkVersion(entry.version, at(where, 'version'))
}

const names = (value, where) => texts(value, where, checkName)

function readInfo(key, entry, where) {
  record(entry, where, INFO)
  const { name, ref } = splitPackageKey(key, where)
  if (entry.name !== undefined && entry.name !== name) throw new LockfileError(`expected the name in the key, ${quote(name)}`, at(where, 'name'))
  const resolution = readResolution(entry.resolution, at(where, 'resolution'))
  const bundled = entry.bundledDependencies
  return {
    name,
    version: readVersion(ref, entry, resolution, where),
    resolution,
    engines: entry.engines === undefined ? Object.create(null) : textMap(entry.engines, at(where, 'engines')),
    os: field(entry, 'os', where, texts),
    cpu: field(entry, 'cpu', where, texts),
    libc: field(entry, 'libc', where, texts),
    deprecated: field(entry, 'deprecated', where, text),
    hasBin: flag(entry.hasBin, at(where, 'hasBin')),
    bundledDependencies: bundled === undefined || bundled === true ? bundled : names(bundled, at(where, 'bundledDependencies')),
    peerDependencies: textMap(orEmpty(entry.peerDependencies), at(where, 'peerDependencies'), checkName),
    peerDependenciesMeta: readPeersMeta(entry.peerDependenciesMeta, at(where, 'peerDependenciesMeta')),
  }
}

const readPeersMeta = (value, where) => mapping(orEmpty(value), where, (item, here, name) => {
  record(item, here, ['optional'])
  checkName(name, here)
  return { optional: flag(item.optional, at(here, 'optional')) }
})

// What a dependency's reference leads to: the key of a snapshot, or
// `link:` and a directory linked in place, which the lockfile does not
// hold. A link is written relative to `base`, and handed back relative to
// the lockfile's directory.
export function target(ref, alias, base, snapshots, where) {
  if (ref.startsWith('link:')) return `link:${joinRelative(base, checkRelative(ref.slice(5), where))}`
  const key = refToKey(ref, alias)
  if (!(key in snapshots)) throw new LockfileError(`${quote(ref)} leads to ${quote(key)}, which is not in snapshots`, where)
  return key
}

// A snapshot's links are read from the lockfile's directory, as pnpm's
// installer reads them, although its writer leaves a `link:` a directory
// dependency asks for as that dependency wrote it. pnpm writes one into a
// package's own directory, which a `file:` dependency of the package asks
// for, as `link:<root>/` and the path in it; that is refused, as no
// directory from the lockfile's names it. An importer's `link:<root>/` is
// a directory named `<root>`, as pnpm writes one for `link:./<root>/`.
const readTargets = (value, where, snapshots) => mapping(orEmpty(value), where, (ref, here, alias) => {
  const read = text(ref, here)
  if (read === 'link:<root>' || read.startsWith('link:<root>/')) throw new LockfileError(`${quote(read)} leads into the package that asks for it, which is not supported`, here)
  return target(read, checkName(alias, here), '.', snapshots, here)
})

function readSnapshot(entry, where, snapshots) {
  record(entry, where, SNAPSHOT)
  const dependencies = readTargets(entry.dependencies, at(where, 'dependencies'), snapshots)
  const optionalDependencies = readTargets(entry.optionalDependencies, at(where, 'optionalDependencies'), snapshots)
  checkOptional(dependencies, optionalDependencies, where)
  return {
    dependencies,
    optionalDependencies,
    optional: flag(entry.optional, at(where, 'optional')),
    transitivePeerDependencies: entry.transitivePeerDependencies === undefined ? [] : names(entry.transitivePeerDependencies, at(where, 'transitivePeerDependencies')),
  }
}

// `prefix` is where the document is, for messages; `patches` the hashes its
// patchedDependencies hold, which a snapshot's patch hash has to be one of.
export function readPackages(doc, prefix, patches) {
  const infos = new Map()
  const packagesAt = at(prefix, 'packages')
  for (const [key, entry, where] of entries(orEmpty(doc.packages), packagesAt)) infos.set(key, readInfo(key, entry, where))
  const snapshotsAt = at(prefix, 'snapshots')
  const snapshots = record(orEmpty(doc.snapshots), snapshotsAt)
  const packages = Object.create(null)
  const seen = new Set()
  for (const [key, entry, where] of entries(snapshots, snapshotsAt)) {
    const { base, patchHash } = splitSnapshotKey(key, where)
    const info = infos.get(base)
    if (info === undefined) throw new LockfileError(`${quote(base)} is not in packages`, where)
    if (patchHash !== undefined && !patches.has(patchHash)) throw new LockfileError(`the patch hash ${quote(patchHash)} is not in patchedDependencies`, where)
    seen.add(base)
    packages[key] = { ...info, patchHash, ...readSnapshot(entry, where, snapshots) }
  }
  for (const key of infos.keys()) {
    if (!seen.has(key)) throw new LockfileError('no snapshot is of this package', at(packagesAt, key))
  }
  return { packages, snapshots }
}
