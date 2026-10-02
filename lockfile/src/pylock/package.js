// One [[packages]] of a pylock.toml: where it comes from, a VCS, a
// directory or an archive, or else an sdist and wheels, each file with its
// hashes, as packaging's Pylock reads them; a wheel's or an sdist's name
// holds it to the package's name and version.

import { LockfileError, at, quote } from '../error.js'
import { isCommit } from '../names.js'
import { DIGESTS, checkDigest, checkFileOf, checkPath, fileNameOf } from '../python/files.js'
import { field } from '../shape.js'
import { TomlDateTime } from '../toml/datetime.js'
import { arrayOf, boolean, distinct, entries, matching, refuse, size, string, table, text } from '../toml/shape.js'

// A file's URL, of a scheme it is fetched by; a VCS's, of any.
const checkFileUrl = matching((url) => ['https:', 'http:', 'file:'].includes(URL.parse(url)?.protocol), 'a URL of https, http, file', text)
const checkVcsUrl = matching((url) => URL.canParse(url), 'a URL', text)

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

// A file by URL or path, or both, and what else `fields` names.
function readFile(value, where, fields) {
  table(value, where, ['url', 'path', 'size', 'upload-time', 'hashes', ...fields])
  if (value.url === undefined && value.path === undefined) throw new LockfileError('expected a url or a path', where)
  return {
    url: field(value, 'url', where, checkFileUrl),
    path: field(value, 'path', where, checkPath),
    size: field(value, 'size', where, size),
    uploadTime: field(value, 'upload-time', where, readTime),
    hashes: readHashes(value.hashes, at(where, 'hashes')),
  }
}

// A wheel's or an sdist's name, as given, or its path's or URL's, holds it
// to the package: its name, and its version, where the package has one.
function readDistribution(value, where, pkg, wheel) {
  const file = readFile(value, where, ['name'])
  const name = fileNameOf(field(value, 'name', where, text), file.path, file.url && new URL(file.url), where)
  return { name: checkFileOf(name, wheel, pkg, where), ...file }
}

export const readSdist = (value, where, pkg) => (value === undefined ? undefined : readDistribution(value, where, pkg, false))

export function readWheels(value, where, pkg) {
  if (value === undefined) return []
  return distinct(arrayOf((item, here) => readDistribution(item, here, pkg, true))(value, where), where, (wheel) => wheel.name)
}

export const readArchive = (value, where) => ({ ...readFile(value, where, ['subdirectory']), subdirectory: field(value, 'subdirectory', where, checkPath) })

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
    url: field(value, 'url', where, checkVcsUrl),
    path: field(value, 'path', where, checkPath),
    requestedRevision: field(value, 'requested-revision', where, text),
    commitId,
    subdirectory: field(value, 'subdirectory', where, checkPath),
  }
}

// One of a publisher's identities, its `kind` and its own keys as written.
export function readAttestation(value, where) {
  text(table(value, where).kind, at(where, 'kind'))
  return value
}
