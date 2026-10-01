// Entries into packages: one object under all patterns of an entry, as in yarn.

import { LockfileError, at, quote } from '../error.js'
import { checkIntegrity, checkName, checkRelative, checkVersion } from '../names.js'
import { EMPTY, entries, record, string, text } from '../shape.js'

const FIELDS = ['name', 'version', 'uid', 'resolved', 'integrity', 'dependencies', 'optionalDependencies']

// As yarn's normalizePattern splits it.
function splitPattern(pattern, where) {
  const sep = pattern.indexOf('@', 1)
  if (sep === -1) throw new LockfileError(`${quote(pattern)} is not a pattern of the form name@range`, where)
  return { name: checkName(pattern.slice(0, sep), where), range: pattern.slice(sep + 1) }
}

// A version, range, tag or `npm:` alias; a `:` or `/` names a source instead:
// a URL, a path, `file:`, `link:` or a git host's `user/repo`.
const fromRegistry = (range) => range.startsWith('npm:') || !/[:/]/u.test(range)

// yarn's test: it fetches such a URL with git, whatever the pattern says.
const GIT = /^git(?:\+[\da-z]+)?:\/\//u
const COMMIT = /^(?:[\da-f]{40}|[\da-f]{64})$/u
const SHA1 = /^[\da-f]{40}$/u

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function hexToBase64(hex) {
  let out = ''
  for (let i = 0; i < hex.length; i += 3) {
    const group = Number.parseInt(hex.slice(i, i + 3).padEnd(3, '0'), 16)
    out += BASE64[group >> 6] + (i + 2 < hex.length ? BASE64[group & 63] : '')
  }
  return out.padEnd(Math.ceil(out.length / 4) * 4, '=')
}

// yarn writes a `file:` path as the manifest does, `./` and all; it checks the
// sha1 after `#` where there is no integrity.
function readTarball(tarball, sha1, integrity, resolvedAt, integrityAt) {
  if (tarball.startsWith('file:')) checkRelative(tarball.slice(tarball.startsWith('file:./') ? 7 : 5), resolvedAt)
  else if (!/^https?:\/\//u.test(tarball) || !URL.canParse(tarball)) throw new LockfileError(`${quote(tarball)} is not an http(s) URL, a file: path or a git URL`, resolvedAt)
  if (sha1 !== undefined && !SHA1.test(sha1)) throw new LockfileError(`${quote(sha1)} is not the hex sha1 of a tarball`, resolvedAt)
  for (const part of integrity === undefined ? [] : text(integrity, integrityAt).split(' ')) {
    checkIntegrity(part, integrityAt)
    if (sha1 !== undefined && part.startsWith('sha1-') && part.slice(5) !== hexToBase64(sha1)) {
      throw new LockfileError(`${quote(part)} is not the sha1 after the "#" of resolved`, integrityAt)
    }
  }
  return { type: 'tarball', tarball, sha1, integrity }
}

// Undefined for a directory, which yarn reads again at every install.
function readResolution(fields, where) {
  const resolvedAt = at(where, 'resolved')
  const integrityAt = at(where, 'integrity')
  if (fields.resolved === undefined) {
    if (fields.integrity !== undefined) throw new LockfileError('an integrity, with nothing resolved', integrityAt)
    return undefined
  }
  const [url, hash, ...rest] = text(fields.resolved, resolvedAt).split('#')
  if (rest.length > 0) throw new LockfileError('more than one "#", of which yarn reads the first alone', resolvedAt)
  if (!GIT.test(url)) return readTarball(url, hash, fields.integrity, resolvedAt, integrityAt)
  if (fields.integrity !== undefined) throw new LockfileError('an integrity, which yarn does not check for a git repository', integrityAt)
  if (hash === undefined || !COMMIT.test(hash)) throw new LockfileError(`expected a full commit hash after the "#" of ${quote(url)}`, resolvedAt)
  if (/[\s\p{Cc}]/u.test(url)) throw new LockfileError(`${quote(url)} is not a repository URL`, resolvedAt)
  return { type: 'git', repo: url, commit: hash }
}

const describe = (resolution) => (resolution === undefined ? 'nothing, as for a directory' : resolution.type === 'git' ? 'a git repository' : 'a file: tarball')

// yarn 1.22.21 and earlier merge a tarball's patterns whatever their names and
// install it under one alone. Registry beside source patterns: resolutions.js.
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
  if (registry === undefined) return undefined
  const sources = patterns.filter((pattern) => !fromRegistry(pattern.range)).map((pattern) => pattern.key)
  if (sources.length > 0) return { registry: registry.key, sources }
  if (resolution?.type !== 'tarball' || resolution.tarball.startsWith('file:')) {
    throw new LockfileError(`${quote(registry.key)} asks for the registry, and resolves to ${describe(resolution)}`, where)
  }
  return undefined
}

function readDependencies(value, where, wanted) {
  const dependencies = Object.create(null)
  for (const [name, range, here] of entries(value ?? EMPTY, where)) {
    const pattern = `${checkName(name, here)}@${string(range, here)}`
    dependencies[name] = pattern
    wanted.push([pattern, here])
  }
  return dependencies
}

function readPackage({ keys, fields }, wanted, mixed) {
  const where = at('', keys[0])
  record(fields, where, FIELDS)
  const patterns = keys.map((key) => ({ key, ...splitPattern(key, at('', key)) }))
  const resolution = readResolution(fields, where)
  const handed = checkPatterns(patterns, fields, resolution, where)
  const dependencies = readDependencies(fields.dependencies, at(where, 'dependencies'), wanted)
  const optionalDependencies = readDependencies(fields.optionalDependencies, at(where, 'optionalDependencies'), wanted)
  for (const name of Object.keys(optionalDependencies)) {
    if (name in dependencies) throw new LockfileError('listed under dependencies too', at(at(where, 'optionalDependencies'), name))
  }
  const pkg = {
    patterns: keys,
    name: patterns[0].name,
    version: checkVersion(fields.version, at(where, 'version')),
    uid: fields.uid === undefined ? undefined : string(fields.uid, at(where, 'uid')),
    resolution,
    dependencies,
    optionalDependencies,
  }
  if (handed !== undefined) mixed.push({ pkg, ...handed })
  return pkg
}

// `mixed`: the entries with a registry pattern beside a source.
export function readPackages(list) {
  const packages = Object.create(null)
  const wanted = []
  const mixed = []
  for (const entry of list) {
    const pkg = readPackage(entry, wanted, mixed)
    for (const key of entry.keys) packages[key] = pkg
  }
  for (const [pattern, where] of wanted) {
    if (!(pattern in packages)) throw new LockfileError(`${quote(pattern)} is not a pattern of the lockfile`, where)
  }
  return { packages, mixed }
}
