// uv.lock, `version = 1`, as uv writes it. A package is its name, its
// version and its source, and an edge names one as briefly as tells it
// apart: the name alone where one package has it, else the version and
// the source too. uv drops an extra an edge asks for that its package has
// no list of, and takes `distribution` for `package`; this refuses both.

import { LockfileError, at, quote } from '../error.js'
import { checkMarker, checkNormalName } from '../python/pep508.js'
import { checkNormalVersion, checkSpecifiers, versionKeyOf } from '../python/pep440.js'
import { field } from '../shape.js'
import { arrayOf, distinct, kind, table, tableOf } from '../toml/shape.js'
import { parseToml } from '../toml/parse.js'
import { readSdist, readWheels } from './artifacts.js'
import { readConflicts, readManifest, readMetadata, readOptions } from './inputs.js'
import { byName, names } from './shape.js'
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

const markers = (value, where) => (value === undefined ? [] : arrayOf(checkMarker)(value, where))

const extrasOf = (value, where) => distinct(names(value, where), where)

const keyOf = (name, version, sourceId) => `${name}${version === undefined ? '' : `==${version}`} @ ${sourceId}`

function readEdge(value, where) {
  table(value, where, EDGE)
  return {
    name: checkNormalName(value.name, at(where, 'name')),
    version: field(value, 'version', where, checkNormalVersion),
    source: field(value, 'source', where, readSource),
    extras: field(value, 'extra', where, extrasOf) ?? [],
    marker: field(value, 'marker', where, checkMarker),
    where,
  }
}

const edges = (value, where) => (value === undefined ? [] : arrayOf(readEdge)(value, where))

// A package, with its key and its version's; its edges are as written
// until every package is read, and parseUvLock resolves them.
function readPackage(value, where) {
  table(value, where, PACKAGE, PACKAGE_REFUSED)
  const name = checkNormalName(value.name, at(where, 'name'))
  const source = readSource(value.source, at(where, 'source'))
  const version = field(value, 'version', where, checkNormalVersion)
  if (version === undefined && !isTree(source)) throw new LockfileError(`expected a version, which uv writes of any but a source tree's package`, where)
  const versionKey = version === undefined ? undefined : versionKeyOf(version)
  const pkg = {
    name,
    version,
    source,
    resolutionMarkers: markers(value['resolution-markers'], at(where, 'resolution-markers')),
    dependencies: edges(value.dependencies, at(where, 'dependencies')),
    optionalDependencies: byName(value['optional-dependencies'], at(where, 'optional-dependencies'), edges),
    devDependencies: byName(value['dev-dependencies'], at(where, 'dev-dependencies'), edges),
    sdist: readSdist(value.sdist, at(where, 'sdist'), source),
    wheels: readWheels(value.wheels, at(where, 'wheels'), { name, version, versionKey, source }),
    metadata: readMetadata(value.metadata, at(where, 'metadata')),
  }
  return { key: keyOf(name, version, source.id), versionKey, pkg }
}

const idOf = (name, key, sourceId) => `${name} ${key} ${sourceId}`

// uv's PackageIdForDependency::unwire, strict: a source left out is the
// one package of the name's; a version left out is that package's, or none,
// for a source tree's of a dynamic version. `index` has each package by
// name, as a list, and by its identity.
function resolveEdge(edge, index) {
  const fail = (why) => {
    throw new LockfileError(why, edge.where)
  }
  const named = index.byName.get(edge.name) ?? fail(`${quote(edge.name)} names no package in the lockfile`)
  const only = named.length === 1 ? named[0] : undefined
  const sourceId = edge.source?.id ?? only?.pkg.source.id ?? fail(`${quote(edge.name)} could be any of ${named.length} packages, and names no source`)
  if (edge.version === undefined && only === undefined && !isTree(edge.source)) fail(`${quote(edge.name)} could be any of ${named.length} versions, and names none`)
  const versionKey = edge.version === undefined ? only?.versionKey : versionKeyOf(edge.version)
  const { key, pkg } = index.byId.get(idOf(edge.name, versionKey, sourceId)) ?? fail(`names a package the lockfile does not hold: ${quote(keyOf(edge.name, edge.version, sourceId))}`)
  if (edge.version !== undefined && edge.version !== pkg.version) fail(`${quote(edge.version)}, where the package is ${quote(pkg.version)}`)
  for (const extra of edge.extras) {
    if (!(extra in pkg.optionalDependencies)) fail(`${quote(extra)}, an extra ${quote(key)} has no dependencies for, which uv drops`)
  }
  return { package: key, extras: edge.extras, marker: edge.marker }
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

// The workspace's own packages: its members, each a source tree, or the
// one at its root where it names none.
function membersOf(manifest, read, lookup) {
  if (manifest.members.length === 0) return read.filter(({ pkg }) => isTree(pkg.source) && pkg.source.path === '.').map(({ key }) => key)
  return manifest.members.map((name, index) => {
    const found = (lookup.byName.get(name) ?? []).filter(({ pkg }) => isTree(pkg.source))
    if (found.length !== 1) throw new LockfileError(`${quote(name)} is ${found.length === 0 ? 'no package' : 'more than one package'} of a directory in the lockfile`, `manifest.members[${index}]`)
    return found[0].key
  })
}

export function parseUvLock(text) {
  if (typeof text !== 'string') throw new TypeError('expected a string')
  const doc = table(parseToml(text), undefined, TOP, TOP_REFUSED)
  const version = checkLockVersion(doc.version, 'version')
  const revision = checkRevision(doc.revision, 'revision')
  const requiresPython = checkSpecifiers(doc['requires-python'], 'requires-python')
  const read = arrayOf(readPackage)(doc.package ?? [], 'package')
  const index = { byName: Map.groupBy(read, ({ pkg }) => pkg.name), byId: new Map() }
  for (const [i, entry] of read.entries()) {
    const id = idOf(entry.pkg.name, entry.versionKey, entry.pkg.source.id)
    if (index.byId.has(id)) throw new LockfileError(`${quote(entry.key)} is listed twice, first as package[${read.indexOf(index.byId.get(id))}]`, `package[${i}]`)
    index.byId.set(id, entry)
  }
  const resolve = (list, where) => resolveAll(list, index, where)
  const packages = Object.create(null)
  for (const [i, { key, pkg }] of read.entries()) {
    const where = `package[${i}]`
    pkg.dependencies = resolve(pkg.dependencies, at(where, 'dependencies'))
    pkg.optionalDependencies = tableOf(pkg.optionalDependencies, at(where, 'optional-dependencies'), resolve)
    pkg.devDependencies = tableOf(pkg.devDependencies, at(where, 'dev-dependencies'), resolve)
    packages[key] = pkg
  }
  const manifest = readManifest(doc.manifest)
  return {
    version,
    revision,
    requiresPython,
    resolutionMarkers: markers(doc['resolution-markers'], 'resolution-markers'),
    supportedMarkers: markers(doc['supported-markers'], 'supported-markers'),
    requiredMarkers: markers(doc['required-markers'], 'required-markers'),
    conflicts: field(doc, 'conflicts', '', readConflicts) ?? [],
    options: readOptions(doc.options),
    manifest,
    members: membersOf(manifest, read, index),
    packages,
  }
}
