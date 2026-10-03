// composer.lock as Composer 2.0 to 2.10 write it, Locker::setLockData's
// fields in its order: every package held to what Composer writes back of
// it, the root's aliases and platform requirements, and the stability
// settings the lockfile installs by. Composer 1's, of plugin-api-version
// 1.x or none, is refused, as is a field Composer 2 does not write.

import { LockfileError, at, quote } from '../error.js'
import { checkOptions, isMapping, kind, mapping, record, refuse, sequence, string } from '../shape.js'
import { isEmptyObject, readJson } from './json.js'
import { entriesOf, isPlatform, ordered, plain, readConstraint, readPackage, readVersion, sortedKeys } from './package.js'
import { compareBytes, lower } from './php.js'
import { STABILITIES, resolve } from './pool.js'
import { readComposerJson } from './root.js'
import { DEFAULT_BRANCH_ALIAS, normalize } from './semver.js'

const TOP = ['_readme', 'content-hash', 'packages', 'packages-dev', 'aliases', 'minimum-stability', 'stability-flags', 'prefer-stable', 'prefer-lowest', 'platform', 'platform-dev', 'platform-overrides', 'plugin-api-version']
const TOP_REFUSED = { hash: "`hash`, the md5 of composer.json that Composer 1.2 and older wrote, which is not read here" }
const REQUIRED = TOP.filter((key) => key !== 'platform-overrides')

const README = [
  'This file locks the dependencies of your project to a known state',
  'Read more about it at https://getcomposer.org/doc/01-basic-usage.md#installing-dependencies',
  'This file is @generated automatically',
]

// PluginInterface::PLUGIN_API_VERSION of each Composer 2: 2.0, 2.1, 2.2,
// 2.3 to 2.5, 2.6 to 2.8, 2.9 and 2.10.
const PLUGIN_APIS = ['2.0.0', '2.1.0', '2.2.0', '2.3.0', '2.6.0', '2.9.0']

// The three Composer 2.8 and later write as `{}` where empty, and as `[]`
// before; and sort the stability flags of.
const EMPTIES = ['stability-flags', 'platform', 'platform-dev']

function readPluginApi(value) {
  const where = 'plugin-api-version'
  if (value === undefined) throw new LockfileError('no plugin-api-version: a lockfile of Composer 1.9 or older, which is not read here')
  if (typeof value === 'string' && value.startsWith('1.')) throw new LockfileError(`${quote(value)} is Composer 1's, which is not read here`, where)
  if (!PLUGIN_APIS.includes(value)) throw new LockfileError(`unsupported plugin-api-version: expected one of ${PLUGIN_APIS.join(', ')}, found ${kind(value)}`, where)
  return value
}

function readTop(doc) {
  ordered(doc, undefined, TOP, TOP_REFUSED)
  const pluginApiVersion = readPluginApi(doc['plugin-api-version'])
  const missing = REQUIRED.find((key) => doc[key] === undefined)
  if (missing !== undefined) throw new LockfileError(`expected ${quote(missing)}, which Composer always writes`, missing)
  const readme = doc._readme
  if (!Array.isArray(readme) || readme.length !== README.length || readme.some((line, index) => line !== README[index])) throw new LockfileError('expected the three lines Composer writes', '_readme')
  const contentHash = string(doc['content-hash'], 'content-hash')
  if (!/^[\da-f]{32}$/u.test(contentHash)) throw new LockfileError(`${quote(contentHash)} is not an md5 in lowercase hex`, 'content-hash')
  for (const key of ['prefer-stable', 'prefer-lowest']) if (typeof doc[key] !== 'boolean') throw refuse('true or false', doc[key], key)
  const minimumStability = doc['minimum-stability']
  if (!Object.hasOwn(STABILITIES, minimumStability)) throw new LockfileError(`expected one of ${Object.keys(STABILITIES).join(', ')}, found ${kind(minimumStability)}`, 'minimum-stability')
  return { contentHash, pluginApiVersion, minimumStability }
}

