// The packages of a yarn.lock: one for each entry, under every pattern it
// lists, and the same object under each, as yarn itself reads them. A
// pattern is a dependency as a manifest asks for it, `name@range`; the
// entry is what that resolved to, and a package's own dependencies lead on
// to the entries of their patterns.
//
// An entry is held to what yarn installs as it says. yarn 1.22.21 and
// earlier write one entry for every pattern of one tarball, whatever its
// name: `"string-width-cjs@npm:string-width@^4.2.0", string-width@^4.2.0`.
// yarn then gives the entry the name of the first pattern it looks up, in
// an order its network decides, and installs the package under that name
// alone; writing the lockfile again records it as `name`, and from then on
// every install leaves the other name out. So an entry of two names, or
// with a `name` its patterns do not give, is refused. So is an entry that
// gives a pattern asking for the registry what another pattern names, a
// tarball, a directory or a repository, as yarn does for a resolution or a
// dependency that names one with the same name and version: the package
// asked for is not the one installed.

import { LockfileError, at, quote } from '../error.js'
import { checkIntegrity, checkName, checkRelative, checkVersion } from '../names.js'
import { EMPTY, entries, record, string, text } from '../shape.js'

const FIELDS = ['name', 'version', 'uid', 'resolved', 'integrity', 'dependencies', 'optionalDependencies']

// yarn's normalizePattern: the name runs to the first `@` past a scope's.
function splitPattern(pattern, where) {
  const sep = pattern.indexOf('@', 1)
  if (sep === -1) throw new LockfileError(`${quote(pattern)} is not a pattern of the form name@range`, where)
  return { name: checkName(pattern.slice(0, sep), where), range: pattern.slice(sep + 1) }
}

// A range that asks the registry: a version, a range or a tag, or `npm:`
// and a name and one of those. Any other names where the package comes
// from: a URL, `file:`, `link:` or a path, a git host's `user/repo`.
const fromRegistry = (range) => range.startsWith('npm:') || !/[:/]/u.test(range)

// yarn's test for a git URL, which it fetches with git whatever the pattern.
const GIT = /^git(?:\+[\da-z]+)?:\/\//u
const COMMIT = /^(?:[\da-f]{40}|[\da-f]{64})$/u
const SHA1 = /^[\da-f]{40}$/u

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

// A sha1 in hex as an integrity writes it, in padded base64.
function hexToBase64(hex) {
  let out = ''
  for (let i = 0; i < hex.length; i += 3) {
    const group = Number.parseInt(hex.slice(i, i + 3).padEnd(3, '0'), 16)
    out += BASE64[group >> 6] + (i + 2 < hex.length ? BASE64[group & 63] : '')
  }
  return out.padEnd(Math.ceil(out.length / 4) * 4, '=')
}

