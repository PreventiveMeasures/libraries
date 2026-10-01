// poetry.lock, `lock-version` 2.0 or 2.1, as Poetry 1.5 to 2.3 write it.
// Of 2.1, from Poetry 2, each package has the groups it is in, and where
// each needs it, which is what Poetry installs from; of 2.0 there is
// neither, and Poetry solves the lockfile again for them.

import { LockfileError, at, quote } from '../error.js'
import { parseVersion, versionKey } from '../python/pep440.js'
import { checkMarker, checkName, normalName } from '../python/pep508.js'
import { array, boolean, entries, string, strings, table } from '../toml/shape.js'
import { parseToml } from '../toml/parse.js'
import { isTable } from '../toml/value.js'
import { readDependencies, readExtras, readFiles, readSource, readVersion, text } from './package.js'

const TOP = ['package', 'extras', 'metadata']
const PACKAGE = ['name', 'version', 'description', 'optional', 'python-versions', 'files', 'dependencies', 'extras', 'source', 'develop']
const GROUPED = [...PACKAGE, 'groups', 'markers']
const PACKAGE_REFUSED = { category: '`category` is lock-version 1, which Poetry 1.4 and older write and is not read here' }

function readLockVersion(value, where) {
  if (value === '2.0' || value === '2.1') return value
  if (typeof value === 'string' && /^1\.\d+$/u.test(value)) throw new LockfileError(`lock-version ${value} is Poetry 1.4's or older, which is not read here`, where)
  throw new LockfileError(`unsupported lock-version: expected "2.0" or "2.1", found ${JSON.stringify(value) ?? 'nothing'}`, where)
}

function readMetadata(value) {
  table(value, 'metadata', ['lock-version', 'python-versions', 'content-hash'], {
    files: 'metadata.files is lock-version 1, which is not read here',
    hashes: 'metadata.hashes is lock-version 1, which is not read here',
  })
  const here = (key) => at('metadata', key)
  const contentHash = string(value['content-hash'], here('content-hash'))
  if (!/^[\da-f]{64}$/u.test(contentHash)) throw new LockfileError(`${quote(contentHash)} is not a hex sha256`, here('content-hash'))
  return { lockVersion: readLockVersion(value['lock-version'], here('lock-version')), pythonVersions: text(value['python-versions'], here('python-versions')), contentHash }
}

// Each group's marker, by group; a string is every group's. A group the
// table leaves out needs it everywhere: undefined.
function readMarkers(value, groups, where) {
  const markers = Object.create(null)
  for (const group of groups) markers[group] = undefined
  if (value === undefined) return markers
  if (typeof value === 'string') {
    for (const group of groups) markers[group] = checkMarker(value, where)
    return markers
  }
  for (const [group, marker, here] of entries(value, where)) {
    if (!groups.includes(group)) throw new LockfileError(`${quote(group)} is not one of the package's groups`, here)
    markers[group] = checkMarker(string(marker, here), here)
  }
  return markers
}

function readGroups(value, where) {
  const groups = strings(value, where).map((group, index) => checkName(group, `${where}[${index}]`))
  if (groups.length === 0) throw new LockfileError('expected a group at least', where)
  const twice = groups.find((group, index) => groups.findIndex((other) => normalName(other) === normalName(group)) !== index)
  if (twice !== undefined) throw new LockfileError(`${quote(twice)} is listed twice`, where)
  return groups
}

function readPackage(value, where, lockVersion) {
  table(value, where, lockVersion === '2.1' ? GROUPED : PACKAGE, PACKAGE_REFUSED)
  const source = readSource(value.source, at(where, 'source'))
  const hasDevelop = source?.type === 'directory' || source?.type === 'git'
  if (hasDevelop !== (value.develop !== undefined)) throw new LockfileError(hasDevelop ? 'expected develop, which Poetry writes of a directory or a git source' : 'develop, which Poetry writes of a directory or a git source alone', hasDevelop ? where : at(where, 'develop'))
  const groups = lockVersion === '2.1' ? readGroups(value.groups, at(where, 'groups')) : undefined
  return {
    name: checkName(string(value.name, at(where, 'name')), at(where, 'name')),
    version: readVersion(value.version, at(where, 'version')),
    description: value.description === undefined ? '' : string(value.description, at(where, 'description')),
    optional: boolean(value.optional, at(where, 'optional')),
    pythonVersions: text(value['python-versions'], at(where, 'python-versions')),
    groups,
    markers: groups === undefined ? undefined : readMarkers(value.markers, groups, at(where, 'markers')),
    files: readFiles(value.files, at(where, 'files')),
    dependencies: readDependencies(value.dependencies, at(where, 'dependencies')),
    extras: readExtras(value.extras, at(where, 'extras')),
    source,
    develop: value.develop === undefined ? undefined : boolean(value.develop, at(where, 'develop')),
  }
}

// The root's extras: the packages, by name, each turns on.
function readRootExtras(value, names) {
  const extras = Object.create(null)
  if (value === undefined) return extras
  for (const [extra, list, here] of entries(value, 'extras')) {
    checkName(extra, here)
    extras[extra] = strings(list, here).map((name, index) => {
      checkName(name, `${here}[${index}]`)
      if (!names.has(normalName(name))) throw new LockfileError(`${quote(name)} names no package in the lockfile`, `${here}[${index}]`)
      return name
    })
  }
  return extras
}

// Poetry's identity of a package: its name, version and source.
const identity = (pkg) => JSON.stringify([normalName(pkg.name), versionKey(parseVersion(pkg.version)), pkg.source ?? null])

export function parsePoetryLock(text_) {
  if (typeof text_ !== 'string') throw new TypeError('expected a string')
  const doc = table(parseToml(text_), undefined, TOP)
  if (!isTable(doc.metadata)) throw new LockfileError('expected a [metadata] table, which Poetry requires', 'metadata')
  const { lockVersion, pythonVersions, contentHash } = readMetadata(doc.metadata)
  const packages = array(doc.package ?? [], 'package').map((item, index) => readPackage(item, `package[${index}]`, lockVersion))
  const seen = new Map()
  for (const [index, pkg] of packages.entries()) {
    const id = identity(pkg)
    if (seen.has(id)) throw new LockfileError(`${quote(`${pkg.name} ${pkg.version}`)} is listed twice, first as package[${seen.get(id)}]`, `package[${index}]`)
    seen.set(id, index)
  }
  const extras = readRootExtras(doc.extras, new Set(packages.map((pkg) => normalName(pkg.name))))
  return { lockVersion, pythonVersions, contentHash, extras, packages }
}