// `{}` or `[]` where empty, as each Composer writes all three, and sorted
// where Composer sorts them: `[]` before 2.8, and `{}` by 2.8 and later,
// Locker::fixupJsonDataType, which sorts. Of plugin-api-version 2.9.0,
// Composer 2.9 and later, `{}`; of 2.6.0, 2.6 to 2.8, either; of those
// before, `[]`.
function checkEmpties(doc, pluginApiVersion) {
  const empty = EMPTIES.filter((key) => (Array.isArray(doc[key]) ? doc[key].length === 0 : isEmptyObject(doc[key])))
  const object = empty.find((key) => isEmptyObject(doc[key]))
  const list = empty.find((key) => !isEmptyObject(doc[key]))
  const writes = pluginApiVersion === '2.9.0' ? '{}' : pluginApiVersion === '2.6.0' ? undefined : '[]'
  const unlike = writes === '{}' ? list : writes === '[]' ? object : undefined
  if (unlike !== undefined) throw new LockfileError(`"${writes === '{}' ? '[]' : '{}'}", which Composer of plugin-api-version ${pluginApiVersion} writes as "${writes}"`, unlike)
  if (object !== undefined && list !== undefined) throw new LockfileError(`"[]", where ${quote(object)} is "{}", as no Composer writes them both`, list)
  return object !== undefined || pluginApiVersion === '2.9.0'
}

// A mapping, or `[]` for an empty one, as Composer 2.7 and older write it.
const map = (value, where) => (Array.isArray(value) && value.length === 0 ? Object.create(null) : record(value, where))

// RootPackageLoader's: a stability, by its number, for each name the root
// asks for one of, in lowercase.
function readStabilityFlags(value, sorted) {
  const where = 'stability-flags'
  const given = map(value, where)
  if (sorted) sortedKeys(given, where, 'Composer 2.8 and later sort it in')
  const names = Object.entries(STABILITIES)
  return mapping(given, where, (number, here, name) => {
    if (lower(name) !== name) throw new LockfileError(`${quote(name)}, which Composer writes in lowercase`, here)
    const stability = names.find(([, each]) => each === number)
    if (stability === undefined) throw refuse(`one of ${names.map(([, each]) => each).join(', ')}`, number, here)
    return stability[0]
  }, entriesOf)
}

// The root's requirements of the platform, as it writes them, which
// Locker parses as of a root at 1.0.0.
const readPlatform = (value, where) => mapping(map(value, where), where, (constraint, here, name) => {
  if (!isPlatform(name) || lower(name) !== name) throw new LockfileError(`${quote(name)} is not a platform package's name in lowercase, as Composer writes one`, here)
  readConstraint(constraint, here, '1.0.0')
  return constraint
}, entriesOf)

// config.platform, as PlatformRepository takes it: a version each platform
// package is taken to be at, or false for one taken to be missing, which
// php is not.
function readOverrides(value) {
  const where = 'platform-overrides'
  if (value === undefined) return Object.create(null)
  if (!isMapping(value) || isEmptyObject(value)) throw refuse('a non-empty mapping, as Composer writes it where there are any', value, where)
  // PlatformRepository refuses false of `php` as written, and keys each
  // override by its name in lowercase, the last of it; false of PHP so, it
  // disables php, which no install gets past.
  const missing = (here) => new LockfileError('false, which Composer refuses of php, as it cannot be missing', here)
  let php
  const overrides = mapping(value, where, (version, here, name) => {
    if (!isPlatform(name)) throw new LockfileError(`${quote(name)} is not a platform package's name`, here)
    if (version !== false && (typeof version !== 'string' || normalize(plain(version, here)) === undefined)) throw refuse('a version, or false', version, here)
    if (name === 'php' && version === false) throw missing(here)
    if (lower(name) === 'php') php = { version, here }
    return version
  }, entriesOf)
  if (php?.version === false) throw missing(php.here)
  return overrides
}

function readList(doc, key) {
  const value = doc[key]
  if (key === 'packages-dev' && value === null) throw new LockfileError('null, as Composer 1 writes it after update --no-dev, which Composer 2 does not install from', key)
  return sequence(value, key)
}

