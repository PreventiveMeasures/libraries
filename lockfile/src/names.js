// What a name, a version, a path and an integrity have to look like. Each
// is held to the form the lockfiles write and no looser one, so a value
// read here means one thing to every reader downstream.

import { fromBase64 } from '@exodus/bytes/base64.js'
import { LockfileError, quote } from './error.js'
import { checkerOf, text } from './shape.js'

const checker = checkerOf(text)

// npm's rule for a name, scoped or not, less the `~'!()*` that npm stopped
// taking in new names: parentheses in particular would read as the start of
// a peer suffix in a pnpm key. Capitals stay, since old names have them.
// No name starts with `.` or `_`, so none is `..` or `__proto__`. ASCII
// alone, as npm takes: a case-insensitive Unicode class would take `ſ` for
// `s` and the Kelvin sign for `k`, and the second is `K` to a file system
// that normalizes names.
const NAME = /^(?:@[\dA-Za-z~-][\w.~-]*\/)?[\dA-Za-z~-][\w.~-]*$/u

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

export const checkVersion = checker(isVersion, 'a version')

// A path from one directory to another as pnpm writes it: `/` between
// segments, `..` only at the start, no `.` or empty segment, or `.` alone
// for the directory itself. Nothing absolute, including a drive letter, and
// no backslash, which is a separator on Windows; no control or
// bidirectional character either.
const UNSAFE = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}\\]/u

// One directory's or file's name in such a path.
export const isSegment = (segment) => segment !== '' && segment !== '.' && segment !== '..' && !UNSAFE.test(segment)

export function checkRelative(value, where) {
  const path = text(value, where)
  if (path === '.') return path
  let climbing = true
  for (const segment of path.split('/')) {
    if (segment === '..' && climbing) continue
    climbing = false
    if (!isSegment(segment)) {
      throw new LockfileError(`${quote(path)} is not a relative path in normal form`, where)
    }
  }
  if (/^[A-Za-z]:/u.test(path)) throw new LockfileError(`${quote(path)} starts with a drive letter`, where)
  return path
}

// A path within a directory, a subdirectory of an archive or a repository
// above all: one as above that never climbs out of it, whatever reads it
// joins it to.
export function checkWithin(value, where) {
  const path = checkRelative(value, where)
  if (path === '..' || path.startsWith('../')) throw new LockfileError(`${quote(path)} climbs out of the directory it is in`, where)
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

// A path as a package manager reads one from `base`: no empty or `.`
// segment, its `..` resolved.
export const resolvePath = (base, path) => joinRelative(base, path.split('/').filter((segment) => segment !== '' && segment !== '.').join('/') || '.')

// `path`, relative to what `base` is relative to, as a path from `base`;
// neither leaves the directory they are relative to.
export function relativeTo(base, path) {
  const from = base === '.' ? [] : base.split('/')
  const to = path === '.' ? [] : path.split('/')
  let common = 0
  while (common < from.length && common < to.length && from[common] === to[common]) common++
  return [...from.slice(common).map(() => '..'), ...to.slice(common)].join('/') || '.'
}

export const isCommit = (hash) => /^(?:[\da-f]{40}|[\da-f]{64})$/u.test(hash)

// A sha256 in lowercase hex, as Cargo.lock and soldeer.lock write a checksum.
export const isHexSha256 = (value) => /^[\da-f]{64}$/u.test(value)

// A branch or tag name, as git check-ref-format takes one under refs/heads/
// or refs/tags/: a rule for each alternative. A leading `-` git branch
// refuses, and git checkout reads as an option.
const BAD_REF = /^$|^@$|^-|[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control} ~^:?*[\\]|\.\.|@\{|^\/|\/$|\/\/|(?:^|\/)\.|\.lock(?:\/|$)|\.$/u

export const checkRefName = checker((ref) => !BAD_REF.test(ref), 'a branch or tag name git takes')

// A `-` that leads a repository, the user before its host or the host, which
// git, or the ssh it runs, would read as an option where it does not refuse
// one first: `-oProxyCommand=…` runs a command.
const AS_OPTION = /^(?:[^/:]*:\/\/)?(?:[^/@]*@)?-/u
// `transport::address`, which git hands to the remote helper of the name;
// `ext::` runs a command.
const HELPER = /^[\dA-Za-z][\d+.A-Za-z-]*::/u

// A repository's URL, or scp's `user@host:path`, as a tool writes the one
// it clones: no space or control, and read by git as a place to fetch from
// and as nothing else.
export function checkRepo(value, where) {
  const repo = text(value, where)
  if (/[\s\p{Cc}]/u.test(repo)) throw new LockfileError(`${quote(repo)} is not a repository URL`, where)
  if (AS_OPTION.test(repo)) throw new LockfileError(`${quote(repo)} has a "-" where git or ssh would read an option`, where)
  if (HELPER.test(repo)) throw new LockfileError(`${quote(repo)} names a remote helper of git's, which is not supported`, where)
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

// Subresource integrity of one hash or more, a space apart, as npm and yarn
// write it, of no algorithm twice: each hash by its algorithm.
export function readIntegrities(value, where) {
  const hashes = new Map()
  for (const part of text(value, where).split(' ')) {
    const algorithm = checkIntegrity(part, where).slice(0, part.indexOf('-'))
    if (hashes.has(algorithm)) throw new LockfileError(`two ${algorithm} integrities`, where)
    hashes.set(algorithm, part)
  }
  return hashes
}

// An http(s) URL that is the URL fetched as it is written: no space or
// control, which the URL parser drops, or trims, where a reader of the
// text would not.
export const isHttpUrl = (value) => /^https?:\/\//u.test(value) && !/[\s\p{Cc}]/u.test(value) && URL.canParse(value)

// npm's registry, by either of its names, and yarn's mirror of it, keep a
// package's tarball under its name, a scope's `/` once written `%2f`, and
// named after its version.
const REGISTRIES = new Set(['registry.npmjs.org', 'registry.npmjs.com', 'registry.yarnpkg.com'])

export function checkRegistryTarball(tarball, name, version, where) {
  const url = new URL(tarball)
  // A host a dot ends is the same host to DNS and to TLS. A run of dots is
  // tried from its start alone, as otherwise in quadratic time.
  const host = url.hostname.replace(/(?<!\.)\.+$/u, '')
  if (REGISTRIES.has(host) && url.pathname.replace(/^(\/@[^/]+)%2f/iu, '$1/') !== `/${name}/-/${name.slice(name.indexOf('/') + 1)}-${version}.tgz`) {
    throw new LockfileError(`${quote(tarball)} is not the registry's tarball of ${name}@${version}`, where)
  }
}
