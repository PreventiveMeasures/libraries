// One [[package]] of a poetry.lock: what Poetry's _dump_package writes,
// each field held to it. A dependency is what the package asks for, as
// Poetry wrote it, which Poetry solves again against the lockfile: its
// version constraint is Poetry's, `>=1.5,<2.0 || >2.1`, and is not read
// here.

import { LockfileError, at, quote } from '../error.js'
import { checkRelative, isCommit } from '../names.js'
import { checkHash } from '../python/files.js'
import { checkVersion } from '../python/pep440.js'
import { checkMarker, checkName, checkRequirementText, normalName } from '../python/pep508.js'
import { array, boolean, entries, refuse, string, strings, table } from '../toml/shape.js'
import { isTable } from '../toml/value.js'

// The hashes Poetry takes from an index: hashlib's, by name.
const HASHES = { __proto__: null, md5: 32, sha1: 40, sha224: 56, sha256: 64, sha384: 96, sha512: 128 }

// A string Poetry writes as given, with nothing in it that is not shown.
export function text(value, where) {
  if (string(value, where) === '' || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)) throw new LockfileError(`${quote(value)} is empty, or has a control character in it`, where)
  return value
}

// A repository Poetry clones: a URL, or git's `user@host:path`.
function checkRepository(value, where) {
  const url = URL.parse(text(value, where))
  const scp = /^[\w.-]+@[\w.-]+:[^\s]+$/u.test(value)
  if (!scp && (url === null || !['https:', 'http:', 'ssh:', 'git:', 'file:'].includes(url.protocol))) throw new LockfileError(`${quote(value)} is not a repository URL`, where)
  return value
}

function checkHttpUrl(value, where) {
  const url = URL.parse(text(value, where))
  if (url === null || (url.protocol !== 'https:' && url.protocol !== 'http:')) throw new LockfileError(`${quote(value)} is not an http(s) URL`, where)
  return value
}

const DEPENDENCY = ['version', 'path', 'develop', 'url', 'git', 'branch', 'tag', 'rev', 'subdirectory', 'extras', 'optional', 'markers']
const KINDS = ['version', 'path', 'url', 'git']

// A constraint table, of one kind: a version, a path, a URL or a git
// repository; a string is a version alone.
function readConstraint(value, where) {
  if (typeof value === 'string') return { type: 'version', version: text(value, where), extras: [], optional: false, markers: undefined }
  table(value, where, DEPENDENCY)
  const kinds = KINDS.filter((key) => value[key] !== undefined)
  if (kinds.length !== 1) throw new LockfileError(`expected one of ${KINDS.join(', ')}, found ${kinds.length === 0 ? 'none' : kinds.join(' and ')}`, where)
  const [type] = kinds
  const allowed = { version: [], path: ['develop'], url: [], git: ['branch', 'tag', 'rev', 'subdirectory'] }[type]
  const stray = DEPENDENCY.find((key) => value[key] !== undefined && !KINDS.includes(key) && !allowed.includes(key) && !['extras', 'optional', 'markers'].includes(key))
  if (stray !== undefined) throw new LockfileError(`a field Poetry does not write for a ${type} dependency`, at(where, stray))
  const read = { type }
  const here = at(where, type)
  if (type === 'version') read.version = text(value.version, here)
  if (type === 'path') Object.assign(read, { path: checkRelative(value.path, here), develop: value.develop === undefined ? false : boolean(value.develop, at(where, 'develop')) })
  if (type === 'url') read.url = checkHttpUrl(value.url, here)
  if (type === 'git') {
    const named = ['branch', 'tag', 'rev'].filter((key) => value[key] !== undefined)
    if (named.length > 1) throw new LockfileError(`${named.join(' and ')}, of which Poetry writes one`, where)
    read.git = checkRepository(value.git, here)
    read.reference = named.length === 0 ? undefined : { kind: named[0], name: text(value[named[0]], at(where, named[0])) }
    read.subdirectory = value.subdirectory === undefined ? undefined : checkRelative(value.subdirectory, at(where, 'subdirectory'))
  }
  read.extras = value.extras === undefined ? [] : strings(value.extras, at(where, 'extras')).map((extra, index) => checkName(extra, `${where}.extras[${index}]`))
  read.optional = value.optional === undefined ? false : boolean(value.optional, at(where, 'optional'))
  read.markers = value.markers === undefined ? undefined : checkMarker(string(value.markers, at(where, 'markers')), at(where, 'markers'))
  return read
}

