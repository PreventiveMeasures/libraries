// uv.lock, `version = 1`, as uv writes it. A package is its name, its
// version and its source, and an edge names one as briefly as tells it
// apart: the name alone where one package has it, else the version and
// the source too. uv drops an extra an edge asks for that its package has
// no list of, and takes `distribution` for `package`; this refuses both.

import { LockfileError, at, quote } from '../error.js'
import { checkMarker, checkNormalName } from '../python/pep508.js'
import { checkNormalVersion, checkSpecifiers, parseVersion, versionKey } from '../python/pep440.js'
import { array, entries, kind, string, strings, table } from '../toml/shape.js'
import { parseToml } from '../toml/parse.js'
import { readSdist, readWheels } from './artifacts.js'
import { names, readConflicts, readManifest, readMetadata, readOptions } from './inputs.js'
import { isTree, readSource } from './source.js'

const TOP = ['version', 'revision', 'requires-python', 'resolution-markers', 'supported-markers', 'required-markers', 'conflicts', 'options', 'manifest', 'package']
const TOP_REFUSED = { distribution: '`distribution` is what uv 0.2 and older wrote for `package`, which is not read here' }
const PACKAGE = ['name', 'version', 'source', 'resolution-markers', 'dependencies', 'sdist', 'wheels', 'optional-dependencies', 'dev-dependencies', 'metadata']
const PACKAGE_REFUSED = { 'dependency-groups': '`dependency-groups` is an older spelling of `dev-dependencies`, which uv no longer writes' }
const EDGE = ['name', 'version', 'source', 'extra', 'marker']

// Revisions 1 to 3 add fields, which older ones lack; 4, which drops a
// package's metadata, uv writes only as a preview.
function checkRevision(value, where) {
  if (value === undefined || value === 1 || value === 2 || value === 3) return value ?? 0
  throw new LockfileError(`unsupported revision: expected 1, 2 or 3, found ${kind(value)}`, where)
}

function checkLockVersion(value, where) {
  if (value === 1) return value
  if (value === undefined) throw new LockfileError('no `version`: a lockfile of uv 0.2 or older, which is not read here', where)
  throw new LockfileError(`unsupported version: expected 1, found ${kind(value)}`, where)
}

const markers = (value, where) => (value === undefined ? [] : strings(value, where).map((marker, index) => checkMarker(marker, `${where}[${index}]`)))

export const keyOf = (name, version, sourceId) => `${name}${version === undefined ? '' : `==${version}`} @ ${sourceId}`

function readEdge(value, where) {
  table(value, where, EDGE)
  const name = checkNormalName(string(value.name, at(where, 'name')), at(where, 'name'))
  const version = value.version === undefined ? undefined : checkNormalVersion(string(value.version, at(where, 'version')), at(where, 'version'))
  const extras = value.extra === undefined ? [] : names(value.extra, at(where, 'extra'))
  const twice = extras.find((extra, index) => extras.indexOf(extra) !== index)
  if (twice !== undefined) throw new LockfileError(`${quote(twice)} is listed twice`, at(where, 'extra'))
  return {
    name,
    version,
    versionKey: version === undefined ? undefined : versionKey(parseVersion(version)),
    source: value.source === undefined ? undefined : readSource(value.source, at(where, 'source')),
    extras,
    marker: value.marker === undefined ? undefined : checkMarker(string(value.marker, at(where, 'marker')), at(where, 'marker')),
    where,
  }
}

const edges = (value, where) => (value === undefined ? [] : array(value, where).map((item, index) => readEdge(item, `${where}[${index}]`)))

function edgeLists(value, where) {
  const lists = Object.create(null)
  if (value !== undefined) for (const [key, list, here] of entries(value, where)) lists[checkNormalName(key, here)] = edges(list, here)
  return lists
}

function readPackage(value, where) {
  table(value, where, PACKAGE, PACKAGE_REFUSED)
  const name = checkNormalName(string(value.name, at(where, 'name')), at(where, 'name'))
  const source = readSource(value.source, at(where, 'source'))
  const version = value.version === undefined ? undefined : checkNormalVersion(string(value.version, at(where, 'version')), at(where, 'version'))
  if (version === undefined && !isTree(source)) throw new LockfileError(`expected a version, which uv writes of any but a source tree's package`, where)
  const identity = { key: keyOf(name, version, source.id), name, version, versionKey: version === undefined ? undefined : versionKey(parseVersion(version)), source }
  return {
    ...identity,
    resolutionMarkers: markers(value['resolution-markers'], at(where, 'resolution-markers')),
    sdist: readSdist(value.sdist, at(where, 'sdist'), source),
    wheels: readWheels(value.wheels, at(where, 'wheels'), identity),
    edges: edges(value.dependencies, at(where, 'dependencies')),
    extraEdges: edgeLists(value['optional-dependencies'], at(where, 'optional-dependencies')),
    groupEdges: edgeLists(value['dev-dependencies'], at(where, 'dev-dependencies')),
    metadata: readMetadata(value.metadata, at(where, 'metadata')),
  }
}

