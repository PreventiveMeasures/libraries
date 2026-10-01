// pylock.toml, `lock-version = "1.0"`, PEP 751's lockfile, as uv and pip
// write it and packaging's Pylock reads it. Each package's
// `dependencies` names other entries as briefly as tells them apart, key
// by key; each has to find one, though no installer reads them.

import { LockfileError, at, quote } from '../error.js'
import { checkSpecifiers, checkVersion } from '../python/pep440.js'
import { checkMarker, checkNormalName } from '../python/pep508.js'
import { TomlDateTime } from '../toml/datetime.js'
import { TomlFloat } from '../toml/number.js'
import { parseToml } from '../toml/parse.js'
import { array, string, table } from '../toml/shape.js'
import { isTable } from '../toml/value.js'
import { readArchive, readAttestations, readDirectory, readGroupNames, readSdist, readVcs, readWheels, text } from './package.js'

const TOP = ['lock-version', 'environments', 'requires-python', 'extras', 'dependency-groups', 'default-groups', 'created-by', 'packages', 'tool']
const PACKAGE = ['name', 'version', 'marker', 'requires-python', 'dependencies', 'vcs', 'directory', 'archive', 'index', 'sdist', 'wheels', 'attestation-identities', 'tool']

const optional = (holder, key, where, read) => (holder[key] === undefined ? undefined : read(holder[key], at(where, key)))
const specifiers = (value, where) => checkSpecifiers(string(value, where), where)

// Major version 1, which this reader knows the keys of; a minor version
// past 0 may add keys, which are refused as any unknown key is.
function checkLockVersion(value, where) {
  if (!/^1\.\d+$/u.test(string(value, where))) throw new LockfileError(`unsupported lock-version: expected "1.0", found ${quote(value)}`, where)
  return value
}

const readTool = (value, where) => (value === undefined ? undefined : table(value, where))

// The base URL of a simple repository API.
function checkIndex(value, where) {
  if (!/^https?:\/\//u.test(text(value, where)) || !URL.canParse(value)) throw new LockfileError(`${quote(value)} is not an http(s) URL`, where)
  return value
}

// Where it comes from: a VCS, a directory or an archive, one alone; or an
// sdist, wheels, or both, from an index.
function readOrigin(value, where, pkg) {
  const direct = ['vcs', 'directory', 'archive'].filter((key) => value[key] !== undefined)
  const sdist = readSdist(value.sdist, at(where, 'sdist'), pkg)
  const wheels = readWheels(value.wheels, at(where, 'wheels'), pkg)
  const distributions = (sdist === undefined ? 0 : 1) + (wheels?.length ?? 0)
  if (distributions > 0 && direct.length > 0) throw new LockfileError(`${direct.join(' and ')} beside an sdist or wheels, which the spec forbids`, where)
  if (distributions === 0 && direct.length !== 1) throw new LockfileError(`expected one of vcs, directory and archive, or an sdist or wheels, found ${direct.length === 0 ? 'none' : direct.join(' and ')}`, where)
  return {
    vcs: optional(value, 'vcs', where, readVcs),
    directory: optional(value, 'directory', where, readDirectory),
    archive: optional(value, 'archive', where, readArchive),
    index: optional(value, 'index', where, checkIndex),
    sdist,
    wheels: wheels ?? [],
  }
}

function readPackage(value, where) {
  table(value, where, PACKAGE)
  const name = checkNormalName(string(value.name, at(where, 'name')), at(where, 'name'))
  const version = optional(value, 'version', where, (item, here) => checkVersion(string(item, here), here))
  return {
    name,
    version,
    marker: optional(value, 'marker', where, (item, here) => checkMarker(string(item, here), here)),
    requiresPython: optional(value, 'requires-python', where, specifiers),
    // Resolved once every entry is read.
    dependencies: [],
    ...readOrigin(value, where, { name, version }),
    attestationIdentities: readAttestations(value['attestation-identities'], at(where, 'attestation-identities')),
    tool: readTool(value.tool, at(where, 'tool')),
  }
}

// Whether a TOML value is another, key by key and item by item.
function same(a, b) {
  if (a instanceof TomlDateTime || a instanceof TomlFloat) return b instanceof a.constructor && a.text === b.text
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((item, index) => same(item, b[index]))
  if (isTable(a)) return isTable(b) && Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([key, item]) => same(item, b[key]))
  return a === b
}

// The entry each of a package's `dependencies` names: every key it gives
// is the entry's, as written, and one entry alone has them all. `byName`
// has the index of each entry, by its name.
function resolveDependencies(value, where, raw, byName) {
  if (value === undefined) return []
  return array(value, where).map((item, index) => {
    const here = `${where}[${index}]`
    table(item, here)
    if (item.name === undefined) throw new LockfileError('expected a name', here)
    const found = (byName.get(item.name) ?? []).filter((i) => Object.entries(item).every(([key, part]) => same(part, raw[i][key])))
    if (found.length !== 1) throw new LockfileError(found.length === 0 ? 'names no entry of packages' : `could be any of ${found.length} entries of packages`, here)
    return found[0]
  })
}

// Two entries of a name and no marker are both installed everywhere, which
// the spec requires an installer to refuse.
function checkUnambiguous(packages) {
  const unmarked = new Map()
  for (const [index, pkg] of packages.entries()) {
    if (pkg.marker !== undefined) continue
    if (unmarked.has(pkg.name)) throw new LockfileError(`${quote(pkg.name)} is listed with no marker, as packages[${unmarked.get(pkg.name)}] is, and both would be installed`, `packages[${index}]`)
    unmarked.set(pkg.name, index)
  }
}

export function parsePylock(text_) {
  if (typeof text_ !== 'string') throw new TypeError('expected a string')
  const doc = table(parseToml(text_), undefined, TOP)
  const lockVersion = checkLockVersion(doc['lock-version'], 'lock-version')
  const raw = array(doc.packages, 'packages')
  const packages = raw.map((item, index) => readPackage(item, `packages[${index}]`))
  checkUnambiguous(packages)
  const byName = Map.groupBy(packages.keys(), (index) => packages[index].name)
  for (const [index, pkg] of packages.entries()) pkg.dependencies = resolveDependencies(raw[index].dependencies, `packages[${index}].dependencies`, raw, byName)
  return {
    lockVersion,
    environments: optional(doc, 'environments', '', (value, where) => array(value, where).map((marker, index) => checkMarker(string(marker, `${where}[${index}]`), `${where}[${index}]`))),
    requiresPython: optional(doc, 'requires-python', '', specifiers),
    extras: optional(doc, 'extras', '', (value, where) => array(value, where).map((extra, index) => checkNormalName(string(extra, `${where}[${index}]`), `${where}[${index}]`))) ?? [],
    dependencyGroups: optional(doc, 'dependency-groups', '', readGroupNames) ?? [],
    defaultGroups: optional(doc, 'default-groups', '', readGroupNames) ?? [],
    createdBy: text(doc['created-by'], 'created-by'),
    packages,
    tool: readTool(doc.tool, 'tool'),
  }
}