// A tarball is fetched from an http(s) URL, or read from `file:` and a path
// from the lockfile's directory, which yarn writes as the manifest does,
// `./` and all. After a `#` is the hex sha1 of the tarball, which yarn
// checks where there is no integrity; a sha1 integrity names it again.
function readTarball(tarball, sha1, integrity, where) {
  const resolved = at(where, 'resolved')
  const path = tarball.slice(5)
  if (tarball.startsWith('file:')) checkRelative(path.startsWith('./') ? path.slice(2) : path, resolved)
  else if (!/^https?:\/\//u.test(tarball) || !URL.canParse(tarball)) throw new LockfileError(`${quote(tarball)} is not an http(s) URL, a file: path or a git URL`, resolved)
  if (sha1 !== undefined && !SHA1.test(sha1)) throw new LockfileError(`${quote(sha1)} is not the hex sha1 of a tarball`, resolved)
  const integrityAt = at(where, 'integrity')
  for (const part of integrity === undefined ? [] : text(integrity, integrityAt).split(' ')) {
    checkIntegrity(part, integrityAt)
    if (sha1 !== undefined && part.startsWith('sha1-') && part.slice(5) !== hexToBase64(sha1)) {
      throw new LockfileError(`${quote(part)} is not the sha1 after the "#" of resolved`, integrityAt)
    }
  }
  return { type: 'tarball', tarball, sha1, integrity }
}

// Where the package's files come from, as `resolved` says; undefined where
// yarn writes none, for a directory, which it reads again at every install.
function readResolution(fields, where) {
  if (fields.resolved === undefined) {
    if (fields.integrity !== undefined) throw new LockfileError('an integrity, with nothing resolved', at(where, 'integrity'))
    return undefined
  }
  const [url, hash, ...rest] = text(fields.resolved, at(where, 'resolved')).split('#')
  if (rest.length > 0) throw new LockfileError('more than one "#", of which yarn reads the first alone', at(where, 'resolved'))
  if (!GIT.test(url)) return readTarball(url, hash, fields.integrity, where)
  if (fields.integrity !== undefined) throw new LockfileError('an integrity, which yarn does not check for a git repository', at(where, 'integrity'))
  if (hash === undefined || !COMMIT.test(hash)) throw new LockfileError(`expected a full commit hash after the "#" of ${quote(url)}`, at(where, 'resolved'))
  if (/[\s\p{Cc}]/u.test(url)) throw new LockfileError(`${quote(url)} is not a repository URL`, at(where, 'resolved'))
  return { type: 'git', repo: url, commit: hash }
}

// What a resolution is, for a message.
const sourceOf = (resolution) => (resolution === undefined ? 'nothing, as for a directory' : resolution.type === 'git' ? 'a git repository' : 'a file: tarball')

// Every pattern of an entry gives it one name, and those that ask for the
// registry are given a tarball from a URL, by no pattern that names one.
function checkPatterns(patterns, fields, resolution, where) {
  const [first] = patterns
  for (const pattern of patterns) {
    if (pattern.name !== first.name) {
      throw new LockfileError(`${quote(first.key)} and ${quote(pattern.key)} give it two names, of which yarn installs it under one alone`, where)
    }
  }
  if (fields.name !== undefined && string(fields.name, at(where, 'name')) !== first.name) {
    throw new LockfileError(`yarn installs this as ${quote(fields.name)}, and leaves ${quote(first.name)} out, which its patterns ask for`, at(where, 'name'))
  }
  const registry = patterns.find((pattern) => fromRegistry(pattern.range))
  const source = patterns.find((pattern) => !fromRegistry(pattern.range))
  if (registry === undefined) return
  if (source !== undefined) throw new LockfileError(`${quote(registry.key)} asks for the registry, and is given what ${quote(source.key)} names`, where)
  if (resolution?.type !== 'tarball' || resolution.tarball.startsWith('file:')) {
    throw new LockfileError(`${quote(registry.key)} asks for the registry, and resolves to ${sourceOf(resolution)}`, where)
  }
}

// By name, the pattern of each dependency, to be found among the keys.
function readDependencies(value, where, wanted) {
  const dependencies = Object.create(null)
  for (const [name, range, here] of entries(value ?? EMPTY, where)) {
    const pattern = `${checkName(name, here)}@${string(range, here)}`
    dependencies[name] = pattern
    wanted.push([pattern, here])
  }
  return dependencies
}

function readPackage({ keys, fields }, wanted) {
  const where = at('', keys[0])
  record(fields, where, FIELDS)
  const patterns = keys.map((key) => ({ key, ...splitPattern(key, at('', key)) }))
  const resolution = readResolution(fields, where)
  checkPatterns(patterns, fields, resolution, where)
  const dependencies = readDependencies(fields.dependencies, at(where, 'dependencies'), wanted)
  const optionalDependencies = readDependencies(fields.optionalDependencies, at(where, 'optionalDependencies'), wanted)
  for (const name of Object.keys(optionalDependencies)) {
    if (name in dependencies) throw new LockfileError('listed under dependencies too', at(at(where, 'optionalDependencies'), name))
  }
  return {
    patterns: keys,
    name: patterns[0].name,
    version: checkVersion(fields.version, at(where, 'version')),
    uid: fields.uid === undefined ? undefined : string(fields.uid, at(where, 'uid')),
    resolution,
    dependencies,
    optionalDependencies,
  }
}

// By pattern, in the order of the file, from what syntax.js reads.
export function readPackages(list) {
  const packages = Object.create(null)
  const wanted = []
  for (const entry of list) {
    const pkg = readPackage(entry, wanted)
    for (const key of entry.keys) packages[key] = pkg
  }
  for (const [pattern, where] of wanted) {
    if (!(pattern in packages)) throw new LockfileError(`${quote(pattern)} is not a pattern of the lockfile`, where)
  }
  return packages
}
