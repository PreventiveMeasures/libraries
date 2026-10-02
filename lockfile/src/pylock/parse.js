// pylock.toml, `lock-version = "1.0"`, PEP 751's lockfile, as uv and pip
// write it and packaging's Pylock reads it. Each package's
// `dependencies` names other entries as briefly as tells them apart, key
// by key; each has to find one, though no installer reads them.

import { LockfileError, at, quote } from '../error.js'
import { checkHttpUrl } from '../python/files.js'
import { checkSpecifiers, checkVersion, versionKeyOf } from '../python/pep440.js'
import { checkMarker, checkName, checkNormalName } from '../python/pep508.js'
import { field } from '../shape.js'
import { TomlDateTime } from '../toml/datetime.js'
import { TomlFloat } from '../toml/number.js'
import { parseToml } from '../toml/parse.js'
import { array, string, stringsOf, table, text } from '../toml/shape.js'
import { isTable } from '../toml/value.js'
import { readArchive, readAttestations, readDirectory, readSdist, readVcs, readWheels } from './package.js'

const TOP = ['lock-version', 'environments', 'requires-python', 'extras', 'dependency-groups', 'default-groups', 'created-by', 'packages', 'tool']
const PACKAGE = ['name', 'version', 'marker', 'requires-python', 'dependencies', 'vcs', 'directory', 'archive', 'index', 'sdist', 'wheels', 'attestation-identities', 'tool']

// Major version 1, which this reader knows the keys of; a minor version
// past 0 may add keys, which are refused as any unknown key is.
function checkLockVersion(value, where) {
  if (!/^1\.\d+$/u.test(string(value, where))) throw new LockfileError(`unsupported lock-version: expected "1.0", found ${quote(value)}`, where)
  return value
}

// Where it comes from: a VCS, a directory or an archive, one alone; or an
// sdist, wheels, or both, from an index.
function readOrigin(value, where, pkg) {
  const direct = ['vcs', 'directory', 'archive'].filter((key) => value[key] !== undefined)
  const sdist = readSdist(value.sdist, at(where, 'sdist'), pkg)
  const wheels = readWheels(value.wheels, at(where, 'wheels'), pkg)
  const distributions = (sdist === undefined ? 0 : 1) + wheels.length
  if (distributions > 0 && direct.length > 0) throw new LockfileError(`${direct.join(' and ')} beside an sdist or wheels, which the spec forbids`, where)
  if (distributions === 0 && direct.length !== 1) throw new LockfileError(`expected one of vcs, directory and archive, or an sdist or wheels, found ${direct.length === 0 ? 'none' : direct.join(' and ')}`, where)
  return {
    vcs: field(value, 'vcs', where, readVcs),
    directory: field(value, 'directory', where, readDirectory),
    archive: field(value, 'archive', where, readArchive),
    index: field(value, 'index', where, checkHttpUrl),
    sdist,
    wheels,
  }
}

function readPackage(value, where) {
  table(value, where, PACKAGE)
  const name = checkNormalName(value.name, at(where, 'name'))
  const version = field(value, 'version', where, checkVersion)
  return {
    name,
    version,
    marker: field(value, 'marker', where, checkMarker),
    requiresPython: field(value, 'requires-python', where, checkSpecifiers),
    // Resolved once every entry is read.
    dependencies: [],
    ...readOrigin(value, where, { name, version, versionKey: version === undefined ? undefined : versionKeyOf(version) }),
    attestationIdentities: readAttestations(value['attestation-identities'], at(where, 'attestation-identities')),
    tool: field(value, 'tool', where, table),
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
    if (table(item, here).name === undefined) throw new LockfileError('expected a name', here)
    const keys = Object.entries(item)
    const found = (byName.get(item.name) ?? []).filter((i) => keys.every(([key, part]) => same(part, raw[i][key])))
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
  const doc = table(parseToml(text_), undefined, TOP)
  const lockVersion = checkLockVersion(doc['lock-version'], 'lock-version')
  const raw = array(doc.packages, 'packages')
  const packages = raw.map((item, index) => readPackage(item, `packages[${index}]`))
  checkUnambiguous(packages)
  const byName = Map.groupBy(packages.keys(), (index) => packages[index].name)
  for (const [index, pkg] of packages.entries()) pkg.dependencies = resolveDependencies(raw[index].dependencies, `packages[${index}].dependencies`, raw, byName)
  return {
    lockVersion,
    environments: field(doc, 'environments', '', stringsOf(checkMarker)),
    requiresPython: field(doc, 'requires-python', '', checkSpecifiers),
    extras: field(doc, 'extras', '', stringsOf(checkNormalName)) ?? [],
    dependencyGroups: field(doc, 'dependency-groups', '', stringsOf(checkName)) ?? [],
    defaultGroups: field(doc, 'default-groups', '', stringsOf(checkName)) ?? [],
    createdBy: text(doc['created-by'], 'created-by'),
    packages,
    tool: field(doc, 'tool', '', table),
  }
}
