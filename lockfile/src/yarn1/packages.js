// Entries into packages: one object under all patterns of an entry, as in yarn.

import { toBase64 } from '@exodus/bytes/base64.js'
import { fromHex } from '@exodus/bytes/hex.js'
import { LockfileError, at, quote } from '../error.js'
import { checkOptional } from '../graph.js'
import { checkName, checkRegistryTarball, checkRelative, checkRepo, checkVersion, isCommit, isHexSha1, isHttpUrl, readIntegrities, resolvePath } from '../names.js'
import { entries, field, orEmpty, record, string, text } from '../shape.js'

const FIELDS = ['name', 'version', 'uid', 'resolved', 'integrity', 'dependencies', 'optionalDependencies']

// As yarn's normalizePattern splits it. A bare name, which yarn writes for
// none, it reads for the root's own request of it, whatever the range.
function splitPattern(pattern, where) {
  const sep = pattern.indexOf('@', 1)
  if (sep === -1) throw new LockfileError(`${quote(pattern)} is not a pattern of the form name@range`, where)
  return { name: checkName(pattern.slice(0, sep), where), range: pattern.slice(sep + 1) }
}

// What an `npm:` alias asks for, split as a pattern is; its name unchecked.
function aliasOf(range) {
  if (!range.startsWith('npm:')) return undefined
  const target = range.slice(4)
  const sep = target.indexOf('@', 1)
  return sep === -1 ? { name: target, range: '' } : { name: target.slice(0, sep), range: target.slice(sep + 1) }
}

const GIT_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.com', 'bitbucket.org'])

