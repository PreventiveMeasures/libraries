// Where a pin's package comes from, and the identity SwiftPM knows it by.

import { LockfileError, quote } from '../error.js'
import { checkHostUrl, checkRepo } from '../names.js'
import { checkerOf, text } from '../shape.js'

// A remote repository's URL, in printable ASCII but `\`: SwiftPM finds the
// identity in it by grapheme clusters, and on Windows by `\` too.
export function checkLocation(value, where) {
  const location = checkRepo(value, where)
  if (/^(?:\/|file:)/iu.test(location)) throw new LockfileError(`${quote(location)} is a repository on the machine that wrote the lockfile, by its path, which reads on that machine alone`, where)
  if (/[^!-[\]-~]/u.test(location)) throw new LockfileError(`${quote(location)} is not printable ASCII but "\\", of which SwiftPM finds the identity by grapheme clusters, and on Windows by "\\" too`, where)
  return checkHostUrl(location, where, 'SwiftPM')
}

// PackageIdentity.registry's `scope.name`, in the case the manifest gives.
const REGISTRY = /^(?=[^.]{1,39}\.)[\dA-Za-z](?:-?[\dA-Za-z])*\.(?=[^.]{1,100}$)[\dA-Za-z](?:[_-]?[\dA-Za-z])*$/u

export const checkRegistryIdentity = checkerOf(text)((identity) => REGISTRY.test(identity), 'a registry\'s package, scope.name')

// PackageIdentityParser's: the last component, but a `/` that ends the
// location, less `.git`, in lowercase; and held to the identity written.
export function checkIdentity(location, where, written = undefined) {
  const end = location.endsWith('/') ? location.length - 1 : location.length
  const last = location.slice(location.lastIndexOf('/', end - 1) + 1, end)
  const identity = (last.endsWith('.git') ? last.slice(0, -4) : last).toLowerCase()
  if (identity === '') throw new LockfileError(`${quote(location)} has no last component, of which SwiftPM makes a package's identity`, where)
  if (written !== undefined && written !== identity) {
    throw new LockfileError(`${quote(written)} is not the identity of its location, ${quote(identity)}: SwiftPM writes one of another where a mirror of another name is configured, and without the mirror finds the package no pin`, where)
  }
  return identity
}
