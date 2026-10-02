// One [[package]] of a poetry.lock: what Poetry's _dump_package writes,
// each field held to it. A dependency is what the package asks for, as
// Poetry wrote it, which Poetry solves again against the lockfile: its
// version constraint is Poetry's, `>=1.5,<2.0 || >2.1`, and is not read
// here.

import { LockfileError, at, quote } from '../error.js'
import { checkRepo, isCommit, isWithin } from '../names.js'
import { DIGESTS, checkHash, checkHttpUrl, checkPath, checkSubdirectory } from '../python/files.js'
import { checkMarker, checkName, checkRequirementText, normalName } from '../python/pep508.js'
import { field } from '../shape.js'
import { arrayOf, boolean, checker, entries, oneOf, string, stringsOf, table, tableOf, text } from '../toml/shape.js'

// The hashes Poetry takes from an index: hashlib's, by name.
const HASHES = Object.fromEntries(['md5', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512'].map((algorithm) => [algorithm, DIGESTS[algorithm]]))

// A repository Poetry clones: a URL, or git's `user@host:path`.
function checkRepository(value, where) {
  const url = URL.parse(checkRepo(text(value, where), where))
  if (!/^[\w.-]+@[\w.-]+:./u.test(value) && (url === null || !['https:', 'http:', 'ssh:', 'git:', 'file:'].includes(url.protocol))) throw new LockfileError(`${quote(value)} is not a repository URL`, where)
  return value
}

// The fields of each kind of dependency Poetry writes, beside the ones
// every kind has.
const OWN = { version: ['version'], path: ['path', 'develop'], url: ['url'], git: ['git', 'branch', 'tag', 'rev', 'subdirectory'] }
const KINDS = Object.keys(OWN)
const COMMON = new Set(['extras', 'optional', 'markers'])
const DEPENDENCY = [...new Set(Object.values(OWN).flat()), ...COMMON]

function readKind(type, value, where) {
  const here = at(where, type)
  if (type === 'version') return { version: text(value.version, here) }
  if (type === 'path') return { path: checkPath(value.path, here), develop: field(value, 'develop', where, boolean) ?? false }
  if (type === 'url') return { url: checkHttpUrl(value.url, here) }
  const named = ['branch', 'tag', 'rev'].filter((key) => value[key] !== undefined)
  if (named.length > 1) throw new LockfileError(`${named.join(' and ')}, of which Poetry writes one`, where)
  return {
    git: checkRepository(value.git, here),
    reference: named.length === 0 ? undefined : { kind: named[0], name: text(value[named[0]], at(where, named[0])) },
    subdirectory: field(value, 'subdirectory', where, checkSubdirectory),
  }
}

// A constraint table, of one kind: a version, a path, a URL or a git
// repository; a string is a version alone.
function readConstraint(value, where) {
  if (typeof value === 'string') return { type: 'version', version: text(value, where), extras: [], optional: false, markers: undefined }
  table(value, where, DEPENDENCY)
  const type = oneOf(value, KINDS, where)
  const stray = DEPENDENCY.find((key) => value[key] !== undefined && !OWN[type].includes(key) && !COMMON.has(key))
  if (stray !== undefined) throw new LockfileError(`a field Poetry does not write for a ${type} dependency`, at(where, stray))
  return {
    type,
    ...readKind(type, value, where),
    extras: field(value, 'extras', where, stringsOf(checkName)) ?? [],
    optional: field(value, 'optional', where, boolean) ?? false,
    markers: field(value, 'markers', where, checkMarker),
  }
}

// By name, as Poetry writes it: one constraint, or an array of them for a
// name asked for more than one way, by marker.
export function readDependencies(value, where) {
  const dependencies = Object.create(null)
  if (value === undefined) return dependencies
  const seen = new Map()
  for (const [name, item, here] of entries(value, where)) {
    const normal = normalName(checkName(name, here))
    if (seen.has(normal)) throw new LockfileError(`${quote(name)} and ${quote(seen.get(normal))} are one name`, here)
    seen.set(normal, name)
    if (Array.isArray(item) && item.length === 0) throw new LockfileError('an empty array, where Poetry writes a constraint', here)
    dependencies[name] = Array.isArray(item) ? arrayOf(readConstraint)(item, here) : [readConstraint(item, here)]
  }
  return dependencies
}

// Each file by its name, with its hash.
export function readFiles(value, where) {
  const seen = new Set()
  return arrayOf((item, here) => {
    table(item, here, ['file', 'hash'])
    const file = text(item.file, at(here, 'file'))
    if (!isWithin(file) || file.includes('/')) throw new LockfileError(`${quote(file)} is not a file's name`, at(here, 'file'))
    if (seen.has(file)) throw new LockfileError(`${quote(file)} is listed twice`, here)
    seen.add(file)
    return { file, hash: checkHash(item.hash, at(here, 'hash'), HASHES) }
  })(value, where)
}

// What each extra adds, in PEP 508's text, as Poetry writes it from the
// package's metadata. Poetry reads one that is not PEP 508 with a fallback
// that takes nearly anything; it is refused here.
export const readExtras = (value, where) => tableOf(value, where, checkName, stringsOf(checkRequirementText))

const SOURCES = {
  legacy: ['url', 'reference'],
  git: ['url', 'reference', 'resolved_reference', 'subdirectory'],
  url: ['url', 'subdirectory'],
  file: ['url'],
  directory: ['url'],
}

const readCommit = checker(isCommit, 'a full commit hash, as Poetry writes')

// Where a package comes from, if not PyPI: an index by its URL and name, a
// git repository at a commit, an archive by URL, or by path, or a
// directory, paths from the lockfile's.
export function readSource(value, where) {
  const type = string(table(value, where).type, at(where, 'type'))
  if (!Object.hasOwn(SOURCES, type)) throw new LockfileError(`expected one of ${Object.keys(SOURCES).join(', ')}`, at(where, 'type'))
  table(value, where, ['type', ...SOURCES[type]])
  const url = at(where, 'url')
  const subdirectory = field(value, 'subdirectory', where, checkSubdirectory)
  if (type === 'legacy') return { type, url: checkHttpUrl(value.url, url), name: text(value.reference, at(where, 'reference')) }
  if (type === 'url') return { type, url: checkHttpUrl(value.url, url), subdirectory }
  if (type === 'file' || type === 'directory') return { type, path: checkPath(value.url, url) }
  return {
    type,
    url: checkRepository(value.url, url),
    reference: field(value, 'reference', where, text),
    commit: readCommit(value.resolved_reference, at(where, 'resolved_reference')),
    subdirectory,
  }
}
