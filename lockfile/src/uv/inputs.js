// What uv resolved from, which it compares with the workspace to tell
// whether the lockfile is fresh: [options], [manifest], `conflicts`, and
// each package's [package.metadata]. A requirement is uv's own table of
// one: a name, extras or groups, a marker, and where it may come from.

import { LockfileError, at, quote } from '../error.js'
import { DIGESTS, checkHash } from '../python/files.js'
import { checkMarker, checkNormalName, checkRequirementText } from '../python/pep508.js'
import { checkNormalVersion, checkSpecifiers } from '../python/pep440.js'
import { array, entries, string, strings, table } from '../toml/shape.js'
import { isTable } from '../toml/value.js'
import { checkTime } from './artifacts.js'
import { checkPath, checkUrl, readGit } from './source.js'

export const names = (value, where) => strings(value, where).map((name, index) => checkNormalName(name, `${where}[${index}]`))

// One package, or its extra or its group.
export function readConflictItem(value, where) {
  table(value, where, ['package', 'extra', 'group'])
  if (value.extra !== undefined && value.group !== undefined) throw new LockfileError('an extra and a group, of which uv takes one', where)
  const read = (key) => (value[key] === undefined ? undefined : checkNormalName(string(value[key], at(where, key)), at(where, key)))
  return { package: checkNormalName(string(value.package, at(where, 'package')), at(where, 'package')), extra: read('extra'), group: read('group') }
}

const SOURCES = ['git', 'url', 'path', 'directory', 'editable', 'virtual']
const REGISTRY = ['specifier', 'index', 'conflict']

function readRequirementSource(value, where) {
  const kinds = SOURCES.filter((key) => value[key] !== undefined)
  const registry = REGISTRY.filter((key) => value[key] !== undefined)
  if (kinds.length + (registry.length > 0 ? 1 : 0) > 1) throw new LockfileError(`more than one source: ${[...kinds, ...registry].join(', ')}`, where)
  if (value.subdirectory !== undefined && kinds[0] !== 'url') throw new LockfileError('a subdirectory, which uv reads of a URL alone', at(where, 'subdirectory'))
  const [type = 'registry'] = kinds
  const here = at(where, type)
  if (type === 'registry') {
    const read = (key, check) => (value[key] === undefined ? undefined : check(value[key], at(where, key)))
    return {
      type,
      specifier: read('specifier', (item, place) => checkSpecifiers(string(item, place), place)),
      index: read('index', (item, place) => checkUrl(item, place).href),
      conflict: read('conflict', readConflictItem),
    }
  }
  if (type === 'git') return readGit(value.git, here, false)
  if (type === 'url') return { type, url: checkUrl(value.url, here, ['https:', 'http:']).href, subdirectory: value.subdirectory === undefined ? undefined : checkPath(value.subdirectory, at(where, 'subdirectory')) }
  return { type, path: checkPath(value[type], here) }
}

// `hashes` only a build constraint has, as `algorithm:digest`.
export function readRequirement(value, where, hashes = false) {
  table(value, where, ['name', 'extras', 'groups', 'marker', 'subdirectory', ...SOURCES, ...REGISTRY, ...(hashes ? ['hashes'] : [])])
  const name = checkNormalName(string(value.name, at(where, 'name')), at(where, 'name'))
  const extras = value.extras === undefined ? [] : names(value.extras, at(where, 'extras'))
  const groups = value.groups === undefined ? [] : names(value.groups, at(where, 'groups'))
  if (extras.length > 0 && groups.length > 0) throw new LockfileError('extras and groups, of which uv takes one', where)
  const marker = value.marker === undefined ? undefined : checkMarker(string(value.marker, at(where, 'marker')), at(where, 'marker'))
  const requirement = { name, extras, groups, marker, source: readRequirementSource(value, where) }
  if (hashes) requirement.hashes = value.hashes === undefined ? [] : strings(value.hashes, at(where, 'hashes')).map((hash, index) => checkHash(hash, `${where}.hashes[${index}]`, DIGESTS))
  return requirement
}

export const requirements = (value, where, hashes) => array(value, where).map((item, index) => readRequirement(item, `${where}[${index}]`, hashes))

export function groupsOf(value, where) {
  const groups = Object.create(null)
  for (const [group, list, here] of entries(value, where)) groups[checkNormalName(group, here)] = requirements(list, here)
  return groups
}

// What a [[manifest.dependency-metadata]] gives in place of a package's
// own, its requirements in PEP 508's text.
function readStaticMetadata(value, where) {
  table(value, where, ['name', 'version', 'requires-dist', 'requires-python', 'provides-extras'])
  const read = (key, check) => (value[key] === undefined ? undefined : check(value[key], at(where, key)))
  return {
    name: checkNormalName(string(value.name, at(where, 'name')), at(where, 'name')),
    version: read('version', (item, here) => checkNormalVersion(string(item, here), here)),
    requiresDist: read('requires-dist', strings)?.map((text, index) => checkRequirementText(text, `${where}.requires-dist[${index}]`)) ?? [],
    requiresPython: read('requires-python', (item, here) => checkSpecifiers(string(item, here), here)),
    providesExtras: read('provides-extras', names) ?? [],
  }
}

// uv 0.12 writes an override of one package's dependencies as a table of
// `package` and `dependencies`; that is not read here.
function overrides(value, where) {
  return array(value, where).map((item, index) => {
    const here = `${where}[${index}]`
    if (isTable(item) && Object.hasOwn(item, 'package')) throw new LockfileError('an override of one package\'s dependencies, which is not read here', here)
    return readRequirement(item, here)
  })
}