// yarn's GitResolver.isVersion, on a range or on what an entry resolved to.
function isGit(url) {
  if (/^(?:git:|git\+.+:|ssh:|https?:.+\.git(?:$|#.))/u.test(url)) return true
  const parsed = URL.parse(url)
  return parsed !== null && GIT_HOSTS.has(parsed.hostname) && `${parsed.pathname}${parsed.search}`.split('/').filter(Boolean).length === 2
}

// The resolver yarn's getExoticResolver picks for a range, in its order; a
// version, range, tag or `npm:` alias goes to the registry.
const SHORTHAND = /^[^:@%/\s.-][^:@%/\s]*\/[^:@\s/%][^:@\s/%#]*(?:#.*)?$/u
export function sourceOf(range) {
  if (isGit(range)) return 'git'
  if (/^https?:\/\//u.test(range) || (!range.includes('@') && /\.(?:tgz|tar\.gz)$/u.test(range))) return 'tarball'
  if (range.startsWith('github:') || SHORTHAND.test(range)) return 'github'
  if (/^(?:file:|\.{1,2}\/|\/)/u.test(range)) return 'file'
  return /^(link|gitlab|gist|bitbucket):/u.exec(range)?.[1] ?? 'registry'
}

// yarn's hosted git resolvers fetch a commit's tarball over HTTP, or else the
// repository by ssh; the tarball's URL around the commit.
const HOSTED = {
  github: { host: 'github.com', archive: (path) => [`https://codeload.github.com/${path}/tar.gz/`, ''] },
  gitlab: { host: 'gitlab.com', archive: (path) => [`https://gitlab.com/${path}/repository/archive.tar.gz?ref=`, ''] },
  bitbucket: { host: 'bitbucket.org', archive: (path) => [`https://bitbucket.org/${path}/get/`, '.tar.gz'] },
}

// yarn's explodeHostedGitFragment: `user/repo`, the last two segments.
function hostedPath(range) {
  const parts = range.split('@')
  const fragment = parts.length > 2 ? `${parts[1]}@${parts[2]}` : range
  const segments = fragment.replace(/#.*/u, '').replace(/^.*:/u, '').replace(/.git$/u, '').split('/')
  return segments.length < 2 ? undefined : segments.slice(-2).join('/')
}

// The directory a `file:` or `link:` range names, from the lockfile's.
function directory(range) {
  const path = range.replace(/^(?:file|link):/u, '')
  return path.startsWith('/') ? `/${path.split('/').filter((segment) => segment !== '' && segment !== '.').join('/')}` : resolvePath('.', path)
}

// yarn cleans a version before it writes one: SemVer 2.0.0, which semver.valid
// reads too, with no `v` or space around it. A manifest's it cleans loosely.
function readVersion(value, where, semver) {
  const version = checkVersion(value, where)
  if (semver !== undefined && semver.valid(version) === null) throw new LockfileError(`${quote(version)} is not a version semver reads`, where)
  return version
}

// yarn writes a `file:` path as the manifest does, `./` and all; since
// 1.19.0, it checks both the sha1 after `#` and the integrity.
function readTarball(tarball, sha1, integrity, resolvedAt, integrityAt) {
  if (tarball.startsWith('file:')) checkRelative(tarball.slice(tarball.startsWith('file:./') ? 7 : 5), resolvedAt)
  else if (/\s/u.test(tarball) || !isHttpUrl(tarball)) throw new LockfileError(`${quote(tarball)} is not an http(s) URL, a file: path or a git URL`, resolvedAt)
  if (sha1 !== undefined && !isHexSha1(sha1)) throw new LockfileError(`${quote(sha1)} is not the hex sha1 of a tarball`, resolvedAt)
  const part = integrity === undefined ? undefined : readIntegrities(integrity, integrityAt).get('sha1')
  if (sha1 !== undefined && part !== undefined && part.slice(5) !== toBase64(fromHex(sha1))) {
    throw new LockfileError(`${quote(part)} is not the sha1 after the "#" of resolved`, integrityAt)
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
  if (!isGit(url)) return readTarball(url, hash, fields.integrity, resolvedAt, integrityAt)
  if (fields.integrity !== undefined) throw new LockfileError('an integrity, which yarn does not check for a git repository', integrityAt)
  if (hash === undefined || !isCommit(hash)) throw new LockfileError(`expected a full commit hash after the "#" of ${quote(url)}`, resolvedAt)
  return { type: 'git', repo: checkRepo(url, resolvedAt), commit: hash }
}

// One string for each source, `file:./x` and `file:x` alike.
function fetchedFrom(resolution) {
  if (resolution === undefined) return undefined
  return resolution.type === 'git' ? `${resolution.repo}#${resolution.commit}` : resolution.tarball.replace(/^file:\.\//u, 'file:')
}

const describe = (resolution) => (resolution === undefined ? 'nothing, as for a directory' : resolution.type === 'git' ? 'a git repository' : 'a file: tarball')

// yarn 1.22.21 and earlier merge a tarball's patterns whatever their names and
// install it under one alone, writing `name`; yarn 1.22.22 writes no `name`.
function checkNames(patterns, fields, where) {
  const [first] = patterns
  const other = patterns.find((pattern) => pattern.name !== first.name)
  if (other !== undefined) throw new LockfileError(`${quote(first.key)} and ${quote(other.key)} give it two names, of which yarn installs it under one alone`, where)
  if (fields.name !== undefined) {
    const name = string(fields.name, at(where, 'name'))
    const detail = name === first.name ? 'the name its patterns give, which yarn does not write' : `yarn installs this as ${quote(name)}, and leaves ${quote(first.name)} out, which its patterns ask for`
    throw new LockfileError(detail, at(where, 'name'))
  }
  const registry = patterns.filter((pattern) => pattern.source === 'registry').map(({ key, name, alias }) => [key, alias === undefined ? name : checkName(alias.name, where)])
  const two = registry.find(([, name]) => name !== registry[0][1])
  if (two !== undefined) throw new LockfileError(`${quote(registry[0][0])} and ${quote(two[0])} ask for two packages, ${quote(registry[0][1])} and ${quote(two[1])}`, where)
  return registry[0]?.[1]
}

// Whether a pattern that names a source resolves from it, as yarn writes:
// a tarball, a repository at a commit, or nothing for a directory.
function resolvesFrom({ range, source }, resolution) {
  const url = range.split('#')[0]
  if (source === 'file' || source === 'link') return resolution === undefined
  if (source === 'tarball') return resolution?.tarball === url
  if (source === 'git') return resolution?.repo === url
  if (source === 'gist') return resolution?.repo === `https://gist.github.com/${url.slice(5)}.git`
  const { host, archive } = HOSTED[source]
  const path = hostedPath(range)
  if (path === undefined || resolution === undefined) return false
  if (resolution.type === 'git') return resolution.repo === `git+ssh://git@${host}/${path}.git`
  const [prefix, suffix] = archive(path)
  const { tarball } = resolution
  return tarball.startsWith(prefix) && tarball.endsWith(suffix) && isCommit(tarball.slice(prefix.length, tarball.length - suffix.length))
}

// yarn gives the `file:` patterns of a name and directory one entry, and a
// `link:` its own.
function checkDirectories(patterns, where) {
  const [first, ...rest] = patterns.filter((pattern) => pattern.source === 'file' || pattern.source === 'link')
  const other = rest.find((pattern) => first.source === 'link' || pattern.source === 'link' || directory(pattern.range) !== directory(first.range))
  if (other !== undefined) throw new LockfileError(`${quote(first.key)} and ${quote(other.key)} share an entry, where yarn writes one for each`, where)
}

// Registry patterns are given a tarball from a URL. An entry that has them
// beside patterns that name a source goes back, for a resolution to explain.
function checkSources(patterns, resolution, { asks, version }, where) {
  const sources = patterns.filter((pattern) => pattern.source !== 'registry')
  const strayed = sources.find((pattern) => !resolvesFrom(pattern, resolution))
  if (strayed !== undefined) throw new LockfileError(`${quote(strayed.key)} resolves to another source than it names`, at(where, 'resolved'))
  checkDirectories(patterns, where)
  const registry = patterns.find((pattern) => pattern.source === 'registry')
  const hashed = sources.length === 0 || sources.some((pattern) => pattern.source === 'tarball')
  if (hashed && resolution?.type === 'tarball' && resolution.sha1 === undefined && resolution.integrity === undefined) {
    throw new LockfileError('a tarball with no hash, neither a sha1 after "#" nor an integrity, where yarn writes the sha1', at(where, 'resolved'))
  }
  if (registry === undefined) return undefined
  if (sources.length > 0) return { registry: registry.key, sources: sources.map((pattern) => pattern.key) }
  // What a resolution to a workspace gives a request, written apart.
  if (resolution === undefined && patterns.length === 1) return { registry: registry.key, sources: [] }
  if (resolution?.type !== 'tarball' || resolution.tarball.startsWith('file:')) {
    throw new LockfileError(`${quote(registry.key)} asks for the registry, and resolves to ${describe(resolution)}`, where)
  }
  checkRegistryTarball(resolution.tarball, asks, version, at(where, 'resolved'))
  return undefined
}

// A request: a dependency of an entry, its pattern, and where it is listed.
function readDependencies(value, where, requests) {
  const dependencies = Object.create(null)
  for (const [name, range, here] of entries(orEmpty(value), where)) {
    const pattern = `${checkName(name, here)}@${string(range, here)}`
    dependencies[name] = pattern
    requests.push({ targets: dependencies, name, range, pattern, where: here })
  }
  return dependencies
}

function readPackage({ keys, fields }, where, semver) {
  record(fields, where, FIELDS)
  const patterns = keys.map((key) => {
    const { name, range } = splitPattern(key, at('', key))
    return { key, name, range, source: sourceOf(range), alias: aliasOf(range) }
  })
  const asks = checkNames(patterns, fields, where)
  const version = readVersion(fields.version, at(where, 'version'), semver)
  const resolution = readResolution(fields, where)
  const handed = checkSources(patterns, resolution, { asks, version }, where)
  const requests = []
  const dependencies = readDependencies(fields.dependencies, at(where, 'dependencies'), requests)
  const optionalDependencies = readDependencies(fields.optionalDependencies, at(where, 'optionalDependencies'), requests)
  checkOptional(dependencies, optionalDependencies, where)
  const uid = field(fields, 'uid', where, string)
  if (uid === version) throw new LockfileError('the version, which yarn does not write as a uid', at(where, 'uid'))
  const pkg = { patterns: keys, name: patterns[0].name, version, uid, resolution, dependencies, optionalDependencies }
  return { pkg, patterns, handed, requests }
}

// yarn gives a registry pattern of a range the first package of its name and
// version it resolves, of whichever entry. Without semver, a tag is a guess.
const TAG = /^(?![vV=]?\d|[xX*](?:\.|$))[A-Za-z][\w.-]*$/u
export function isRange(range, semver) {
  if (semver !== undefined) return semver.validRange(range) !== null
  return !/[:/@#]/u.test(range) && !TAG.test(range)
}

function checkRace(pkg, patterns, prior, semver, where) {
  const ranged = (pattern) => pattern.source === 'registry' && isRange(pattern.range, semver)
  const asking = patterns.find(ranged) ?? prior.patterns.find(ranged)
  if (asking !== undefined) throw new LockfileError(`is ${pkg.name} ${pkg.version}, as ${quote(prior.key)} is, and yarn gives ${quote(asking.key)} whichever it resolves first`, where)
}

const integrities = ({ integrity }) => (integrity === undefined ? new Map() : readIntegrities(integrity))

// A dependency list, in no order.
const listed = (dependencies) => JSON.stringify(Object.entries(dependencies).sort(([a], [b]) => (a < b ? -1 : 1)))

export function checkLists(pkg, other, of, where) {
  for (const kind of ['dependencies', 'optionalDependencies']) {
    if (listed(pkg[kind]) !== listed(other[kind])) throw new LockfileError(`other ${kind} ${of}`, at(where, kind))
  }
}

// One tarball, or one commit, is one package: of one version, manifest and
// the same hashes, whatever entry has it.
function checkSame(pkg, other, where) {
  const of = `than ${quote(other.patterns[0])}, of the same ${pkg.resolution.type === 'git' ? 'commit' : 'tarball'}`
  if (pkg.version !== other.version) throw new LockfileError(`another version ${of}`, at(where, 'version'))
  checkLists(pkg, other, of, where)
  const [mine, theirs] = [pkg.resolution, other.resolution]
  if (mine.sha1 !== undefined && theirs.sha1 !== undefined && mine.sha1 !== theirs.sha1) throw new LockfileError(`another sha1 ${of}`, at(where, 'resolved'))
  const known = integrities(theirs)
  for (const [algorithm, part] of integrities(mine)) {
    if (known.has(algorithm) && known.get(algorithm) !== part) throw new LockfileError(`another ${algorithm} integrity ${of}`, at(where, 'integrity'))
  }
}

// `mixed`: entries with a registry pattern beside a source, or none, and
// `other`, one of the same source. yarn writes one for each `resolved`.
export function readPackages(list, semver) {
  const packages = Object.create(null)
  const patterns = []
  const requests = []
  const mixed = []
  const merged = new Map()
  const fetched = new Map()
  const versions = new Map()
  for (const entry of list) {
    const [key] = entry.keys
    const where = at('', key)
    const read = readPackage(entry, where, semver)
    const { pkg } = read
    for (const pattern of entry.keys) packages[pattern] = pkg
    patterns.push(...read.patterns)
    requests.push(...read.requests)
    if (read.handed !== undefined) mixed.push({ pkg, ...read.handed })
    const dir = read.patterns.find((pattern) => pattern.source === 'file')
    const one = entry.fields.resolved ?? (dir === undefined ? undefined : `\n${directory(dir.range)}`)
    const same = one === undefined ? undefined : `${pkg.name}\n${one}`
    if (merged.has(same)) throw new LockfileError(`resolves as ${quote(merged.get(same))} does, which yarn writes as one entry`, where)
    if (same !== undefined) merged.set(same, key)
    const source = fetchedFrom(pkg.resolution)
    if (source !== undefined) {
      const group = fetched.get(source) ?? fetched.set(source, []).get(source)
      if (group.length > 0) checkSame(pkg, group[0], where)
      group.push(pkg)
    }
    // yarn resolves no request to what stands in for a workspace.
    if (read.handed?.sources.length === 0) continue
    const id = `${pkg.name}\n${pkg.version}`
    const prior = versions.get(id)
    if (prior === undefined) versions.set(id, { key, patterns: read.patterns })
    else checkRace(pkg, read.patterns, prior, semver, where)
  }
  for (const item of mixed) item.other = fetched.get(fetchedFrom(item.pkg.resolution))?.find((pkg) => pkg !== item.pkg)
  return { packages, patterns, requests, mixed }
}
