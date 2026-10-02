// A distribution's file: the name and version a wheel's or an sdist's name
// gives, as packaging reads it, the name of the file a path or a URL ends
// in, a path to one, and a hash in the hex a lockfile writes.

import { LockfileError, quote } from '../error.js'
import { checkRelative, checkWithin, isHttpUrl } from '../names.js'
import { checkerOf } from '../shape.js'
import { string, text } from '../toml/shape.js'
import { normalName } from './pep508.js'
import { parseVersion } from './pep440.js'

// PEP 427, as packaging 26.3's parse_wheel_filename takes it, its
// characters ASCII: `{name}-{version}(-{build})?-{python}-{abi}-{platform}.whl`,
// the name escaped with `_`, a build tag that starts with a digit, and tags
// of one or more names a `.` apart, a python tag's each an identifier.
const WHEEL = /^([\w.]+)-([^-]*)(?:-\d[^-]*)?-[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*(?:-\w+(?:\.\w+)*){2}\.whl$/u

export function parseWheelName(filename) {
  const [, name, version] = WHEEL.exec(filename) ?? []
  if (name === undefined || name.includes('__')) return undefined
  const parsed = parseVersion(version)
  return parsed === undefined ? undefined : { name: normalName(name), version: parsed }
}

// As packaging's parse_sdist_filename: `.tar.gz` or `.zip`, and the name
// and the version either side of the last `-`.
export function parseSdistName(filename) {
  const base = /^(.*)\.(?:tar\.gz|zip)$/su.exec(filename)?.[1]
  const sep = base?.lastIndexOf('-') ?? -1
  if (sep === -1) return undefined
  const parsed = parseVersion(base.slice(sep + 1))
  return parsed === undefined ? undefined : { name: normalName(base.slice(0, sep)), version: parsed }
}

// The size of each algorithm's digest, in hex digits.
export const DIGESTS = {
  __proto__: null, md5: 32, sha1: 40, sha224: 56, sha256: 64, sha384: 96, sha512: 128,
  sha3_224: 56, sha3_256: 64, sha3_384: 96, sha3_512: 128, blake2b: 128, blake2s: 64,
}

export function checkDigest(algorithm, digest, size, where) {
  if (digest.length !== size || !/^[\da-f]*$/u.test(digest)) throw new LockfileError(`${quote(digest)} is not a ${algorithm} digest in lowercase hex`, where)
  return digest
}

// `algorithm:digest`, as uv.lock and poetry.lock write a hash, of one of
// the algorithms `sizes` names.
export function checkHash(value, where, sizes) {
  const sep = string(value, where).indexOf(':')
  const algorithm = value.slice(0, sep)
  if (sep === -1 || !Object.hasOwn(sizes, algorithm)) throw new LockfileError(`${quote(value)} is not a hash of ${Object.keys(sizes).join(', ')}`, where)
  checkDigest(algorithm, value.slice(sep + 1), sizes[algorithm], where)
  return value
}

export const checkHttpUrl = checkerOf(text)(isHttpUrl, 'an http(s) URL')

// A path from the lockfile's directory, `/` between segments, as one that
// reads the same on every machine: never absolute, which pylock.toml's
// specification takes, and which reads on one machine alone.
export function checkPath(value, where) {
  if (/^(?:\/|\\|[A-Za-z]:)/u.test(string(value, where))) throw new LockfileError(`${quote(value)} is absolute, and only reads on the machine that wrote it`, where)
  return checkRelative(value, where)
}

// A subdirectory of an archive or a repository, which an installer joins
// to where it unpacks or clones it: one that never climbs out of that.
export const checkSubdirectory = (value, where) => checkWithin(checkPath(value, where), where)

const lastSegment = (path) => path.slice(path.lastIndexOf('/') + 1)

// The name of the file a lockfile gives by name, by path, or by URL, in
// that order: the last segment of the path, or of the URL's `pathname`,
// decoded; undefined where that does not decode.
export function fileNameOf({ name, path, pathname }) {
  if (name !== undefined) return name
  if (path !== undefined) return lastSegment(path)
  try {
    return decodeURIComponent(lastSegment(pathname))
  } catch {
    return undefined
  }
}