// uv's PackageIdForDependency::unwire, strict: a source left out is the
// one package of the name's; a version left out is that package's, or none,
// for a source tree's of a dynamic version.
const idOf = (name, key, sourceId) => `${name} ${key} ${sourceId}`

// `index` has each package by name, as a list, and by its identity.
function resolveEdge(edge, index) {
  const fail = (why) => {
    throw new LockfileError(why, edge.where)
  }
  const named = index.byName.get(edge.name) ?? fail(`${quote(edge.name)} names no package in the lockfile`)
  const only = named.length === 1 ? named[0] : undefined
  const sourceId = edge.source?.id ?? only?.source.id ?? fail(`${quote(edge.name)} could be any of ${named.length} packages, and names no source`)
  let key = only?.versionKey
  if (edge.version !== undefined) key = edge.versionKey
  else if (only === undefined && !isTree(edge.source)) fail(`${quote(edge.name)} could be any of ${named.length} versions, and names none`)
  const found = index.byId.get(idOf(edge.name, key, sourceId)) ?? fail(`names a package the lockfile does not hold: ${quote(keyOf(edge.name, edge.version, sourceId))}`)
  if (edge.version !== undefined && edge.version !== found.version) fail(`${quote(edge.version)}, where the package is ${quote(found.version)}`)
  for (const extra of edge.extras) {
    if (!(extra in found.extraEdges)) fail(`${quote(extra)}, an extra ${quote(found.key)} has no dependencies for, which uv drops`)
  }
  return { package: found.key, extras: edge.extras, marker: edge.marker }
}

function resolveAll(list, index, where) {
  const resolved = list.map((edge) => resolveEdge(edge, index))
  const seen = new Set()
  for (const edge of resolved) {
    const id = JSON.stringify([edge.package, [...edge.extras].sort(), edge.marker])
    if (seen.has(id)) throw new LockfileError(`${quote(edge.package)} is listed twice alike`, where)
    seen.add(id)
  }
  return resolved
}

function resolveLists(lists, index, where) {
  const resolved = Object.create(null)
  for (const [key, list] of Object.entries(lists)) resolved[key] = resolveAll(list, index, at(where, key))
  return resolved
}

// The workspace's own packages: its members, each a source tree, or the
// one at its root where it names none.
function membersOf(manifest, read) {
  if (manifest.members.length === 0) return read.filter((pkg) => isTree(pkg.source) && pkg.source.path === '.').map((pkg) => pkg.key)
  return manifest.members.map((name, index) => {
    const found = read.filter((pkg) => pkg.name === name && isTree(pkg.source))
    if (found.length !== 1) throw new LockfileError(`${quote(name)} is ${found.length === 0 ? 'no package' : 'more than one package'} of a directory in the lockfile`, `manifest.members[${index}]`)
    return found[0].key
  })
}

export function parseUvLock(text) {
  if (typeof text !== 'string') throw new TypeError('expected a string')
  const doc = table(parseToml(text), undefined, TOP, TOP_REFUSED)
  const version = checkLockVersion(doc.version, 'version')
  const revision = checkRevision(doc.revision, 'revision')
  const requiresPython = checkSpecifiers(string(doc['requires-python'], 'requires-python'), 'requires-python')
  const read = array(doc.package ?? [], 'package').map((item, index) => readPackage(item, `package[${index}]`))
  const index = { byName: Map.groupBy(read, (pkg) => pkg.name), byId: new Map() }
  for (const [i, pkg] of read.entries()) {
    const id = idOf(pkg.name, pkg.versionKey, pkg.source.id)
    if (index.byId.has(id)) throw new LockfileError(`${quote(pkg.key)} is listed twice, first as package[${read.indexOf(index.byId.get(id))}]`, `package[${i}]`)
    index.byId.set(id, pkg)
  }
  const packages = Object.create(null)
  for (const [i, pkg] of read.entries()) {
    const where = `package[${i}]`
    packages[pkg.key] = {
      name: pkg.name,
      version: pkg.version,
      source: pkg.source,
      resolutionMarkers: pkg.resolutionMarkers,
      dependencies: resolveAll(pkg.edges, index, at(where, 'dependencies')),
      optionalDependencies: resolveLists(pkg.extraEdges, index, at(where, 'optional-dependencies')),
      devDependencies: resolveLists(pkg.groupEdges, index, at(where, 'dev-dependencies')),
      sdist: pkg.sdist,
      wheels: pkg.wheels,
      metadata: pkg.metadata,
    }
  }
  const manifest = readManifest(doc.manifest)
  return {
    version,
    revision,
    requiresPython,
    resolutionMarkers: markers(doc['resolution-markers'], 'resolution-markers'),
    supportedMarkers: markers(doc['supported-markers'], 'supported-markers'),
    requiredMarkers: markers(doc['required-markers'], 'required-markers'),
    conflicts: readConflicts(doc.conflicts),
    options: readOptions(doc.options),
    manifest,
    members: membersOf(manifest, read),
    packages,
  }
}
