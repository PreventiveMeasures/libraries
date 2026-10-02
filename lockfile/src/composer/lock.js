// composer.lock as Composer 2.0 to 2.10 write it, Locker::setLockData's
// fields in its order: every package held to what Composer writes back of
// it, the root's aliases and platform requirements, and the stability
// settings the lockfile installs by. Composer 1's, of plugin-api-version
// 1.x or none, is refused, as is a field Composer 2 does not write.

import { LockfileError, at, quote } from '../error.js'
import { isEmptyObject, keysOf, readJson } from './json.js'
import { checkConstraint, isPlatform, ordered, plain, readPackage, string } from './package.js'
import { compareBytes, compareKeys, lower } from './php.js'
import { STABILITIES, resolve } from './pool.js'
import { readComposerJson } from './root.js'
import { DEFAULT_BRANCH_ALIAS, normalize } from './semver.js'
import { checkOptions, kind } from '../shape.js'

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

const refuse = (expected, value, where) => new LockfileError(`expected ${expected}, found ${kind(value)}`, where)

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
// where Composer sorts them: by 2.8, which writes `{}`, and by any of
// plugin-api-version 2.9.0 and later.
function checkEmpties(doc, pluginApiVersion) {
  const empty = EMPTIES.filter((key) => (Array.isArray(doc[key]) ? doc[key].length === 0 : isEmptyObject(doc[key])))
  const objects = empty.filter((key) => isEmptyObject(doc[key]))
  if (objects.length > 0 && objects.length < empty.length) {
    const list = empty.find((key) => !isEmptyObject(doc[key]))
    throw new LockfileError(`"[]", where ${quote(objects[0])} is "{}", as no Composer writes them both`, list)
  }
  return objects.length > 0 || pluginApiVersion === '2.9.0'
}

const map = (value, where) => {
  if (Array.isArray(value) && value.length === 0) return Object.create(null)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw refuse('a mapping', value, where)
  return value
}

function sortedKeys(value, where) {
  const keys = keysOf(value)
  for (let i = 1; i < keys.length; i++) {
    if (compareKeys(keys[i - 1], keys[i]) > 0) throw new LockfileError(`out of the order Composer 2.8 and later sort it in, after ${quote(keys[i - 1])}`, at(where, keys[i]))
  }
}

// RootPackageLoader's: a stability, by its number, for each name the root
// asks for one of, in lowercase.
function readStabilityFlags(value, sorted) {
  const where = 'stability-flags'
  const flags = Object.create(null)
  const record = map(value, where)
  if (sorted) sortedKeys(record, where)
  const names = Object.entries(STABILITIES)
  for (const name of keysOf(record)) {
    const here = at(where, name)
    if (lower(name) !== name) throw new LockfileError(`${quote(name)}, which Composer writes in lowercase`, here)
    const stability = names.find(([, number]) => number === record[name])
    if (stability === undefined) throw refuse(`one of ${names.map(([, number]) => number).join(', ')}`, record[name], here)
    flags[name] = stability[0]
  }
  return flags
}

// The root's requirements of the platform, as it writes them.
function readPlatform(value, where) {
  const platform = Object.create(null)
  const record = map(value, where)
  for (const name of keysOf(record)) {
    const here = at(where, name)
    if (!isPlatform(name) || lower(name) !== name) throw new LockfileError(`${quote(name)} is not a platform package's name in lowercase, as Composer writes one`, here)
    platform[name] = checkConstraint(record[name], here)
  }
  return platform
}

// config.platform: a version each platform package is taken to be at, or
// false for one taken to be missing.
function readOverrides(value) {
  const where = 'platform-overrides'
  const overrides = Object.create(null)
  if (value === undefined) return overrides
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isEmptyObject(value)) throw refuse('a non-empty mapping, as Composer writes it where there are any', value, where)
  for (const name of keysOf(value)) {
    const here = at(where, name)
    if (!isPlatform(name)) throw new LockfileError(`${quote(name)} is not a platform package's name`, here)
    if (value[name] !== false && (typeof value[name] !== 'string' || normalize(plain(value[name], here)) === undefined)) throw refuse('a version, or false', value[name], here)
    overrides[name] = value[name]
  }
  return overrides
}

function readList(doc, key) {
  const value = doc[key]
  if (key === 'packages-dev' && value === null) throw new LockfileError('null, as Composer 1 writes it after update --no-dev, which Composer 2 does not install from', key)
  if (!Array.isArray(value)) throw refuse('a sequence', value, key)
  return value
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

// The root's, of `name as alias`, used: of a package locked, at the version
// it is locked at, with the default branch's as 9999999-dev, as Composer 1
// wrote them, by package as strcmp sorts them.
function readAliases(value, byName) {
  const where = 'aliases'
  if (!Array.isArray(value)) throw refuse('a sequence', value, where)
  const seen = new Set()
  return value.map((item, index) => {
    const here = `${where}[${index}]`
    ordered(item, here, ['package', 'version', 'alias', 'alias_normalized'])
    for (const key of ['package', 'version', 'alias', 'alias_normalized']) if (item[key] === undefined) throw new LockfileError(`expected ${key}`, here)
    const name = string(item.package, at(here, 'package'))
    const pkg = byName.get(name)
    if (pkg === undefined) throw new LockfileError(`${quote(name)} is not a package in the lockfile, by its name in lowercase`, at(here, 'package'))
    if (seen.has(name)) throw new LockfileError(`${quote(name)} is aliased twice`, here)
    if (index > 0 && compareBytes(value[index - 1].package, name) > 0) throw new LockfileError(`out of the order Composer sorts aliases in, by package, after ${quote(value[index - 1].package)}`, here)
    seen.add(name)
    const version = ['dev-master', 'dev-trunk', 'dev-default'].includes(pkg.normalized) ? DEFAULT_BRANCH_ALIAS : pkg.normalized
    if (item.version !== version) throw new LockfileError(`expected ${quote(version)}, the version ${pkg.name} is locked at, as Composer writes it`, at(here, 'version'))
    const alias = string(item.alias, at(here, 'alias'))
    const normalized = normalize(plain(alias, at(here, 'alias')))
    if (normalized === undefined) throw new LockfileError(`${quote(alias)} is not a version Composer reads`, at(here, 'alias'))
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
      items.push({ pkg: readPackage(value, where, dev), where, dev })
    }
  }
  checkSorted(items)
  const byName = new Map(items.map(({ pkg }) => [lower(pkg.name), pkg]))
  const aliases = readAliases(doc.aliases, byName)
  const resolved = resolve(items, aliases, minimumStability, Object.fromEntries(Object.entries(stabilityFlags).map(([name, stability]) => [name, STABILITIES[stability]])), root)
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
