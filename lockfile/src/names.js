// What a name, a version, a path and an integrity have to look like. Each
// is held to the form the lockfiles write and no looser one, so a value
// read here means one thing to every reader downstream.

import { fromBase64 } from '@exodus/bytes/base64.js'
import { LockfileError, quote } from './error.js'
import { text } from './shape.js'

// npm's rule for a name, scoped or not, less the `~'!()*` that npm stopped
// taking in new names: parentheses in particular would read as the start of
// a peer suffix in a pnpm key. Capitals stay, since old names have them.
// No name starts with `.` or `_`, so none is `..` or `__proto__`.
const NAME = /^(?:@[a-z0-9~-][\w.~-]*\/)?[a-z0-9~-][\w.~-]*$/iu

export const isName = (name) => name.length <= 214 && NAME.test(name)

export function checkName(name, where) {
  if (!isName(name)) throw new LockfileError(`${quote(name)} is not a package name`, where)
  return name
}

// SemVer 2.0.0 exactly, as `semver.valid` reads it and hands it back
// unchanged: no `v` or `=` in front and no spaces around, at most 256
// characters, and no major, minor or patch past 2^53.
const NUMBER = '(0|[1-9]\\d*)'
const PRERELEASE = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][\\dA-Za-z-]*)'
const SEMVER = new RegExp(`^${NUMBER}\\.${NUMBER}\\.${NUMBER}(?:-${PRERELEASE}(?:\\.${PRERELEASE})*)?(?:\\+[\\dA-Za-z-]+(?:\\.[\\dA-Za-z-]+)*)?$`, 'u')

export function isVersion(version) {
  if (version.length > 256) return false
  const m = SEMVER.exec(version)
  return m !== null && m.slice(1, 4).every((part) => Number(part) <= Number.MAX_SAFE_INTEGER)
}

export function checkVersion(value, where) {
  if (!isVersion(text(value, where))) throw new LockfileError(`${quote(value)} is not a version`, where)
  return value
}

// A path from one directory to another as pnpm writes it: `/` between
// segments, `..` only at the start, no `.` or empty segment, or `.` alone
// for the directory itself. Nothing absolute, including a drive letter, and
// no backslash, which is a separator on Windows; no control or
// bidirectional character either.
const UNSAFE = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}\\]/u

export function checkRelative(value, where) {
  const path = text(value, where)
  if (path === '.') return path
  let climbing = true
  for (const segment of path.split('/')) {
    if (segment === '..' && climbing) continue
    climbing = false
    if (segment === '' || segment === '.' || segment === '..' || UNSAFE.test(segment)) {
      throw new LockfileError(`${quote(path)} is not a relative path in normal form`, where)
    }
  }
  if (/^[A-Za-z]:/u.test(path)) throw new LockfileError(`${quote(path)} starts with a drive letter`, where)
  return path
}

// `path`, relative to the directory `base` is, as a path relative to what
// `base` is relative to; both are in the form above, and so is the answer.
export function joinRelative(base, path) {
  const segments = base === '.' ? [] : base.split('/')
  for (const segment of path === '.' ? [] : path.split('/')) {
    if (segment === '..' && segments.length > 0 && segments.at(-1) !== '..') segments.pop()
    else segments.push(segment)
  }
  return segments.length === 0 ? '.' : segments.join('/')
}

export const isCommit = (hash) => /^(?:[\da-f]{40}|[\da-f]{64})$/u.test(hash)

export function checkRepo(value, where) {
  const repo = text(value, where)
  if (/[\s\p{Cc}]/u.test(repo)) throw new LockfileError(`${quote(repo)} is not a repository URL`, where)
  return repo
}

// Subresource integrity with one hash, as pnpm writes it: the algorithm, a
// dash, and the digest of its size in base64, padded, each byte one way.
const DIGEST = { __proto__: null, sha1: 20, sha256: 32, sha384: 48, sha512: 64 }

function digestSize(base64) {
  try {
    return fromBase64(base64, { padding: true }).length
  } catch {
    return undefined
  }
}

export function checkIntegrity(value, where) {
  const integrity = text(value, where)
  const sep = integrity.indexOf('-')
  const size = sep === -1 ? undefined : DIGEST[integrity.slice(0, sep)]
  if (size === undefined || digestSize(integrity.slice(sep + 1)) !== size) {
    throw new LockfileError(`${quote(value)} is not a sha1, sha256, sha384 or sha512 integrity`, where)
  }
  return value
}