// Locker::lockPackages sorts by name, then version, as strcmp does.
function checkSorted(items) {
  for (let i = 1; i < items.length; i++) {
    const [a, b] = [items[i - 1].pkg, items[i].pkg]
    if (items[i - 1].dev !== items[i].dev) continue
    const order = compareBytes(a.name, b.name) || compareBytes(a.version, b.version)
    if (order > 0) throw new LockfileError(`out of the order Composer sorts packages in, by name then version, after ${quote(a.name)}`, items[i].where)
  }
}

const ALIAS = ['package', 'version', 'alias', 'alias_normalized']

// The root's, of `version as alias`, LockTransaction::getAliases: each of a
// package locked, the root's in require and in require-dev alike, by
// package as strcmp sorts them. Its version is the root's, normalized,
// which Locker::setLockData writes as 9999999-dev of dev-master, dev-trunk
// and dev-default; a branch alias's, or of `a || b as c` where the solver
// took a, one the package is not at. Locker's locked repository makes each
// an alias of its package, whatever its version.
function readAliases(value, byName) {
  const where = 'aliases'
  return sequence(value, where).map((item, index) => {
    const here = `${where}[${index}]`
    ordered(item, here, ALIAS)
    for (const key of ALIAS) if (item[key] === undefined) throw new LockfileError(`expected ${key}`, here)
    const name = string(item.package, at(here, 'package'))
    if (!byName.has(name)) throw new LockfileError(`${quote(name)} is not a package in the lockfile, by its name in lowercase`, at(here, 'package'))
    if (index > 0 && compareBytes(value[index - 1].package, name) > 0) throw new LockfileError(`out of the order Composer sorts aliases in, by package, after ${quote(value[index - 1].package)}`, here)
    const version = string(item.version, at(here, 'version'))
    if (readVersion(version, at(here, 'version')) !== version) throw new LockfileError(`${quote(version)} is not a version normalized, as Composer writes it`, at(here, 'version'))
    if (['dev-master', 'dev-trunk', 'dev-default'].includes(version)) throw new LockfileError(`${quote(version)}, which Composer writes as ${DEFAULT_BRANCH_ALIAS}`, at(here, 'version'))
    const alias = string(item.alias, at(here, 'alias'))
    const normalized = readVersion(alias, at(here, 'alias'))
    if (item.alias_normalized !== normalized) throw new LockfileError(`expected ${quote(normalized)}, the alias normalized`, at(here, 'alias_normalized'))
    return { package: name, version, alias, aliasNormalized: normalized }
  })
}

export function parseComposerLock(text, options = {}) {
  if (typeof text !== 'string') throw new TypeError('expected a string')
  const { composerJson } = checkOptions(options, ['composerJson'])
  const root = composerJson === undefined ? undefined : readComposerJson(composerJson)
  const doc = readJson(text)
  const { contentHash, pluginApiVersion, minimumStability } = readTop(doc)
  const sorted = checkEmpties(doc, pluginApiVersion)
  const stabilityFlags = readStabilityFlags(doc['stability-flags'], sorted)
  const items = []
  for (const [key, dev] of [['packages', false], ['packages-dev', true]]) {
    for (const [index, value] of readList(doc, key).entries()) {
      const where = `${key}[${index}]`
      items.push({ ...readPackage(value, where, dev), where, dev })
    }
  }
  checkSorted(items)
  const byName = new Map(items.map(({ pkg }) => [lower(pkg.name), pkg]))
  const aliases = readAliases(doc.aliases, byName)
  const resolved = resolve(items, aliases, minimumStability, stabilityFlags, root)
  const packages = Object.create(null)
  for (const [{ pkg }, { require, aliases: own }] of resolved) {
    packages[lower(pkg.name)] = { ...pkg, require, aliases: own }
  }
  return {
    contentHash,
    fresh: root === undefined ? undefined : root.contentHash === contentHash,
    pluginApiVersion,
    minimumStability,
    stabilityFlags,
    preferStable: doc['prefer-stable'],
    preferLowest: doc['prefer-lowest'],
    platform: readPlatform(doc.platform, 'platform'),
    platformDev: readPlatform(doc['platform-dev'], 'platform-dev'),
    platformOverrides: readOverrides(doc['platform-overrides']),
    aliases,
    packages,
  }
}
