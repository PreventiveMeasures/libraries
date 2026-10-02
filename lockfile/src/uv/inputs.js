// What uv resolved from, which it compares with the workspace to tell
// whether the lockfile is fresh: [options], [manifest], `conflicts`, and
// each package's [package.metadata]. A requirement is uv's own table of
// one: a name, extras or groups, a marker, and where it may come from.

import { LockfileError, at, quote } from '../error.js'
import { DIGESTS, checkHash, checkPath } from '../python/files.js'
import { checkMarker, checkNormalName, checkRequirementText } from '../python/pep508.js'
import { checkNormalVersion, checkSpecifiers } from '../python/pep440.js'
import { field } from '../shape.js'
import { arrayOf, string, stringsOf, table } from '../toml/shape.js'
import { isTable } from '../toml/value.js'
import { byName, checkTime, checkUrl, names } from './shape.js'
import { readGit } from './source.js'

// One package as a whole, by `package` alone, as uv writes for workspace
// members that conflict, or its extra or its group.
function readConflictItem(value, where) {
  table(value, where, ['package', 'extra', 'group'])
  if (value.extra !== undefined && value.group !== undefined) throw new LockfileError('an extra and a group, of which uv takes one', where)
  return { package: checkNormalName(value.package, at(where, 'package')), extra: field(value, 'extra', where, checkNormalName), group: field(value, 'group', where, checkNormalName) }
}

const SOURCES = ['git', 'url', 'path', 'directory', 'editable', 'virtual']
const REGISTRY = ['specifier', 'index', 'conflict']
const REQUIREMENT = ['name', 'extras', 'groups', 'marker', 'subdirectory', ...SOURCES, ...REGISTRY]

function readRequirementSource(value, where) {
  const kinds = SOURCES.filter((key) => value[key] !== undefined)
  const registry = REGISTRY.filter((key) => value[key] !== undefined)
  if (kinds.length + (registry.length > 0 ? 1 : 0) > 1) throw new LockfileError(`more than one source: ${[...kinds, ...registry].join(', ')}`, where)
  if (value.subdirectory !== undefined && kinds[0] !== 'url') throw new LockfileError('a subdirectory, which uv reads of a URL alone', at(where, 'subdirectory'))
  const [type = 'registry'] = kinds
  const here = at(where, type)
  if (type === 'registry') {
    return {
      type,
      specifier: field(value, 'specifier', where, checkSpecifiers),
      index: field(value, 'index', where, checkUrl)?.href,
      conflict: field(value, 'conflict', where, readConflictItem),
    }
  }
  if (type === 'git') return readGit(value.git, here)
  if (type === 'url') return { type, url: checkUrl(value.url, here, ['https:', 'http:']).href, subdirectory: field(value, 'subdirectory', where, checkPath) }
  return { type, path: checkPath(value[type], here) }
}

function readRequirement(value, where, fields = REQUIREMENT) {
  table(value, where, fields)
  const extras = field(value, 'extras', where, names) ?? []
  const groups = field(value, 'groups', where, names) ?? []
  if (extras.length > 0 && groups.length > 0) throw new LockfileError('extras and groups, of which uv takes one', where)
  return { name: checkNormalName(value.name, at(where, 'name')), extras, groups, marker: field(value, 'marker', where, checkMarker), source: readRequirementSource(value, where) }
}

// A build constraint is a requirement with its `hashes`, `algorithm:digest`.
function readBuildConstraint(value, where) {
  const requirement = readRequirement(value, where, [...REQUIREMENT, 'hashes'])
  return { ...requirement, hashes: field(value, 'hashes', where, stringsOf((hash, place) => checkHash(hash, place, DIGESTS))) ?? [] }
}

const requirements = arrayOf(readRequirement)
const groupsOf = (value, where) => byName(value, where, requirements)

// What a [[manifest.dependency-metadata]] gives in place of a package's
// own, its requirements in PEP 508's text.
function readStaticMetadata(value, where) {
  table(value, where, ['name', 'version', 'requires-dist', 'requires-python', 'provides-extras'])
  return {
    name: checkNormalName(value.name, at(where, 'name')),
    version: field(value, 'version', where, checkNormalVersion),
    requiresDist: field(value, 'requires-dist', where, stringsOf(checkRequirementText)) ?? [],
    requiresPython: field(value, 'requires-python', where, checkSpecifiers),
    providesExtras: field(value, 'provides-extras', where, names) ?? [],
  }
}

