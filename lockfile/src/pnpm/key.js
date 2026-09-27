// How pnpm spells what a dependency leads to, read as pnpm reads it
// (@pnpm/deps.path, 1001.x): the same scan, so a key splits here where it
// splits for pnpm, and then held to what pnpm writes.
//
// A package key is `name@version`, or `name@` and where the package comes
// from when that is not a registry (`file:dir`, a tarball URL, a git URL).
// A snapshot key is a package key and a suffix: `(patch_hash=…)` when the
// package is patched, then a `(…)` for each peer it was resolved with,
// which nest (`(react-dom@18.2.0(react@18.2.0))`), or one hash in their
// place where they would run past `peersSuffixMaxLength`.

import { LockfileError, quote } from '../error.js'
import { checkName } from '../names.js'

const PATCH = '(patch_hash='

// pnpm's indexOfDepPathSuffix: where the run of balanced groups that ends
// the key begins, and whether it begins with the patch hash.
function suffixOf(key) {
  if (!key.endsWith(')')) return { peers: -1, patch: -1 }
  let open = 1
  for (let i = key.length - 2; i >= 0; i--) {
    if (key[i] === '(') open--
    else if (key[i] === ')') open++
    else if (open === 0) {
      if (key.startsWith(PATCH, i + 1)) return { patch: i + 1, peers: key.indexOf('(', i + 2) }
      return { patch: -1, peers: i + 1 }
    }
  }
  return { peers: -1, patch: -1 }
}

// pnpm's removeSuffix: the package key under a snapshot key.
export function packageKeyOf(key) {
  const { peers, patch } = suffixOf(key)
  return patch === -1 ? (peers === -1 ? key : key.slice(0, peers)) : key.slice(0, patch)
}

// Groups one after the other, each balanced and not empty, none of them a
// second patch hash; the scan above has only found where they start.
function checkGroups(groups, key, where) {
  let open = 0
  for (let i = 0; i < groups.length; i++) {
    if (open === 0 && (groups[i] !== '(' || groups[i + 1] === ')' || groups.startsWith(PATCH, i))) {
      throw new LockfileError(`${quote(key)} does not end in peers in parentheses`, where)
    }
    if (groups[i] === '(') open++
    else if (groups[i] === ')') open--
  }
}

// The package key, and the patch hash when there is one.
export function splitSnapshotKey(key, where) {
  const { peers, patch } = suffixOf(key)
  let hash
  if (patch !== -1) {
    const group = key.slice(patch, peers === -1 ? key.length : peers)
    hash = /^\(patch_hash=([\da-z]+)\)$/u.exec(group)?.[1]
    if (hash === undefined) throw new LockfileError(`${quote(group)} is not a patch hash`, where)
  }
  if (peers !== -1) checkGroups(key.slice(peers), key, where)
  return { base: packageKeyOf(key), patchHash: hash }
}

// A package key's name, checked, and what follows its `@`.
export function splitPackageKey(key, where) {
  const sep = key.indexOf('@', 1)
  if (sep === -1 || sep === key.length - 1) throw new LockfileError(`${quote(key)} is not a key of the form name@version`, where)
  if (packageKeyOf(key) !== key) throw new LockfileError(`${quote(key)} carries a peer or patch suffix, which only a snapshot key does`, where)
  return { name: checkName(key.slice(0, sep), where), ref: key.slice(sep + 1) }
}

// pnpm's refToRelative, but for `link:`: the key a dependency's reference
// names. A bare version is the alias's own (`react: 18.2.0`); one that
// names its package first is an alias for that package (`my-q: q@1.5.1`),
// told apart by an `@` before any `:` or `(`.
export function refToKey(ref, alias) {
  if (ref.startsWith('@')) return ref
  const sep = ref.indexOf('@')
  if (sep === -1) return `${alias}@${ref}`
  const colon = ref.indexOf(':')
  const paren = ref.indexOf('(')
  if ((colon === -1 || sep < colon) && (paren === -1 || sep < paren)) return ref
  return `${alias}@${ref}`
}
