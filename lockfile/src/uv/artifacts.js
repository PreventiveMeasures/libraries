// A uv.lock package's sdist and wheels, as uv writes them for its source: a
// registry's files by URL, or a local registry's by path, with a hash, a
// size and an upload time where the registry gave them; a URL's, a path's
// or a git archive's file by its hash alone; nothing of a source tree.

import { LockfileError, at, quote } from '../error.js'
import { checkHash, checkPath, fileNameOf, parseWheelName } from '../python/files.js'
import { versionKey } from '../python/pep440.js'
import { field } from '../shape.js'
import { array, size, string, table } from '../toml/shape.js'
import { checkTime, checkUrl } from './shape.js'

// The algorithms uv's HashDigest reads, blake2b as blake2b-256.
const HASHES = { __proto__: null, md5: 32, sha256: 64, sha384: 96, sha512: 128, blake2b: 64 }

// The path of the archive a source is itself: a URL's, a path's, or one in
// a git repository; undefined for a registry or a source tree.
function archiveOf(source) {
  if (source.type === 'url') return new URL(source.url).pathname
  return source.type === 'path' || source.type === 'git' ? source.path : undefined
}

const kindOf = (archive) => (archive === undefined ? undefined : archive.endsWith('.whl') ? 'wheel' : 'sdist')

// Where a file of the source is: by `url` or `path` in a registry, by its
// `url` for a URL's wheel, by `filename` for any other wheel, and by
// nothing for the sdist a source is, which is the source's own archive.
function locations(source, wheel) {
  if (source.type === 'registry') return source.url === undefined ? ['url', 'path'] : ['url']
  if (!wheel) return []
  return source.type === 'url' ? ['url'] : ['filename']
}

// A registry's file may have a hash, a size and an upload time; the file a
// source is itself has its hash alone, always.
function readFile(value, where, source, wheel) {
  const places = locations(source, wheel)
  const registry = source.type === 'registry'
  table(value, where, [...places, 'hash', ...(registry ? ['size', 'upload-time', 'upload_time'] : [])])
  const given = places.filter((key) => value[key] !== undefined)
  if (places.length > 0 && given.length !== 1) throw new LockfileError(given.length === 0 ? `expected ${places.join(' or ')}` : 'a url and a path, of which uv reads the url alone', where)
  // uv 0.6 wrote `upload_time`, which uv still reads.
  if (value['upload-time'] !== undefined && value.upload_time !== undefined) throw new LockfileError('upload-time and upload_time, which are one field to uv', where)
  const url = field(value, 'url', where, checkUrl)
  const file = {
    url: url?.href,
    path: field(value, 'path', where, checkPath),
    filename: field(value, 'filename', where, string),
    hash: field(value, 'hash', where, (hash, here) => checkHash(hash, here, HASHES)),
    size: field(value, 'size', where, size),
    uploadTime: field(value, value.upload_time === undefined ? 'upload-time' : 'upload_time', where, checkTime),
  }
  if (!registry && file.hash === undefined) throw new LockfileError(`expected a hash, which uv writes for a file of a ${source.type} source`, where)
  return { file, pathname: url?.pathname }
}

export function readSdist(value, where, source) {
  if (value === undefined) return undefined
  const kind = kindOf(archiveOf(source))
  if (source.type !== 'registry' && kind !== 'sdist') throw new LockfileError(`an sdist, which a ${source.type} source${kind === 'wheel' ? ' of a wheel' : ''} has none of`, where)
  const { url, path, hash, size: bytes, uploadTime } = readFile(value, where, source, false).file
  return { url, path, hash, size: bytes, uploadTime }
}

// Each wheel is of the package, and its version is the package's, or the
// package's less a local version, as uv holds it.
export function readWheels(value, where, pkg) {
  if (value === undefined) return []
  const { source } = pkg
  const kind = kindOf(archiveOf(source))
  const list = array(value, where)
  if (source.type !== 'registry' && (kind !== 'wheel' || list.length !== 1)) {
    throw new LockfileError(kind === 'wheel' ? 'expected the one wheel the source is' : `wheels, which a ${source.type} source${kind === 'sdist' ? ' of an sdist' : ''} has none of`, where)
  }
  const seen = new Set()
  return list.map((item, index) => {
    const here = `${where}[${index}]`
    const { file, pathname } = readFile(item, here, source, true)
    const name = fileNameOf({ name: file.filename, path: file.path, pathname })
    const parsed = name === undefined ? undefined : parseWheelName(name)
    if (parsed === undefined) throw new LockfileError(`${quote(String(name))} is not the name of a wheel`, here)
    if (seen.has(name)) throw new LockfileError(`${quote(name)} is listed twice`, here)
    seen.add(name)
    if (parsed.name !== pkg.name) throw new LockfileError(`${quote(name)} is a wheel of ${quote(parsed.name)}, not of ${quote(pkg.name)}`, here)
    if (pkg.versionKey !== undefined && pkg.versionKey !== versionKey(parsed.version) && pkg.versionKey !== versionKey({ ...parsed.version, local: undefined })) {
      throw new LockfileError(`${quote(name)} is a wheel of another version than ${quote(pkg.version)}`, here)
    }
    if (source.type === 'url' && file.url !== source.url) throw new LockfileError(`${quote(file.url)} is not the URL the source names`, at(here, 'url'))
    return { ...file, filename: name }
  })
}
