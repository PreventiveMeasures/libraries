// Entries into packages: one object under all patterns of an entry, as in yarn.

import { LockfileError, at, quote } from '../error.js'
import { checkIntegrity, checkName, checkRelative, checkVersion, joinRelative } from '../names.js'
import { EMPTY, entries, record, string, text } from '../shape.js'

const FIELDS = ['name', 'version', 'uid', 'resolved', 'integrity', 'dependencies', 'optionalDependencies']

// As yarn's normalizePattern splits it.
function splitPattern(pattern, where) {
  const sep = pattern.indexOf('@', 1)
  if (sep === -1) throw new LockfileError(`${quote(pattern)} is not a pattern of the form name@range`, where)
  return { name: checkName(pattern.slice(0, sep), where), range: pattern.slice(sep + 1) }
}

const GIT_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.com', 'bitbucket.org'])

// yarn's GitResolver.isVersion, on a range or on what an entry resolved to.
function isGit(url) {
  if (/^(?:git:|git\+.+:|ssh:|https?:.+\.git(?:$|#.))/u.test(url)) return true
  const parsed = URL.canParse(url) ? new URL(url) : undefined
  return parsed !== undefined && GIT_HOSTS.has(parsed.hostname) && `${parsed.pathname}${parsed.search}`.split('/').filter(Boolean).length === 2
}

// The resolver yarn's getExoticResolver picks for a range, in its order; a
// version, range, tag or `npm:` alias goes to the registry.
const SHORTHAND = /^[^:@%/\s.-][^:@%/\s]*\/[^:@\s/%]+(?:#.*)?$/u
function sourceOf(range) {
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
  const segments = fragment.replace(/#.*/u, '').replace(/.*:/u, '').replace(/.git$/u, '').split('/')
  return segments.length < 2 ? undefined : segments.slice(-2).join('/')
}

// The directory a `file:` or `link:` range names, from the lockfile's.
function directory(range) {
  const path = range.replace(/^(?:file|link):/u, '')
  const segments = path.split('/').filter((segment) => segment !== '' && segment !== '.')
  return path.startsWith('/') ? `/${segments.join('/')}` : joinRelative('.', segments.join('/') || '.')
}

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
  else if (!/^https?:\/\/\S+$/u.test(tarball) || !URL.canParse(tarball)) throw new LockfileError(`${quote(tarball)} is not an http(s) URL, a file: path or a git URL`, resolvedAt)
  if (sha1 !== undefined && !SHA1.test(sha1)) throw new LockfileError(`${quote(sha1)} is not the hex sha1 of a tarball`, resolvedAt)
  const algorithms = new Set()
  for (const part of integrity === undefined ? [] : text(integrity, integrityAt).split(' ')) {
    checkIntegrity(part, integrityAt)
    const algorithm = part.slice(0, part.indexOf('-'))
    if (algorithms.has(algorithm)) throw new LockfileError(`two ${algorithm} integrities`, integrityAt)
    algorithms.add(algorithm)
    if (sha1 !== undefined && algorithm === 'sha1' && part.slice(5) !== hexToBase64(sha1)) {
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
  if (!isGit(url)) return readTarball(url, hash, fields.integrity, resolvedAt, integrityAt)
  if (fields.integrity !== undefined) throw new LockfileError('an integrity, which yarn does not check for a git repository', integrityAt)
  if (hash === undefined || !COMMIT.test(hash)) throw new LockfileError(`expected a full commit hash after the "#" of ${quote(url)}`, resolvedAt)
  if (/[\s\p{Cc}]/u.test(url)) throw new LockfileError(`${quote(url)} is not a repository URL`, resolvedAt)
  return { type: 'git', repo: url, commit: hash }
}

// One string for each source, `file:./x` and `file:x` alike.
export function fetchedFrom(resolution) {
  if (resolution === undefined) return undefined
  return resolution.type === 'git' ? `${resolution.repo}#${resolution.commit}` : resolution.tarball.replace(/^file:\.\//u, 'file:')
}

const describe = (resolution) => (resolution === undefined ? 'nothing, as for a directory' : resolution.type === 'git' ? 'a git repository' : 'a file: tarball')

// The package a registry pattern asks for: an `npm:` alias's, or its own.
function asked({ name, range }, where) {
  if (!range.startsWith('npm:')) return name
  const target = range.slice(4)
  const sep = target.indexOf('@', 1)
  return checkName(sep === -1 ? target : target.slice(0, sep), where)
}

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
  const registry = patterns.filter((pattern) => pattern.source === 'registry').map((pattern) => [pattern.key, asked(pattern, where)])
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
  return tarball.startsWith(prefix) && tarball.endsWith(suffix) && COMMIT.test(tarball.slice(prefix.length, tarball.length - suffix.length))
}

// yarn gives the `file:` patterns of a name and directory one entry, and a
// `link:` its own.
function checkDirectories(patterns, where) {
  const [first, ...rest] = patterns.filter((pattern) => pattern.source === 'file' || pattern.source === 'link')
  const other = rest.find((pattern) => first.source === 'link' || pattern.source === 'link' || directory(pattern.range) !== directory(first.range))
  if (other !== undefined) throw new LockfileError(`${quote(first.key)} and ${quote(other.key)} share an entry, where yarn writes one for each`, where)
}

// npm's registry, and yarn's mirror of it, keep a package's tarball under its
// name, a scope's `/` once written `%2f`, and named after its version.
const REGISTRIES = new Set(['registry.npmjs.org', 'registry.yarnpkg.com'])

function checkRegistry(name, version, { tarball }, where) {
  const url = new URL(tarball)
  if (REGISTRIES.has(url.hostname) && url.pathname.replace(/^(\/@[^/]+)%2f/iu, '$1/') !== `/${name}/-/${name.slice(name.indexOf('/') + 1)}-${version}.tgz`) {
    throw new LockfileError(`${quote(tarball)} is not the registry's tarball of ${name}@${version}`, where)
  }
}

// Registry patterns are given a tarball from a URL. An entry that has them
// beside patterns that name a source goes back, for a resolution to explain.
function checkSources(patterns, resolution, { asks, version }, where) {
  const strayed = patterns.find((pattern) => pattern.source !== 'registry' && !resolvesFrom(pattern, resolution))
  if (strayed !== undefined) throw new LockfileError(`${quote(strayed.key)} resolves to another source than it names`, at(where, 'resolved'))
  checkDirectories(patterns, where)
  const registry = patterns.find((pattern) => pattern.source === 'registry')
  const sources = patterns.filter((pattern) => pattern.source !== 'registry')
  const hashed = sources.length === 0 || sources.some((pattern) => pattern.source === 'tarball')
  if (hashed && resolution?.type === 'tarball' && resolution.sha1 === undefined && resolution.integrity === undefined) {
    throw new LockfileError('a tarball with no hash, neither a sha1 after "#" nor an integrity, where yarn writes the sha1', at(where, 'resolved'))
  }
  if (registry === undefined) return undefined
  if (sources.length > 0) return { registry: registry.key, sources: sources.map((pattern) => pattern.key) }
  if (resolution?.type !== 'tarball' || resolution.tarball.startsWith('file:')) {
    throw new LockfileError(`${quote(registry.key)} asks for the registry, and resolves to ${describe(resolution)}`, where)
  }
  checkRegistry(asks, version, resolution, at(where, 'resolved'))
  return undefined
}

function readDependencies(value, where, wanted) {
  const dependencies = Object.create(null)
  for (const [name, range, here] of entries(value ?? EMPTY, where)) {
    const pattern = `${checkName(name, here)}@${string(range, here)}`
    dependencies[name] = pattern
    wanted.push({ targets: dependencies, name, pattern, where: here })
  }
  return dependencies
}

function readPackage({ keys, fields }, wanted, mixed) {
  const where = at('', keys[0])
  record(fields, where, FIELDS)
  const patterns = keys.map((key) => {
    const pattern = splitPattern(key, at('', key))
    return { key, ...pattern, source: sourceOf(pattern.range) }
  })
  const asks = checkNames(patterns, fields, where)
  const version = checkVersion(fields.version, at(where, 'version'))
  const resolution = readResolution(fields, where)
  const handed = checkSources(patterns, resolution, { asks, version }, where)
  const dependencies = readDependencies(fields.dependencies, at(where, 'dependencies'), wanted)
  const optionalDependencies = readDependencies(fields.optionalDependencies, at(where, 'optionalDependencies'), wanted)
  for (const name of Object.keys(optionalDependencies)) {
    if (name in dependencies) throw new LockfileError('listed under dependencies too', at(at(where, 'optionalDependencies'), name))
  }
  const uid = fields.uid === undefined ? undefined : string(fields.uid, at(where, 'uid'))
  if (uid === version) throw new LockfileError('the version, which yarn does not write as a uid', at(where, 'uid'))
  const pkg = { patterns: keys, name: patterns[0].name, version, uid, resolution, dependencies, optionalDependencies }
  if (handed !== undefined) mixed.push({ pkg, ...handed })
  return [pkg, patterns]
}

// Tags and aliases aside, yarn gives a registry pattern the first package of
// its name and version it resolves, of whichever entry.
const TAG = /^(?![vV=]?\d|[xX*](?:\.|$))[A-Za-z][\w.-]*$/u
const ranged = ({ range, source }) => source === 'registry' && !/[:/@#]/u.test(range) && !TAG.test(range)

const integrities = ({ integrity }) => new Map((integrity?.split(' ') ?? []).map((part) => [part.slice(0, part.indexOf('-')), part]))

// One tarball, or one commit, is one package: of one version and the same
// hashes, whatever entry has it.
function checkSame(pkg, other, where) {
  const of = `than ${quote(other.patterns[0])}, of the same ${pkg.resolution.type === 'git' ? 'commit' : 'tarball'}`
  if (pkg.version !== other.version) throw new LockfileError(`another version ${of}`, at(where, 'version'))
  const [mine, theirs] = [pkg.resolution, other.resolution]
  if (mine.sha1 !== undefined && theirs.sha1 !== undefined && mine.sha1 !== theirs.sha1) throw new LockfileError(`another sha1 ${of}`, at(where, 'resolved'))
  const known = integrities(theirs)
  for (const [algorithm, part] of integrities(mine)) {
    if (known.has(algorithm) && known.get(algorithm) !== part) throw new LockfileError(`another ${algorithm} integrity ${of}`, at(where, 'integrity'))
  }
}

// `mixed`: the entries with a registry pattern beside a source. yarn writes
// an entry for each `resolved` of a name, as spelled, and each directory.
export function readPackages(list) {
  const packages = Object.create(null)
  const wanted = []
  const mixed = []
  const merged = new Map()
  const fetched = new Map()
  const versions = new Map()
  for (const entry of list) {
    const [pkg, patterns] = readPackage(entry, wanted, mixed)
    const [key] = entry.keys
    const where = at('', key)
    for (const pattern of entry.keys) packages[pattern] = pkg
    const dir = patterns.find((pattern) => pattern.source === 'file')
    const one = entry.fields.resolved ?? (dir === undefined ? undefined : `\n${directory(dir.range)}`)
    const same = one === undefined ? undefined : `${pkg.name}\n${one}`
    if (merged.has(same)) throw new LockfileError(`resolves as ${quote(merged.get(same))} does, which yarn writes as one entry`, where)
    if (same !== undefined) merged.set(same, key)
    const source = fetchedFrom(pkg.resolution)
    if (fetched.has(source)) checkSame(pkg, fetched.get(source), where)
    else if (source !== undefined) fetched.set(source, pkg)
    const id = `${pkg.name}\n${pkg.version}`
    const asking = patterns.find(ranged)
    const prior = versions.get(id)
    if (prior === undefined) versions.set(id, { key, asking })
    else if ((asking ?? prior.asking) !== undefined) {
      throw new LockfileError(`is ${pkg.name} ${pkg.version}, as ${quote(prior.key)} is, and yarn gives ${quote((asking ?? prior.asking).key)} whichever it resolves first`, where)
    }
  }
  return { packages, mixed, unresolved: wanted.filter(({ pattern }) => !(pattern in packages)) }
}

// yarn writes no entry for a request a workspace's version satisfies, but
// links the workspace; only the manifests name the workspaces.
export function linkUnresolved(unresolved, workspaces) {
  for (const { targets, name, pattern, where } of unresolved) {
    const workspace = workspaces?.get(name)
    if (workspace === undefined) throw new LockfileError(`${quote(pattern)} is not a pattern of the lockfile${workspaces === undefined ? ', nor a workspace\'s, as only the manifests may say' : ''}`, where)
    targets[name] = `link:${workspace.dir}`
  }
}
