// A uv.lock package's sdist and wheels, as uv writes them for its source: a
// registry's files by URL, or a local registry's by path, with a hash, a
// size and an upload time where the registry gave them; a URL's, a path's
// or a git archive's file by its hash alone; nothing of a source tree.

import { LockfileError, at, quote } from '../error.js'
import { checkHash, parseWheelName } from '../python/files.js'
import { versionKey } from '../python/pep440.js'
import { TomlDateTime } from '../toml/datetime.js'
import { array, size, string, table } from '../toml/shape.js'
import { checkPath, checkUrl, needsHash } from './source.js'

// The algorithms uv's HashDigest reads, blake2b as blake2b-256.
const HASHES = { __proto__: null, md5: 32, sha256: 64, sha384: 96, sha512: 128, blake2b: 64 }

// A date-time the TOML parser would read, held to a date in the calendar.
export function isDateTime(text) {
  try {
    return new TomlDateTime(text).text === text
  } catch {
    return false
  }
}

// As jiff writes a timestamp: UTC, to the second or a fraction of it.
export function checkTime(value, where) {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/u.test(string(value, where)) || !isDateTime(value)) throw new LockfileError(`${quote(value)} is not a UTC timestamp`, where)
  return value
}

// Where each kind of source keeps its files: by `url` or `path`, or by
// `filename` alone, beside its own path. A URL's archive is the URL itself.
function locations(source) {
  if (source.type === 'registry') return source.url === undefined ? ['url', 'path'] : ['url']
  if (source.type === 'url') return ['url']
  return ['filename']
}

function readFile(value, where, source, wheel) {
  const places = locations(source)
  const remote = source.type === 'registry'
  const sdistOfArchive = !wheel && !remote
  const fields = [...(sdistOfArchive ? [] : places), 'hash', ...(remote ? ['size', 'upload-time', 'upload_time'] : [])]
  table(value, where, fields)
  // uv 0.6 wrote `upload_time`, which uv still reads.
  if (value['upload-time'] !== undefined && value.upload_time !== undefined) throw new LockfileError('upload-time and upload_time, which are one field to uv', where)
  const uploadKey = value.upload_time === undefined ? 'upload-time' : 'upload_time'
  const place = places.find((key) => value[key] !== undefined)
  if (!sdistOfArchive && place === undefined) throw new LockfileError(`expected ${places.join(' or ')}`, where)
  const file = { url: undefined, path: undefined, filename: undefined, hash: undefined, size: undefined, uploadTime: undefined }
  if (place === 'url') file.url = checkUrl(value.url, at(where, 'url')).href
  if (place === 'path') file.path = checkPath(value.path, at(where, 'path'))
  if (place === 'filename') file.filename = string(value.filename, at(where, 'filename'))
  if (value.hash !== undefined) file.hash = checkHash(string(value.hash, at(where, 'hash')), at(where, 'hash'), HASHES)
  if (value.size !== undefined) file.size = size(value.size, at(where, 'size'))
  if (value[uploadKey] !== undefined) file.uploadTime = checkTime(value[uploadKey], at(where, uploadKey))
  if (needsHash(source) && file.hash === undefined) throw new LockfileError(`expected a hash, which uv writes for a file of a ${source.type} source`, where)
  return file
}

// The last segment of a path, or of a URL's, decoded, is a wheel's name.
const lastSegment = (text) => text.slice(text.lastIndexOf('/') + 1)

function wheelName(file, where) {
  let name = file.filename ?? (file.path === undefined ? undefined : lastSegment(file.path))
  try {
    name ??= decodeURIComponent(lastSegment(new URL(file.url).pathname))
  } catch {
    name = undefined
  }
  const parsed = name === undefined ? undefined : parseWheelName(name)
  if (parsed === undefined) throw new LockfileError(`${quote(String(name))} is not the name of a wheel`, where)
  return { name, parsed }
}

// What kind of file a source's own path or URL is: an sdist, a wheel, or
// neither for a source with no file of its own.
function archiveKind(source) {
  const own = source.type === 'url' ? new URL(source.url).pathname : source.type === 'path' ? source.path : source.type === 'git' ? source.path : undefined
  if (own === undefined) return undefined
  return own.endsWith('.whl') ? 'wheel' : 'sdist'
}

export function readSdist(value, where, source) {
  if (value === undefined) return undefined
  const kind = archiveKind(source)
  if (source.type !== 'registry' && kind !== 'sdist') throw new LockfileError(`an sdist, which a ${source.type} source${kind === 'wheel' ? ' of a wheel' : ''} has none of`, where)
  const { url, path, hash, size: bytes, uploadTime } = readFile(value, where, source, false)
  return { url, path, hash, size: bytes, uploadTime }
}

// Each wheel is of the package, and its version is the package's, or the
// package's less a local version, as uv holds it.
export function readWheels(value, where, pkg) {
  if (value === undefined) return []
  const { source } = pkg
  const kind = archiveKind(source)
  const list = array(value, where)
  if (source.type !== 'registry' && (kind !== 'wheel' || list.length !== 1)) {
    throw new LockfileError(kind === 'wheel' ? 'expected the one wheel the source is' : `wheels, which a ${source.type} source${kind === 'sdist' ? ' of an sdist' : ''} has none of`, where)
  }
  const seen = new Set()
  return list.map((item, index) => {
    const here = `${where}[${index}]`
    const file = readFile(item, here, source, true)
    const { name, parsed } = wheelName(file, here)
    if (seen.has(name)) throw new LockfileError(`${quote(name)} is listed twice`, here)
    seen.add(name)
    if (parsed.name !== pkg.name) throw new LockfileError(`${quote(name)} is a wheel of ${quote(parsed.name)}, not of ${quote(pkg.name)}`, here)
    if (pkg.versionKey !== undefined && pkg.versionKey !== versionKey(parsed.version) && pkg.versionKey !== versionKey({ ...parsed.version, local: undefined })) {
      throw new LockfileError(`${quote(name)} is a wheel of another version than ${quote(pkg.version)}`, here)
    }
    if (source.type === 'url' && file.url !== source.url) throw new LockfileError(`${quote(file.url)} is not the URL the source names`, at(here, 'url'))
    file.filename = name
    return file
  })
}
