// Where a pin's package comes from, and the identity SwiftPM knows it by:
// of a repository, the last component of its location, as
// PackageIdentityParser finds it; of a registry's package, its scope and
// name.

import { LockfileError, quote } from '../error.js'
import { checkHostUrl, checkRepo } from '../names.js'
import { checkerOf, text } from '../shape.js'

// A repository of the machine that wrote the lockfile, by its path or a
// file URL, which reads on that machine alone.
const LOCAL = /^(?:\/|file:)/iu

// A remote repository's location, as a manifest gives it and SwiftPM writes
// it back: a URL of a host git fetches from, or scp's `user@host:path`.
// ASCII alone: SwiftPM finds the identity in it by Swift's characters,
// grapheme clusters, which join a `/` or the `t` of `.git` to a combining
// mark after it, where a reader by code points finds another. Nor is a
// backslash in it, which SwiftPM on Windows reads as a separator, and
// elsewhere does not.
export function checkLocation(value, where) {
  const location = checkRepo(value, where)
  if (LOCAL.test(location)) throw new LockfileError(`${quote(location)} is a repository on the machine that wrote the lockfile, by its path, which reads on that machine alone`, where)
  if (/[^!-~]/u.test(location)) throw new LockfileError(`${quote(location)} is not ASCII, of which SwiftPM finds the identity by grapheme clusters, as no other reader does`, where)
  if (location.includes('\\')) throw new LockfileError(`${quote(location)} has a backslash, which SwiftPM on Windows reads as a separator, and elsewhere does not`, where)
  return checkHostUrl(location, where, 'SwiftPM')
}

// A registry's package, `scope.name`, as PackageIdentity.registry reads one:
// a scope of 1 to 39 letters, digits and hyphens, and a name of 1 to 100 of
// those and underscores, ASCII alone; neither with a hyphen or underscore
// first, last, or after another. In the case the manifest gives it in.
const REGISTRY = /^(?=[^.]{1,39}\.)[\dA-Za-z](?:-?[\dA-Za-z])*\.(?=[^.]{1,100}$)[\dA-Za-z](?:[_-]?[\dA-Za-z])*$/u

export const checkRegistryIdentity = checkerOf(text)((identity) => REGISTRY.test(identity), 'a registry\'s package, scope.name')

// The identity of a repository's location, as PackageIdentityParser finds
// it: the last component, after the last `/` but one that ends the
// location, less a `.git` that ends it, in lowercase. Of an ASCII location,
// as checkLocation holds one to. Version 1 writes no identity but this.
export function identityFrom(location, where) {
  const end = location.endsWith('/') ? location.length - 1 : location.length
  const last = location.slice(location.lastIndexOf('/', end - 1) + 1, end)
  const identity = (last.endsWith('.git') ? last.slice(0, -4) : last).toLowerCase()
  if (identity === '') throw new LockfileError(`${quote(location)} has no last component, of which SwiftPM makes a package's identity`, where)
  return identity
}

// The identity a pin of a repository has, of 2 and 3: its location's.
export function checkIdentity(identity, location, where) {
  const expected = identityFrom(location, where)
  if (identity === expected) return identity
  throw new LockfileError(`${quote(identity)} is not the identity of its location, ${quote(expected)}: SwiftPM writes one of another where a mirror of another name is configured, and without the mirror finds the package no pin`, where)
}
