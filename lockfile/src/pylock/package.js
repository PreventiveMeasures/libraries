// One [[packages]] of a pylock.toml: where it comes from, a VCS, a
// directory or an archive, or else an sdist and wheels, each file with its
// hashes, as packaging's Pylock reads them; a wheel's or an sdist's name
// holds it to the package's name and version.

import { LockfileError, at, quote } from '../error.js'
import { isCommit } from '../names.js'
import { DIGESTS, checkDigest, checkPath, fileNameOf, parseSdistName, parseWheelName } from '../python/files.js'
import { versionKey } from '../python/pep440.js'
import { field } from '../shape.js'
import { TomlDateTime } from '../toml/datetime.js'
import { array, boolean, entries, refuse, size, string, table, text } from '../toml/shape.js'

const FILE_SCHEMES = ['https:', 'http:', 'file:']

// A URL, as written, of the schemes a file is fetched by, or, for a VCS,
// any; parsed, for its path.
function parseUrl(value, where, schemes = FILE_SCHEMES) {
  const url = URL.parse(text(value, where))
  if (url === null || (schemes !== undefined && !schemes.includes(url.protocol))) throw new LockfileError(`${quote(value)} is not a URL${schemes === undefined ? '' : ` of ${schemes.map((scheme) => scheme.slice(0, -1)).join(', ')}`}`, where)
  return url
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

// A file by URL or path, or both, and what else `fields` names; with the
// URL's path, for the file's name.
function readFile(value, where, fields) {
  table(value, where, ['url', 'path', 'size', 'upload-time', 'hashes', ...fields])
  if (value.url === undefined && value.path === undefined) throw new LockfileError('expected a url or a path', where)
  const url = field(value, 'url', where, parseUrl)
  const file = {
    url: url === undefined ? undefined : value.url,
    path: field(value, 'path', where, checkPath),
    size: field(value, 'size', where, size),
    uploadTime: field(value, 'upload-time', where, readTime),
    hashes: readHashes(value.hashes, at(where, 'hashes')),
  }
  return { file, pathname: url?.pathname }
}

// A wheel's or an sdist's name, as given, or its path's or URL's, holds it
// to the package: its name, and its version, where the package has one.
function readDistribution(value, where, pkg, wheel) {
  const given = field(value, 'name', where, text)
  const { file, pathname } = readFile(value, where, ['name'])
  const name = fileNameOf({ name: given, path: file.path, pathname })
  if (name === undefined) throw new LockfileError(`${quote(file.url)} names no file`, where)
  const parsed = wheel ? parseWheelName(name) : parseSdistName(name)
  if (parsed === undefined) throw new LockfileError(`${quote(name)} is not the name of ${wheel ? 'a wheel' : 'an sdist, .tar.gz or .zip'}`, where)
  if (parsed.name !== pkg.name) throw new LockfileError(`${quote(name)} is not a file of ${quote(pkg.name)}`, where)
  if (pkg.versionKey !== undefined && versionKey(parsed.version) !== pkg.versionKey) throw new LockfileError(`${quote(name)} is not of version ${quote(pkg.version)}`, where)
  return { name, ...file }
}

export const readSdist = (value, where, pkg) => (value === undefined ? undefined : readDistribution(value, where, pkg, false))

export function readWheels(value, where, pkg) {
  if (value === undefined) return []
  const seen = new Set()
  return array(value, where).map((item, index) => {
    const here = `${where}[${index}]`
    const file = readDistribution(item, here, pkg, true)
    if (seen.has(file.name)) throw new LockfileError(`${quote(file.name)} is listed twice`, here)
    seen.add(file.name)
    return file
  })
}

export const readArchive = (value, where) => ({ ...readFile(value, where, ['subdirectory']).file, subdirectory: field(value, 'subdirectory', where, checkPath) })

export function readDirectory(value, where) {
  table(value, where, ['path', 'editable', 'subdirectory'])
  return {
    path: checkPath(value.path, at(where, 'path')),
    editable: field(value, 'editable', where, boolean) ?? false,
    subdirectory: field(value, 'subdirectory', where, checkPath),
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
    url: field(value, 'url', where, (url, here) => parseUrl(url, here, undefined) && url),
    path: field(value, 'path', where, checkPath),
    requestedRevision: field(value, 'requested-revision', where, text),
    commitId,
    subdirectory: field(value, 'subdirectory', where, checkPath),
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
