// pnpm's package extensions (createPackageExtender), and the checksum a frozen
// install holds the lockfile to. Only what pnpm 10, 11 and 12 hash alike is
// read: pnpm 12 hashes an extension as it parses it, less what it does not know.

import { satisfies, validRange } from '@preventive/upstream/semver.js'
import { compareNames } from '@preventive/vfs/path.js'
import { DeptreeError, quote } from '../error.js'
import { sha256Base64 } from '../hash.js'
import { parseWanted } from './overrides.js'
import { readers } from './readers.js'

const META = 'peerDependenciesMeta'
const FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies', META]
const onlyOptional = (meta) => Object.entries(meta).every(([key, flag]) => key === 'optional' && typeof flag === 'boolean')

function checkExtension(extension, where) {
  for (const [field, value] of Object.entries(readers.mapping(extension, where))) {
    if (!FIELDS.includes(field)) throw new DeptreeError(`${quote(field)} is not supported: pnpm extends only ${FIELDS.join(', ')}`, where)
    for (const [name, entry] of Object.entries(readers.mapping(value, `${where}.${field}`))) {
      const here = `${where}.${field}[${quote(name)}]`
      if (field !== META) readers.text(entry, here)
      else if (!onlyOptional(readers.mapping(entry, here))) throw new DeptreeError('expected nothing but `optional`, true or false', here)
    }
  }
}

// The ranges pnpm 12 is seen to read as npm's semver does. It fails on `~=7`
// and an empty one, which npm's reads, and takes `07`, which npm's does not.
const COMPARATOR = /^(?:[<>]=?|[=^~])?(?:\d+|[Xx*])(?:\.(?:\d+|[Xx*])){0,2}(?:-[\dA-Za-z.-]+)?$/u
const plain = (range) => validRange(range) !== null && range.split('||').every((set) => set.trim().split(/ +/u).every((part) => COMPARATOR.test(part)))

export function listExtensions(packageExtensions, major = 10) {
  return Object.entries(packageExtensions ?? {}).map(([selector, extension]) => {
    const where = `packageExtensions[${quote(selector)}]`
    const parsed = selector.isWellFormed() ? parseWanted(selector) : undefined
    if (parsed === undefined) throw new DeptreeError('the selector names no package, which is not supported', where)
    // pnpm 12 applies them in the order written, and a mapping lists digits first.
    if (major >= 12 && /^\d+$/u.test(selector)) throw new DeptreeError('a name of digits alone is not supported for pnpm 12', where)
    if (major >= 12 && parsed.range !== undefined && !plain(parsed.range)) throw new DeptreeError(`pnpm 12 fails on the range ${quote(parsed.range)}, or may read it otherwise than npm's semver, which is not supported`, where)
    checkExtension(extension, where)
    return { selector, ...parsed, extension }
  })
}

// object-hash's text of a value: a string by its length in UTF-16 units, keys
// sorted by those units for pnpm 10 and 11 and by code point for pnpm 12.
function hashed(value, compare) {
  if (typeof value === 'string') return `string:${value.length}:${value}`
  if (typeof value === 'boolean') return `bool:${value}`
  const keys = Object.keys(value).sort(compare)
  return `object:${keys.length}:${keys.map((key) => `${hashed(key, compare)}:${hashed(value[key], compare)},`).join('')}`
}

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

export function extensionsOf(extensions, manifest, where) {
  return extensions.filter(({ name, range }) => name === manifest.name && (range === undefined || inRange(manifest.version, range, where, 'an extension')))
}

// A package.json's own entry wins, and of two extensions the first.
export function extend(copy, extensions) {
  for (const { extension } of extensions) {
    for (const field of FIELDS) if (Object.hasOwn(extension, field)) copy[field] = { ...extension[field], ...copy[field] }
  }
}
