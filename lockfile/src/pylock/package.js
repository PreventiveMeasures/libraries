// One [[packages]] of a pylock.toml: where it comes from, a VCS, a
// directory or an archive, or else an sdist and wheels, each file with its
// hashes, as packaging's Pylock reads them; a wheel's or an sdist's name
// holds it to the package's name and version.

import { LockfileError, at, quote } from '../error.js'
import { checkRelative, isCommit } from '../names.js'
import { DIGESTS, checkDigest, parseSdistName, parseWheelName } from '../python/files.js'
import { parseVersion, versionKey } from '../python/pep440.js'
import { checkName } from '../python/pep508.js'
import { TomlDateTime } from '../toml/datetime.js'
import { array, boolean, entries, refuse, size, string, table } from '../toml/shape.js'

export function text(value, where) {
  if (string(value, where) === '' || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)) throw new LockfileError(`${quote(value)} is empty, or has a control character in it`, where)
  return value
}

// A URL of the schemes a file is fetched by, or, for a VCS, any.
export function checkUrl(value, where, schemes = ['https:', 'http:', 'file:']) {
  const url = URL.parse(text(value, where))
  if (url === null || (schemes !== undefined && !schemes.includes(url.protocol))) throw new LockfileError(`${quote(value)} is not a URL${schemes === undefined ? '' : ` of ${schemes.map((scheme) => scheme.slice(0, -1)).join(', ')}`}`, where)
  return value
}

// A path from the lockfile's directory, `/` between segments, as one that
// reads the same on every machine: the spec takes an absolute one too.
export function checkPath(value, where) {
  if (/^(?:\/|[A-Za-z]:|\\)/u.test(text(value, where))) throw new LockfileError(`${quote(value)} is absolute, and only reads on the machine that wrote it`, where)
  return checkRelative(value, where)
}

// By algorithm, at least one, each digest of its size in lowercase hex.
function readHashes(value, where) {
  const hashes = Object.create(null)
  for (const [algorithm, digest, here] of entries(value, where)) {
    if (!(algorithm in DIGESTS)) throw new LockfileError(`${quote(algorithm)} is not a hash algorithm of hashlib's this reader knows`, here)
    hashes[algorithm] = checkDigest(algorithm, string(digest, here), DIGESTS[algorithm], here)
  }
  if (Object.keys(hashes).length === 0) throw new LockfileError('expected a hash at least', where)
  return hashes
}

// A TOML date-time in UTC.
function readTime(value, where) {
  if (!(value instanceof TomlDateTime)) throw refuse('a date-time', value, where)
  if (!/(?:Z|[+-]00:00)$/u.test(value.text)) throw new LockfileError(`${value.text} is not in UTC`, where)
  return value.text
}

const optional = (holder, key, where, read) => (holder[key] === undefined ? undefined : read(holder[key], at(where, key)))

// A file by URL or path, or both, and what else `fields` names.
function readFile(value, where, fields) {
  table(value, where, ['url', 'path', 'size', 'upload-time', 'hashes', ...fields])
  if (value.url === undefined && value.path === undefined) throw new LockfileError('expected a url or a path', where)
  return {
    url: optional(value, 'url', where, checkUrl),
    path: optional(value, 'path', where, checkPath),
    size: optional(value, 'size', where, size),
    uploadTime: optional(value, 'upload-time', where, readTime),
    hashes: readHashes(value.hashes, at(where, 'hashes')),
  }
}

const lastSegment = (path) => path.slice(path.lastIndexOf('/') + 1)

function fileName(file, where) {
  if (file.name !== undefined) return file.name
  if (file.path !== undefined) return lastSegment(file.path)
  try {
    return decodeURIComponent(lastSegment(new URL(file.url).pathname))
  } catch {
    throw new LockfileError(`${quote(file.url)} names no file`, where)
  }
}

// A file's name holds it to the package: its name, and its version, where
// the package has one.
function checkFileName(file, where, pkg, wheel) {
  const name = fileName(file, where)
  const parsed = wheel ? parseWheelName(name) : parseSdistName(name)
  if (parsed === undefined) throw new LockfileError(`${quote(name)} is not the name of ${wheel ? 'a wheel' : 'an sdist, .tar.gz or .zip'}`, where)
  if (parsed.name !== pkg.name) throw new LockfileError(`${quote(name)} is not a file of ${quote(pkg.name)}`, where)
  if (pkg.version !== undefined && versionKey(parsed.version) !== versionKey(parseVersion(pkg.version))) throw new LockfileError(`${quote(name)} is not of version ${quote(pkg.version)}`, where)
  return name
}

// The name of a wheel or an sdist, where given, is over its path's and URL's.
function readDistribution(value, where, pkg, wheel) {
  const file = { name: optional(value, 'name', where, text), ...readFile(value, where, ['name']) }
  return { ...file, name: checkFileName(file, where, pkg, wheel) }
}

export const readSdist = (value, where, pkg) => (value === undefined ? undefined : readDistribution(value, where, pkg, false))

export function readWheels(value, where, pkg) {
  if (value === undefined) return undefined
  const seen = new Set()
  return array(value, where).map((item, index) => {
    const here = `${where}[${index}]`
    const file = readDistribution(item, here, pkg, true)
    if (seen.has(file.name)) throw new LockfileError(`${quote(file.name)} is listed twice`, here)
    seen.add(file.name)
    return file
  })
}

export const readArchive = (value, where) => ({ ...readFile(value, where, ['subdirectory']), subdirectory: optional(value, 'subdirectory', where, checkRelative) })

export function readDirectory(value, where) {
  table(value, where, ['path', 'editable', 'subdirectory'])
  return {
    path: checkPath(value.path, at(where, 'path')),
    editable: optional(value, 'editable', where, boolean) ?? false,
    subdirectory: optional(value, 'subdirectory', where, checkRelative),
  }
}

// The VCSs PEP 610 registers; git and hg name a commit by its full hash.
const VCS = new Set(['git', 'hg', 'bzr', 'svn'])

export function readVcs(value, where) {
  table(value, where, ['type', 'url', 'path', 'requested-revision', 'commit-id', 'subdirectory'])
  const type = text(value.type, at(where, 'type'))
  if (!VCS.has(type)) throw new LockfileError(`expected one of ${[...VCS].join(', ')}`, at(where, 'type'))
  if (value.url === undefined && value.path === undefined) throw new LockfileError('expected a url or a path', where)
  const commitId = text(value['commit-id'], at(where, 'commit-id'))
  if ((type === 'git' || type === 'hg') && !isCommit(commitId)) throw new LockfileError(`${quote(commitId)} is not a full commit hash, which the spec requires`, at(where, 'commit-id'))
  return {
    type,
    url: optional(value, 'url', where, (url, here) => checkUrl(url, here, undefined)),
    path: optional(value, 'path', where, checkPath),
    requestedRevision: optional(value, 'requested-revision', where, text),
    commitId,
    subdirectory: optional(value, 'subdirectory', where, checkRelative),
  }
}

// Each of a publisher's identities, its `kind` and its own keys as written.
export function readAttestations(value, where) {
  if (value === undefined) return []
  return array(value, where).map((item, index) => {
    const here = `${where}[${index}]`
    text(table(item, here).kind, at(here, 'kind'))
    return item
  })
}

export const readGroupNames = (value, where) => array(value, where).map((name, index) => checkName(string(name, `${where}[${index}]`), `${where}[${index}]`))