// By name, as Poetry writes it: one constraint, or an array of them for a
// name asked for more than one way, by marker.
export function readDependencies(value, where) {
  const dependencies = Object.create(null)
  if (value === undefined) return dependencies
  const seen = new Map()
  for (const [name, item, here] of entries(value, where)) {
    checkName(name, here)
    if (seen.has(normalName(name))) throw new LockfileError(`${quote(name)} and ${quote(seen.get(normalName(name)))} are one name`, here)
    seen.set(normalName(name), name)
    const list = Array.isArray(item) ? item : [item]
    if (list.length === 0) throw new LockfileError('an empty array, where Poetry writes a constraint', here)
    dependencies[name] = list.map((constraint, index) => readConstraint(constraint, Array.isArray(item) ? `${here}[${index}]` : here))
  }
  return dependencies
}

// Each file by its name, with its hash.
export function readFiles(value, where) {
  const seen = new Set()
  return array(value, where).map((item, index) => {
    const here = `${where}[${index}]`
    table(item, here, ['file', 'hash'])
    const file = text(item.file, at(here, 'file'))
    if (file.includes('/') || file.includes('\\')) throw new LockfileError(`${quote(file)} is not a file's name`, at(here, 'file'))
    if (seen.has(file)) throw new LockfileError(`${quote(file)} is listed twice`, here)
    seen.add(file)
    return { file, hash: checkHash(text(item.hash, at(here, 'hash')), at(here, 'hash'), HASHES) }
  })
}

// What each extra adds, in PEP 508's text, as Poetry writes it from the
// package's metadata. Poetry reads one that is not PEP 508 with a fallback
// that takes nearly anything; it is refused here.
export function readExtras(value, where) {
  const extras = Object.create(null)
  if (value === undefined) return extras
  for (const [extra, list, here] of entries(value, where)) {
    checkName(extra, here)
    extras[extra] = strings(list, here).map((requirement, index) => checkRequirementText(requirement, `${here}[${index}]`))
  }
  return extras
}

const SOURCES = {
  legacy: ['url', 'reference'],
  git: ['url', 'reference', 'resolved_reference', 'subdirectory'],
  url: ['url', 'subdirectory'],
  file: ['url'],
  directory: ['url'],
}

// Where a package comes from, if not PyPI: an index by its URL and name, a
// git repository at a commit, an archive by URL, or by path, or a
// directory, paths from the lockfile's.
export function readSource(value, where) {
  if (value === undefined) return undefined
  if (!isTable(value)) throw refuse('a table', value, where)
  const type = string(value.type, at(where, 'type'))
  if (!Object.hasOwn(SOURCES, type)) throw new LockfileError(`expected one of ${Object.keys(SOURCES).join(', ')}`, at(where, 'type'))
  table(value, where, ['type', ...SOURCES[type]])
  const read = { type }
  const url = at(where, 'url')
  if (type === 'legacy') Object.assign(read, { url: checkHttpUrl(value.url, url), name: text(value.reference, at(where, 'reference')) })
  if (type === 'url') read.url = checkHttpUrl(value.url, url)
  if (type === 'file' || type === 'directory') read.path = checkRelative(value.url, url)
  if (type === 'git') {
    read.url = checkRepository(value.url, url)
    read.reference = value.reference === undefined ? undefined : text(value.reference, at(where, 'reference'))
    read.commit = string(value.resolved_reference, at(where, 'resolved_reference'))
    if (!isCommit(read.commit)) throw new LockfileError(`${quote(read.commit)} is not a full commit hash, as Poetry writes`, at(where, 'resolved_reference'))
  }
  if (type === 'git' || type === 'url') read.subdirectory = value.subdirectory === undefined ? undefined : checkRelative(value.subdirectory, at(where, 'subdirectory'))
  return read
}

export const readVersion = (value, where) => checkVersion(text(value, where), where)
