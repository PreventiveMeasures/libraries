// What a dependency asks for, read as npm-package-arg 13 reads a spec for
// Arborist, in its order: a path, an `npm:` alias, a repository on a host
// it knows, a URL, a path again, and the registry. A spec it reads
// otherwise, or not at all, is refused, as npm then holds nothing to be what
// it asks for. Paths come back from the lockfile's directory, as `from` is.

import { LockfileError, attempt, quote } from '../error.js'
import { checkName, resolvePath } from '../names.js'
import { fromHostedUrl } from './hosted.js'

// npm-package-arg's, whose case-insensitive [a-z] is ASCII alone, where
// a Unicode one would take the long s and the Kelvin sign too.
const URL_SPEC = /^(?:[Gg][Ii][Tt]\+)?[A-Za-z]+:/u
const SCP = /^[^@]+@[^.:]+\.[^:]+:.+$/iu
const FILE_TYPE = /\.(?:tgz|tar\.gz|tar)$/iu

// Whether npm takes a `file:` path for a tarball, or for a directory.
export const isTarball = (path) => FILE_TYPE.test(path)

// The protocols npm-package-arg reads as git's: not `git+file:`, nor any
// other, which npm reads as no repository.
export const GIT_PROTOCOL = /^git(?:\+(?:https?|rsync|ftp|ssh))?:/u

const unread = (spec, why) => new LockfileError(`${quote(spec)} is ${why}`)

// A path as fromFile takes it, its `.` and `..` resolved as a URL resolves
// them, from `from`; one from the root, a drive or the home directory is
// not the lockfile's to hold.
function fromFile(spec, from) {
  const type = FILE_TYPE.test(spec) ? 'file' : 'directory'
  if (/^file:/iu.test(spec) && !spec.startsWith('file:')) throw unread(spec, 'a path whose "file:" npm reads in another case otherwise')
  const path = spec.startsWith('file:') ? spec.slice(5) : spec
  if (/^(?:[/~]|[A-Za-z]:)/u.test(path)) throw unread(spec, 'a path from the root, a drive or the home directory, which a lockfile does not hold')
  return { type, path: resolvePath(from, path) }
}

// setGitAttrs: a committish, a `semver:` range, a `path:` in the
// repository, any two of them a `::` apart.
function gitAttributes(spec, committish) {
  const git = { committish: null, range: null }
  for (const part of committish ? committish.split('::') : []) {
    const [name, value] = part.includes(':') ? part.split(':') : [undefined, part]
    if (name === 'path') throw unread(spec, 'a subdirectory of a repository, which is not supported')
    if (name !== undefined && name !== 'semver') throw unread(spec, `a git spec with ${quote(name)}, which npm passes over`)
    if (git.committish !== null || git.range !== null) throw unread(spec, 'a git spec with two refs or ranges, which npm refuses')
    if (name === undefined) git.committish = value
    else git.range = decodeComponent(spec, value)
  }
  return git
}

const decodeComponent = (spec, value) => attempt(() => decodeURIComponent(value), () => {
  throw unread(spec, 'a git spec npm cannot decode')
})

// fromURL: a repository by its URL, the fetchSpec npm compares two by, or
// a tarball by its own. An scp-style `git+ssh://user@host:path` is no URL,
// which npm looks for only after `git+ssh:` in lower case.
function fromUrl(spec) {
  const scp = spec.startsWith('git+ssh:') ? /^git\+ssh:\/\/([^:#]+:[^#]+(?:\.git)?)(?:#(.*))?$/iu.exec(spec) : null
  if (scp !== null && !/:\d+(?:\/|$)/u.test(scp[1])) return { type: 'git', hosted: undefined, fetchSpec: scp[1], ...gitAttributes(spec, scp[2]) }
  const url = URL.parse(spec)
  if (url === null) throw unread(spec, 'not a URL npm reads')
  if (url.protocol === 'http:' || url.protocol === 'https:') return { type: 'remote', url: spec }
  if (!GIT_PROTOCOL.test(url.protocol)) throw unread(spec, `of a protocol npm does not read, ${quote(url.protocol)}`)
  const attributes = gitAttributes(spec, url.hash.slice(1))
  url.hash = ''
  return { type: 'git', hosted: undefined, fetchSpec: url.href.replace(/^git\+/u, ''), ...attributes }
}

// fromRegistry: the spec trimmed, a version, a range or else a tag, which
// semver tells apart, where it is given; a tag is held to what a URL
// takes as it is.
function fromRegistry(name, spec, semver) {
  const fetchSpec = spec.trim()
  if (semver === undefined) return { type: 'registry', name, fetchSpec, kind: undefined }
  let kind = 'tag'
  if (semver.valid(fetchSpec, true) !== null) kind = 'version'
  else if (semver.validRange(fetchSpec, true) !== null) kind = 'range'
  if (kind === 'tag' && encodeURIComponent(fetchSpec) !== fetchSpec) throw unread(spec, 'a tag npm refuses, of a character a URL escapes')
  return { type: 'registry', name, fetchSpec, kind }
}

function resolve(name, spec, from, semver) {
  if (/^(?:file:|[.]|~\/|\/|[A-Za-z]:)/iu.test(spec)) return fromFile(spec, from)
  if (/^npm:/iu.test(spec)) return fromAlias(spec, from, semver)
  const hosted = fromHostedUrl(spec)
  if (hosted !== undefined) return { type: 'git', hosted, fetchSpec: undefined, ...gitAttributes(spec, hosted.committish) }
  if (URL_SPEC.test(spec)) return fromUrl(spec)
  if (spec.includes('/') || FILE_TYPE.test(spec)) return fromFile(spec, from)
  return fromRegistry(name, spec, semver)
}

// npa(arg): an argument that names its package first, `q@1.5.1`, or one
// that is a spec alone.
function fromArgument(arg, from, semver) {
  const sep = arg.indexOf('@', 1)
  const name = sep > 0 ? arg.slice(0, sep) : arg
  if (URL_SPEC.test(arg)) return resolve(undefined, arg, from, semver)
  if (SCP.test(arg)) return resolve(undefined, `git+ssh://${arg}`, from, semver)
  if (!name.startsWith('@') && (name.includes('/') || FILE_TYPE.test(name))) return resolve(undefined, arg, from, semver)
  return resolve(checkName(name, undefined), sep > 0 ? arg.slice(sep + 1) || '*' : '*', from, semver)
}

// An alias is for a package of the registry, by name.
function fromAlias(spec, from, semver) {
  const sub = fromArgument(spec.slice(4), from, semver)
  if (sub.type === 'alias') throw unread(spec, 'an alias of an alias, which npm refuses')
  if (sub.type !== 'registry' || sub.name === undefined) throw unread(spec, 'an alias of no package of the registry, which npm refuses')
  return { type: 'alias', sub }
}

// The spec a dependency on `name` of the package at `from` gives, `''` read
// as `*`; by `semver`, where given, which kind of spec of the registry it
// is. A LockfileError, with no place, where npm reads none.
export const readSpec = (name, spec, from, semver) => resolve(name, spec || '*', from, semver)

// A resolved URL, as npm reads one to compare with a spec: a repository
// or a tarball.
export const readResolved = (resolved) => resolve(undefined, resolved, '.', undefined)
