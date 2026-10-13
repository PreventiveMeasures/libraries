// The packages a lockfile holds: one for each of its `snapshots`, with the
// `packages` entry it is a snapshot of folded in, as pnpm itself reads them.
// A snapshot is a package as resolved in one place in the tree -- its peers
// and its patch are in its key -- and the entry is what the package is
// wherever it is. Every snapshot has its entry and every entry a snapshot.

import { LockfileError, at, quote } from '../error.js'
import { readLists } from '../graph.js'
import { checkName, checkRegistryTarball, checkVersion, isVersion, joinRelative } from '../names.js'
import { entries, field, flag, mapping, orEmpty, record, text, textMap, texts } from '../shape.js'
import { packageKeyOf, refToKey, splitPackageKey, splitSnapshotKey } from './key.js'
import { readRelative, readResolution } from './resolution.js'

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
// tarball with an integrity and takes its version from the key, and one
// from npm's registry is that registry's tarball of the name and version;
// `file:` is the very directory or tarball resolved; anything else is
// fetched from a URL, a git repository or a tarball, and carries its
// version in a field. A directory has no version in the lockfile at all,
// and its key has the path as written, empty for the lockfile's own.
// pnpm's writer also puts the version in a field for a registry package
// whose snapshot key has a `:` in it, which a source among its peers puts
// there; the field is then the key's version again.
function readVersion(name, ref, entry, resolution, where) {
  const { type, tarball } = resolution
  const local = tarball?.startsWith('file:')
  if (isVersion(ref)) {
    if (type !== 'tarball' || resolution.integrity === undefined || local || resolution.gitHosted || resolution.path !== undefined) {
      throw new LockfileError(`expected a registry tarball with an integrity, for the version ${quote(ref)}`, at(where, 'resolution'))
    }
    if (entry.version !== undefined && entry.version !== ref) throw new LockfileError(`expected the version in the key, ${quote(ref)}`, at(where, 'version'))
    if (tarball !== undefined) checkRegistryTarball(tarball, name, ref, at(at(where, 'resolution'), 'tarball'))
    return ref
  }
  const scheme = /^([A-Za-z][\w+.-]*):/u.exec(ref)?.[1]
  if (scheme === undefined) throw new LockfileError(`${quote(ref)} is neither a version nor a source`, where)
  if (scheme === 'runtime' || (!SOURCES.has(scheme) && isVersion(ref.slice(scheme.length + 1)))) {
    throw new LockfileError(`${quote(ref)} is from a runtime or a named registry, which is not supported`, where)
  }
  const agrees = scheme === 'file'
    ? ref === (type === 'directory' ? `file:${entry.resolution.directory}` : tarball)
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
    version: readVersion(name, ref, entry, resolution, where),
    resolution,
    engines: textMap(orEmpty(entry.engines), at(where, 'engines')),
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

// A mapping by package name, each a record of the `fields` named, as
// `read(item, where)` makes it.
export const byName = (fields, read) => (value, where) => mapping(orEmpty(value), where, (item, here, name) => {
  record(item, here, fields)
  checkName(name, here)
  return read(item, here)
})

const readPeersMeta = byName(['optional'], (item, here) => ({ optional: flag(item.optional, at(here, 'optional')) }))

// What a dependency's reference leads to: the key of a snapshot, or
// `link:` and a directory linked in place, which the lockfile does not
// hold. A link is written relative to `base`, and handed back relative to
// the lockfile's directory.
export function target(ref, alias, base, snapshots, where) {
  if (ref.startsWith('link:')) return `link:${joinRelative(base, readRelative(ref.slice(5), where))}`
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
  return {
    ...readLists(entry, where, (value, here) => readTargets(value, here, snapshots)),
    optional: flag(entry.optional, at(where, 'optional')),
    transitivePeerDependencies: field(entry, 'transitivePeerDependencies', where, names) ?? [],
  }
}

// pnpm's createPeerDepGraphHash past peersSuffixMaxLength: an md5 in base32
// from pnpm 9, a sha256 in hex cut to 32 from pnpm 10.
const HASHED = /^(?:[a-z2-7]{26}|[\da-f]{32})$/u

// The name a peer group starts with, before its version or source; `''`
// where it has none.
function nameOf(group) {
  const sep = group.indexOf('@', 1)
  return sep === -1 ? '' : group.slice(0, sep)
}

// The peers a snapshot key ends in, as pnpm's resolvePeers writes them:
// each a dependency of the snapshot, by its key, by its name and version as
// dedupePeers and a cycle of peers write it, or a link by its alias and
// the directory, `/` made `+`; else a peer it resolves for its
// dependencies, where it has transitivePeerDependencies, by the key of a
// snapshot or a package, by a name and version, or by the alias of one
// among them and a directory, which no version is; or one hash in place
// of them all. Whatever else the key would say it was resolved with, the
// lockfile does not have.
function checkPeers(groups, snapshot, infos, known, where) {
  if (groups.length === 1 && HASHED.test(groups[0])) return
  const targets = Object.entries({ ...snapshot.dependencies, ...snapshot.optionalDependencies })
  const asDependency = (group) => targets.some(([alias, to]) => {
    if (to.startsWith('link:')) return nameOf(group) === alias && !group.includes('(')
    const info = infos.get(packageKeyOf(to))
    return group === to || group === `${info.name}@${info.version}` || (info.version === undefined && nameOf(group) === info.name && !group.includes('('))
  })
  const transitive = snapshot.transitivePeerDependencies
  for (const group of groups) {
    if (nameOf(group) === '') throw new LockfileError(`${quote(group)} is not a peer, as pnpm writes one in a key`, where)
    if (asDependency(group)) continue
    const linked = !group.includes('(') && transitive.includes(nameOf(group)) && !isVersion(group.slice(nameOf(group).length + 1))
    if (transitive.length > 0 && (known.has(group) || linked)) continue
    throw new LockfileError(`the peer ${quote(group)} is not one of its dependencies, nor a peer of theirs it resolves`, where)
  }
}

// The patch pnpm applies to a package, as getPatchInfo finds it: by its
// name and version, else by its name alone; whose selector the caller
// marks used. A package of no version a selector of a version may name is
// not decided here.
function patchOf(info, patches, used, where) {
  const exact = info.version === undefined ? undefined : `${info.name}@${info.version}`
  if (info.version === undefined && [...patches.keys()].some((selector) => selector.startsWith(`${info.name}@`))) {
    throw new LockfileError(`a package of no version in the lockfile, which a patch of a version of ${quote(info.name)} may be of`, where)
  }
  const selector = [exact, info.name].find((key) => key !== undefined && patches.has(key))
  if (selector === undefined) return undefined
  used.add(selector)
  return { selector, hash: patches.get(selector).hash }
}

// `prefix` is where the document is, for messages; `patches` its
// patchedDependencies, by selector, each of which patches a package, and
// a package with a patch hash is patched by one.
export function readPackages(doc, prefix, patches) {
  const infos = new Map()
  // Where a registry package has its version in a field too, until a
  // snapshot of it is found with a source in its peers: a registry package
  // is one whose key is its name and version.
  const versioned = new Map()
  const packagesAt = at(prefix, 'packages')
  for (const [key, entry, where] of entries(orEmpty(doc.packages), packagesAt)) {
    const info = readInfo(key, entry, where)
    infos.set(key, info)
    if (entry.version !== undefined && key === `${info.name}@${info.version}`) versioned.set(key, at(where, 'version'))
  }
  const snapshotsAt = at(prefix, 'snapshots')
  const snapshots = record(orEmpty(doc.snapshots), snapshotsAt)
  // What a peer of a peer may be named by: a snapshot, a package, or a
  // package's name and version.
  const known = new Set([...Object.keys(snapshots), ...infos.keys(), ...[...infos.values()].map((info) => `${info.name}@${info.version}`)])
  const seen = new Set()
  const used = new Set()
  const packages = mapping(snapshots, snapshotsAt, (entry, where, key) => {
    const { base, patchHash, peers } = splitSnapshotKey(key, where)
    const info = infos.get(base)
    if (info === undefined) throw new LockfileError(`${quote(base)} is not in packages`, where)
    const patch = patchOf(info, patches, used, where)
    if (patch?.hash !== patchHash) {
      const expected = patch === undefined ? 'none, as patchedDependencies patches no such package' : `${quote(patch.hash)}, of patchedDependencies[${quote(patch.selector)}]`
      throw new LockfileError(`expected the patch hash ${expected}, found ${patchHash === undefined ? 'none' : quote(patchHash)}`, where)
    }
    seen.add(base)
    if (key.includes(':')) versioned.delete(base)
    const snapshot = readSnapshot(entry, where, snapshots)
    checkPeers(peers, snapshot, infos, known, where)
    return { ...info, patchHash, ...snapshot }
  })
  for (const key of infos.keys()) {
    if (!seen.has(key)) throw new LockfileError('no snapshot is of this package', at(packagesAt, key))
  }
  const unused = [...patches.keys()].find((selector) => !used.has(selector))
  if (unused !== undefined) throw new LockfileError('patches no package in the lockfile, which pnpm refuses to install with', at(at(prefix, 'patchedDependencies'), unused))
  for (const where of versioned.values()) {
    throw new LockfileError('a registry package has its version in its key, except where a snapshot of it has a source in its peers', where)
  }
  return { packages, snapshots }
}