// uv 0.12 writes an override of one package's dependencies as a table of
// `package` and `dependencies`; that is not read here.
const overrides = arrayOf((item, where) => {
  if (isTable(item) && Object.hasOwn(item, 'package')) throw new LockfileError('an override of one package\'s dependencies, which is not read here', where)
  return readRequirement(item, where)
})

const MANIFEST = ['members', 'requirements', 'constraints', 'overrides', 'excludes', 'build-constraints', 'dependency-groups', 'dependency-metadata']

export function readManifest(value = Object.create(null)) {
  const where = 'manifest'
  table(value, where, MANIFEST)
  const list = (key, read) => field(value, key, where, read) ?? []
  return {
    members: list('members', names),
    requirements: list('requirements', requirements),
    constraints: list('constraints', requirements),
    overrides: list('overrides', overrides),
    excludes: list('excludes', names),
    buildConstraints: list('build-constraints', arrayOf(readBuildConstraint)),
    dependencyGroups: groupsOf(value['dependency-groups'], at(where, 'dependency-groups')),
    dependencyMetadata: list('dependency-metadata', arrayOf(readStaticMetadata)),
  }
}

export function readMetadata(value = Object.create(null), where) {
  table(value, where, ['requires-dist', 'provides-extras', 'requires-dev'])
  return {
    requiresDist: field(value, 'requires-dist', where, requirements) ?? [],
    providesExtras: field(value, 'provides-extras', where, names) ?? [],
    requiresDev: groupsOf(value['requires-dev'], at(where, 'requires-dev')),
  }
}

// One of the values uv writes of a resolver mode.
const mode = (...values) => (value, where) => {
  if (!values.includes(string(value, where))) throw new LockfileError(`expected one of ${values.join(', ')}`, where)
  return value
}
const prerelease = mode('disallow', 'allow', 'if-necessary', 'explicit', 'if-necessary-or-explicit')

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

function libc(value, where) {
  table(value, where, ['glibc', 'musl'])
  const version = (item, here) => {
    if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(string(item, here))) throw new LockfileError(`${quote(item)} is not a libc version`, here)
    return item
  }
  return { glibc: field(value, 'glibc', where, version), musl: field(value, 'musl', where, version) }
}

const OPTIONS = ['resolution-mode', 'prerelease-mode', 'fork-strategy', 'exclude-newer', 'exclude-newer-span', 'exclude-newer-package', 'prerelease-package', 'minimum-libc-version']

export function readOptions(value = Object.create(null)) {
  const where = 'options'
  table(value, where, OPTIONS)
  // With a span, uv writes a timestamp of no effect beside it.
  const excludeNewer = field(value, 'exclude-newer', where, checkTime)
  return {
    resolutionMode: field(value, 'resolution-mode', where, mode('highest', 'lowest', 'lowest-direct')) ?? 'highest',
    prereleaseMode: field(value, 'prerelease-mode', where, prerelease) ?? 'if-necessary-or-explicit',
    forkStrategy: field(value, 'fork-strategy', where, mode('fewest', 'requires-python')) ?? 'requires-python',
    excludeNewer: value['exclude-newer-span'] === undefined ? excludeNewer : undefined,
    excludeNewerSpan: field(value, 'exclude-newer-span', where, checkSpan),
    excludeNewerPackage: byName(value['exclude-newer-package'], at(where, 'exclude-newer-package'), cutoff),
    prereleasePackage: byName(value['prerelease-package'], at(where, 'prerelease-package'), prerelease),
    minimumLibcVersion: field(value, 'minimum-libc-version', where, libc),
  }
}

export function readConflicts(value) {
  const where = 'conflicts'
  if (value === undefined) return []
  return arrayOf((set, here) => {
    const items = arrayOf(readConflictItem)(set, here)
    if (items.length < 2) throw new LockfileError('a set of conflicts of fewer than two, which uv refuses', here)
    return items
  })(value, where)
}
