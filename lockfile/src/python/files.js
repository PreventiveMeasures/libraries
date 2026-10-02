// A distribution's file: the name and version a wheel's or an sdist's name
// gives, as packaging reads it, the name of the file a path or a URL ends
// in, a path or an http(s) URL to one, and a hash in the hex a lockfile
// writes.

import { LockfileError, quote } from '../error.js'
import { checkRelative, isHttpUrl } from '../names.js'
import { matching, string, text } from '../toml/shape.js'
import { normalName } from './pep508.js'
import { parseVersion, versionKey } from './pep440.js'

// PEP 427, as packaging 26.3's parse_wheel_filename takes it, its
// characters ASCII: `{name}-{version}(-{build})?-{python}-{abi}-{platform}.whl`,
// the name escaped with `_`, a build tag that starts with a digit, and tags
// of one or more names a `.` apart, a python tag's each an identifier.
const PYTHON_TAG = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/u
const TAG = /^\w+(?:\.\w+)*$/u

export function parseWheelName(filename) {
  if (!filename.endsWith('.whl')) return undefined
  const parts = filename.slice(0, -4).split('-')
  if (parts.length !== 5 && parts.length !== 6) return undefined
  const [name, version] = parts
  if (!/^[\w.]+$/u.test(name) || name.includes('__')) return undefined
  if (parts.length === 6 && !/^\d/u.test(parts[2])) return undefined
  const [python, abi, platform] = parts.slice(-3)
  if (!PYTHON_TAG.test(python) || !TAG.test(abi) || !TAG.test(platform)) return undefined
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
  __proto__: null,
  md5: 32,
  sha1: 40,
  sha224: 56,
  sha256: 64,
  sha384: 96,
  sha512: 128,
  sha3_224: 56,
  sha3_256: 64,
  sha3_384: 96,
  sha3_512: 128,
  blake2b: 128,
  blake2s: 64,
}

export function checkDigest(algorithm, digest, size, where) {
  if (digest.length !== size || !/^[\da-f]*$/u.test(digest)) throw new LockfileError(`${quote(digest)} is not a ${algorithm} digest in lowercase hex`, where)
  return digest
}

// A check of `algorithm:digest`, as uv.lock and poetry.lock write a hash,
// of one of the algorithms `sizes` names.
export const hashOf = (sizes) => (value, where) => {
  const sep = string(value, where).indexOf(':')
  const algorithm = value.slice(0, sep)
  if (sep === -1 || !Object.hasOwn(sizes, algorithm)) throw new LockfileError(`${quote(value)} is not a hash of ${Object.keys(sizes).join(', ')}`, where)
  checkDigest(algorithm, value.slice(sep + 1), sizes[algorithm], where)
  return value
}

// A path from the lockfile's directory, `/` between segments, as one that
// reads the same on every machine: never absolute, which pylock.toml's
// specification takes, and which reads on one machine alone.
export function checkPath(value, where) {
  if (/^(?:\/|\\|[A-Za-z]:)/u.test(string(value, where))) throw new LockfileError(`${quote(value)} is absolute, and only reads on the machine that wrote it`, where)
  return checkRelative(value, where)
}

// An index's URL, or a file's.
export const checkHttpUrl = matching(isHttpUrl, 'an http(s) URL', text)

const lastSegment = (path) => path.slice(path.lastIndexOf('/') + 1)

// The name of the file a lockfile gives by name, by path, or by URL, in
// that order: the last segment of the path, or of the URL's path, decoded.
export function fileNameOf(name, path, url, where) {
  if (name !== undefined) return name
  if (path !== undefined) return lastSegment(path)
  try {
    return decodeURIComponent(lastSegment(url.pathname))
  } catch {
    throw new LockfileError(`${quote(url.href)} names no file`, where)
  }
}

// A wheel's or an sdist's name, held to the package `pkg` is: to its name,
// and to its version where it has one, or, `lax`, that less a local
// version, as uv holds a wheel to it.
export function checkFileOf(filename, wheel, pkg, where, lax = false) {
  const parsed = wheel ? parseWheelName(filename) : parseSdistName(filename)
  if (parsed === undefined) throw new LockfileError(`${quote(filename)} is not the name of ${wheel ? 'a wheel' : 'an sdist, .tar.gz or .zip'}`, where)
  if (parsed.name !== pkg.name) throw new LockfileError(`${quote(filename)} is not a file of ${quote(pkg.name)}`, where)
  const of = (version) => pkg.versionKey === undefined || versionKey(version) === pkg.versionKey
  if (!of(parsed.version) && !(lax && of({ ...parsed.version, local: undefined }))) throw new LockfileError(`${quote(filename)} is not of version ${quote(pkg.version)}`, where)
  return filename
}