const MANIFEST = ['members', 'requirements', 'constraints', 'overrides', 'excludes', 'build-constraints', 'dependency-groups', 'dependency-metadata']

export function readManifest(value = Object.create(null), where = 'manifest') {
  table(value, where, MANIFEST)
  const list = (key, read, ...rest) => (value[key] === undefined ? [] : read(value[key], at(where, key), ...rest))
  return {
    members: list('members', names),
    requirements: list('requirements', requirements),
    constraints: list('constraints', requirements),
    overrides: list('overrides', overrides),
    excludes: list('excludes', names),
    buildConstraints: list('build-constraints', requirements, true),
    dependencyGroups: value['dependency-groups'] === undefined ? Object.create(null) : groupsOf(value['dependency-groups'], at(where, 'dependency-groups')),
    dependencyMetadata: list('dependency-metadata', (item, here) => array(item, here).map((entry, index) => readStaticMetadata(entry, `${here}[${index}]`))),
  }
}

export function readMetadata(value, where) {
  if (value === undefined) return { requiresDist: [], providesExtras: [], requiresDev: Object.create(null) }
  table(value, where, ['requires-dist', 'provides-extras', 'requires-dev'])
  return {
    requiresDist: value['requires-dist'] === undefined ? [] : requirements(value['requires-dist'], at(where, 'requires-dist')),
    providesExtras: value['provides-extras'] === undefined ? [] : names(value['provides-extras'], at(where, 'provides-extras')),
    requiresDev: value['requires-dev'] === undefined ? Object.create(null) : groupsOf(value['requires-dev'], at(where, 'requires-dev')),
  }
}

const MODES = {
  'resolution-mode': ['highest', 'lowest', 'lowest-direct'],
  'prerelease-mode': ['disallow', 'allow', 'if-necessary', 'explicit', 'if-necessary-or-explicit'],
  'fork-strategy': ['fewest', 'requires-python'],
}
const DEFAULTS = { 'resolution-mode': 'highest', 'prerelease-mode': 'if-necessary-or-explicit', 'fork-strategy': 'requires-python' }

function mode(value, where, key) {
  if (!MODES[key].includes(string(value, where))) throw new LockfileError(`expected one of ${MODES[key].join(', ')}`, where)
  return value
}

// An ISO 8601 duration, as jiff writes a span.
function checkSpan(value, where) {
  if (!/^P(?!$)(?:\d+Y)?(?:\d+M)?(?:\d+W)?(?:\d+D)?(?:T(?=\d)(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d{1,9})?S)?)?$/u.test(string(value, where))) {
    throw new LockfileError(`${quote(value)} is not an ISO 8601 duration`, where)
  }
  return value
}

function cutoff(value, where) {
  if (value === false) return false
  if (typeof value === 'string') return { timestamp: checkTime(value, where), span: undefined }
  table(value, where, ['timestamp', 'span'])
  return { timestamp: checkTime(value.timestamp, at(where, 'timestamp')), span: checkSpan(value.span, at(where, 'span')) }
}

function byName(value, where, read) {
  const map = Object.create(null)
  for (const [name, item, here] of entries(value, where)) map[checkNormalName(name, here)] = read(item, here)
  return map
}

function libc(value, where) {
  table(value, where, ['glibc', 'musl'])
  const read = (key) => {
    if (value[key] !== undefined && !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(string(value[key], at(where, key)))) throw new LockfileError(`${quote(value[key])} is not a libc version`, at(where, key))
    return value[key]
  }
  return { glibc: read('glibc'), musl: read('musl') }
}

export function readOptions(value = Object.create(null), where = 'options') {
  table(value, where, [...Object.keys(MODES), 'exclude-newer', 'exclude-newer-span', 'exclude-newer-package', 'prerelease-package', 'minimum-libc-version'])
  const read = (key, check) => (value[key] === undefined ? undefined : check(value[key], at(where, key), key))
  const excludeNewer = read('exclude-newer', checkTime)
  return {
    resolutionMode: read('resolution-mode', mode) ?? DEFAULTS['resolution-mode'],
    prereleaseMode: read('prerelease-mode', mode) ?? DEFAULTS['prerelease-mode'],
    forkStrategy: read('fork-strategy', mode) ?? DEFAULTS['fork-strategy'],
    // With a span, uv writes a timestamp of no effect beside it.
    excludeNewer: value['exclude-newer-span'] === undefined ? excludeNewer : undefined,
    excludeNewerSpan: read('exclude-newer-span', checkSpan),
    excludeNewerPackage: read('exclude-newer-package', (item, here) => byName(item, here, cutoff)) ?? Object.create(null),
    prereleasePackage: read('prerelease-package', (item, here) => byName(item, here, (mode_, place) => mode(mode_, place, 'prerelease-mode'))) ?? Object.create(null),
    minimumLibcVersion: read('minimum-libc-version', libc),
  }
}

export function readConflicts(value, where = 'conflicts') {
  if (value === undefined) return []
  return array(value, where).map((set, index) => {
    const here = `${where}[${index}]`
    const items = array(set, here).map((item, i) => readConflictItem(item, `${here}[${i}]`))
    if (items.length < 2) throw new LockfileError('a set of conflicts of fewer than two, which uv refuses', here)
    return items
  })
}
