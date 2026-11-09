// Package extensions as pnpm's createPackageExtender reads them: what each
// adds to the package.json of the packages its selector names, before the
// overrides are read. A frozen install holds them to the lockfile only by
// their checksum, object-hash's sha256 of the setting for pnpm 10 and 11
// and pnpm 12's own port of it. pnpm 12 hashes an extension as it parses it,
// without a key it does not know and with a value of another type as it
// takes it, and pnpm 11 fails on some of those from 11.22: only what all
// three read alike is read here.

import { satisfies, validRange } from '@preventive/upstream/semver.js'
import { compareNames } from '@preventive/vfs/path.js'
import { DeptreeError, quote } from '../error.js'
import { sha256Base64 } from '../hash.js'
import { parseWanted } from './overrides.js'
import { readers } from './readers.js'

const META = 'peerDependenciesMeta'
const FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies', META]

function checkMeta(meta, where) {
  const known = Object.entries(readers.mapping(meta, where)).every(([key, flag]) => key === 'optional' && typeof flag === 'boolean')
  if (!known) throw new DeptreeError('expected nothing but `optional`, true or false', where)
}

function checkExtension(extension, where) {
  for (const [field, value] of Object.entries(readers.mapping(extension, where))) {
    if (!FIELDS.includes(field)) throw new DeptreeError(`${quote(field)} is not supported: pnpm extends only dependencies, optionalDependencies, peerDependencies and peerDependenciesMeta`, where)
    const here = `${where}.${field}`
    const check = field === META ? checkMeta : readers.text
    for (const [name, entry] of Object.entries(readers.mapping(value, here))) check(entry, `${here}[${quote(name)}]`)
  }
}

// The ranges pnpm 12 is seen to read as npm's semver does. It fails on one
// npm's does not read, though it takes `07`, and on some npm's reads, such
// as `~=7.0` and an empty one.
const VERSION = /^\d+(?:\.\d+){0,2}(?:-[\dA-Za-z.-]+)?$/u
const COMPARATOR = /^(?:[<>]=?|[=^~])?(?:\d+|[Xx*])(?:\.(?:\d+|[Xx*])){0,2}(?:-[\dA-Za-z.-]+)?$/u
function plain(range) {
  return validRange(range) !== null && range.split('||').every((set) => {
    const parts = set.trim().split(/ +/u)
    return parts.length === 3 && parts[1] === '-' ? VERSION.test(parts[0]) && VERSION.test(parts[2]) : parts.every((part) => COMPARATOR.test(part))
  })
}

// In the order pnpm applies them: as written, but that a mapping lists a
// key of digits alone first, as pnpm 10 and 11 read them too and pnpm 12
// does not.
export function listExtensions(packageExtensions, major = 10) {
  return Object.entries(packageExtensions ?? {}).map(([selector, extension]) => {
    const where = `packageExtensions[${quote(selector)}]`
    const parsed = selector.isWellFormed() ? parseWanted(selector) : undefined
    if (parsed === undefined) throw new DeptreeError('the selector names no package, which is not supported', where)
    if (major >= 12 && /^\d+$/u.test(selector)) throw new DeptreeError('pnpm 12 applies the extensions in the order they are written, which is lost for a name of digits alone, and that is not supported', where)
    if (major >= 12 && parsed.range !== undefined && !plain(parsed.range)) {
      throw new DeptreeError(`pnpm 12 fails on its range, ${quote(parsed.range)}, or may read it otherwise than npm's semver, which is not supported`, where)
    }
    checkExtension(extension, where)
    return { selector, ...parsed, extension }
  })
}

// object-hash's text of a value, as pnpm has it hash one: an object by its
// keys in order, a string by its length in UTF-16 units.
function hashed(value, compare) {
  if (typeof value === 'string') return `string:${value.length}:${value}`
  if (typeof value === 'boolean') return `bool:${value}`
  const keys = Object.keys(value).sort(compare)
  return `object:${keys.length}:${keys.map((key) => `${hashed(key, compare)}:${hashed(value[key], compare)},`).join('')}`
}

// pnpm's hashObjectNullableWithPrefix, undefined where there are none. The
// keys are in the order of their UTF-16 units for pnpm 10 and 11, as
// JavaScript sorts them, and of their code points for pnpm 12.
export async function extensionsChecksum(extensions, major = 10) {
  if (extensions.length === 0) return undefined
  const setting = Object.fromEntries(extensions.map(({ selector, extension }) => [selector, extension]))
  return `sha256-${await sha256Base64(hashed(setting, major >= 12 ? compareNames : undefined), 'packageExtensions')}`
}

// semver's satisfies throws a TypeError on a version that is neither a
// string nor falsy, as pnpm then fails.
export function inRange(version, range, where, named) {
  if (version && typeof version !== 'string') throw new DeptreeError(`not a string, which pnpm fails on where ${named} names this package with a range`, `${where}.version`)
  return satisfies(version, range)
}

// Those pnpm extends a package.json by: of its name, and of its version
// where the selector has a range.
export function extensionsOf(extensions, manifest, where) {
  return extensions.filter(({ name, range }) => name === manifest.name && (range === undefined || inRange(manifest.version, range, where, 'an extension')))
}

// pnpm's extendPkg, on a copy: the package.json's own entry wins, and of two
// extensions the first.
export function extend(copy, extensions, where) {
  for (const { extension } of extensions) {
    for (const field of FIELDS) {
      if (!Object.hasOwn(extension, field)) continue
      if (field === META && copy[META] != null) readers.mapping(copy[META], `${where}.${META}`)
      copy[field] = { ...structuredClone(extension[field]), ...copy[field] }
    }
  }
}
