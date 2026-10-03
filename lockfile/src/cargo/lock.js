// Cargo.lock versions 3 and 4. A package's `dependencies` name others as
// briefly as tells them apart: the name, then the version, then the source.
// Cargo drops an edge it cannot find that way, or finds two of; this refuses
// it.

import { LockfileError, at, quote, raise } from '../error.js'
import { checkRepo, isCommit, isHexSha256 } from '../names.js'
import { field, repeated } from '../shape.js'
import { parseToml } from '../toml/parse.js'
import { array, checkCrateName, checkCrateVersion, checkListedOnce, kind, string, strings, table } from './shape.js'

// Two sources are one where cargo holds them so: of one kind, asking for the
// same branch, tag or rev, at the same canonical URL (github.com's in https
// and lower case, no trailing `/` or `.git`), whatever the commit.
// `identity` is that, as a string.

const REFERENCES = ['branch', 'tag', 'rev']

function canonical(url) {
  const github = url.hostname === 'github.com'
  const copy = new URL(github ? `https:${url.href.slice(url.protocol.length)}` : url.href)
  const path = copy.pathname.replace(/\/$/u, '')
  copy.pathname = (github ? path.toLowerCase() : path).replace(/\.git$/u, '')
  return copy.href
}

// Only a URL as the url crate writes it, which is how cargo writes one.
function parseUrl(text) {
  const url = URL.parse(text)
  return url !== null && url.href === text ? url : undefined
}

const identity = (scheme, url, reference = []) => JSON.stringify([scheme, canonical(url), ...reference])

// Cargo writes a source in `dependencies`, an `edge`, without the commit.
export function parseLockSource(text, where, edge) {
  const fail = (why) => raise(`${quote(text)} is not a source: ${why}`, where)
  const [, scheme, rest] = /^(registry|sparse|git)\+(.*)$/su.exec(text) ?? fail('expected registry+, sparse+ or git+ and a URL')
  if (scheme !== 'git') {
    const url = parseUrl(scheme === 'sparse' ? text : rest)
    if (url === undefined || url.search !== '' || url.hash !== '') fail('expected a URL in normal form, without a query or a fragment')
    // A registry's index, but a sparse one's, is a repository git fetches.
    if (scheme === 'registry') checkRepo(rest, where)
    return { scheme, identity: identity(scheme, url) }
  }
  const [, base, query, commit] = /^([^#?]*)(?:\?([^#]*))?(?:#(.*))?$/su.exec(rest)
  if (edge ? commit !== undefined : !isCommit(commit ?? '')) fail(edge ? 'a dependency names no commit' : 'expected "#" and the commit it resolved to')
  const url = parseUrl(base) ?? fail('expected a URL in normal form')
  checkRepo(base, where)
  const pairs = [...new URLSearchParams(query ?? '')]
  if (pairs.length > 1 || (pairs.length === 1 && !REFERENCES.includes(pairs[0][0]))) fail('expected at most one of branch=, tag= or rev=')
  return { scheme, identity: identity(scheme, url, pairs[0]) }
}

const CRATES_IO = new URL('https://github.com/rust-lang/crates.io-index')
const cratesIo = (source) => source.registry === undefined || source.registry === 'crates-io'

// A registry named, not by its index: which one, only cargo's config says.
export const ANY_REGISTRY = 'any registry'

// A path dependency has its manifest's own source, `parent`.
export function sourceIdentity(source, parent) {
  if (source.type === 'path') return parent
  if (source.type === 'git') {
    const reference = REFERENCES.flatMap((key) => (source[key] === undefined ? [] : [key, source[key]]))
    return identity('git', new URL(source.url), reference)
  }
  if (source.index !== undefined) return identity(source.index.startsWith('sparse+') ? 'sparse' : 'registry', new URL(source.index))
  return cratesIo(source) ? identity('registry', CRATES_IO) : ANY_REGISTRY
}

// Cargo matches a [patch] table to a dependency by canonical URL, whatever
// the kind or git reference; a registry known by name alone by its name. A
// path dependency is patched by no table.
const tableUrl = (key) => (key === 'crates-io' ? CRATES_IO : URL.parse(key))

export function patchKey(key) {
  const url = tableUrl(key)
  return url === null ? `registry ${key}` : canonical(url)
}

// The URL before it is canonical, which cargo first keys tables by.
export function patchUrl(key) {
  return tableUrl(key)?.href ?? `registry ${key}`
}

export function patchedAs(source) {
  if (source.type === 'path') return undefined
  if (source.type === 'git') return canonical(new URL(source.url))
  if (source.index !== undefined) return canonical(new URL(source.index))
  return cratesIo(source) ? canonical(CRATES_IO) : `registry ${source.registry}`
}

const FIELDS = ['version', 'package', 'patch']
const PACKAGE = ['name', 'version', 'source', 'checksum', 'dependencies']
const UNUSED = ['name', 'version', 'source', 'checksum']

const TOP_REFUSED = {
  root: 'a [root] table is lockfile version 1, which is not read here',
  metadata: 'a [metadata] table holds checksums in lockfile version 1 and nothing cargo writes after',
}
const PACKAGE_REFUSED = { replace: '[replace] is not supported' }

function checkVersion(value, where) {
  if (value === 3 || value === 4) return value
  if (value === undefined) throw new LockfileError('no `version`: this is lockfile version 1 or 2, which is not read here, where 3 and 4 are', where)
  if (value === 5) throw new LockfileError('lockfile version 5 is only read by a nightly cargo, with -Znext-lockfile-bump', where)
  throw new LockfileError(`unsupported version: expected 3 or 4, found ${kind(value)}`, where)
}

export const keyOf = (name, version, source) => (source === undefined ? `${name} ${version}` : `${name} ${version} (${source})`)

function readPackage(value, where, fields = PACKAGE) {
  table(value, where, fields, PACKAGE_REFUSED)
  const name = checkCrateName(value.name, at(where, 'name'))
  const version = checkCrateVersion(value.version, at(where, 'version'))
  const source = field(value, 'source', where, string)
  const parsed = source === undefined ? undefined : parseLockSource(source, at(where, 'source'), false)
  const checksum = field(value, 'checksum', where, string)
  if (checksum !== undefined && (parsed === undefined || parsed.scheme === 'git')) {
    throw new LockfileError(`a ${parsed === undefined ? 'path' : 'git'} package has no checksum`, at(where, 'checksum'))
  }
  if (checksum !== undefined && !isHexSha256(checksum)) throw new LockfileError(`${quote(checksum)} is not a sha256 checksum`, at(where, 'checksum'))
  // A registry gives each package's checksum, which cargo checks the download
  // with, and refuses a lockfile that has none of; [[patch.unused]] may lack
  // one.
  if (checksum === undefined && parsed !== undefined && parsed.scheme !== 'git' && fields === PACKAGE) {
    throw new LockfileError("expected a checksum, which cargo checks a registry's package with, and refuses the lockfile without", where)
  }
  const edges = field(value, 'dependencies', where, strings) ?? []
  return { key: keyOf(name, version, source), name, version, source, checksum, identity: parsed?.identity, edges }
}

// Cargo's lookup_id, strict. With no source given, a path package is taken
// over the others of its version.
function resolveEdge(edge, where, byName) {
  const fail = (why) => raise(`${quote(edge)} ${why}`, where)
  const [, name, version, source] = /^([^ ]+)(?: ([^ ]+)(?: \((.+)\))?)?$/su.exec(edge) ?? fail('is not `name`, `name version` or `name version (source)`')
  const named = byName.get(name) ?? fail('names no package in the lockfile')
  const versions = version === undefined ? [...new Set(named.map((pkg) => pkg.version))] : [version]
  if (versions.length > 1) fail(`could be any of ${versions.length} versions`)
  const same = named.filter((pkg) => pkg.version === versions[0])
  if (same.length === 0) fail('names a version the lockfile does not hold')
  if (source !== undefined) {
    const wanted = parseLockSource(source, where, true).identity
    const found = same.filter((pkg) => pkg.identity === wanted)
    if (found.length !== 1) fail('names a source the lockfile does not hold')
    return found[0]
  }
  const paths = same.filter((pkg) => pkg.source === undefined)
  if (paths.length > 0 || same.length === 1) return paths[0] ?? same[0]
  return fail(`could be any of ${same.length} sources`)
}

// Cargo prunes what no path package reaches; linkCargo checks the members.
function checkReached(packages, where) {
  const reached = new Set(packages.filter((pkg) => pkg.source === undefined))
  for (const pkg of reached) for (const next of pkg.resolved) reached.add(next)
  const lost = packages.find((pkg) => !reached.has(pkg))
  if (lost !== undefined) throw new LockfileError(`nothing in the workspace depends on ${quote(lost.key)}, directly or not`, where)
}

export function parseCargoLock(text) {
  const doc = table(parseToml(text), undefined, FIELDS, TOP_REFUSED)
  const version = checkVersion(doc.version, 'version')
  const read = array(doc.package ?? [], 'package').map((item, index) => readPackage(item, `package[${index}]`))
  checkListedOnce(read, (pkg) => `${pkg.name} ${pkg.version} ${pkg.identity}`, (pkg) => pkg.key)
  const byName = Map.groupBy(read, (pkg) => pkg.name)
  for (const [index, pkg] of read.entries()) {
    const where = at(`package[${index}]`, 'dependencies')
    pkg.resolved = pkg.edges.map((edge, i) => resolveEdge(edge, `${where}[${i}]`, byName))
    const twice = repeated(pkg.resolved)
    if (twice !== undefined) throw new LockfileError(`${quote(twice.key)} is listed twice`, where)
  }
  checkReached(read, 'package')
  const packages = Object.create(null)
  for (const pkg of read) packages[pkg.key] = { ...lockedOf(pkg), dependencies: pkg.resolved.map((dep) => dep.key) }
  return { version, packages, unusedPatches: readUnused(doc.patch) }
}

function readUnused(value) {
  if (value === undefined) return []
  table(value, 'patch', ['unused'])
  return array(value.unused, 'patch.unused').map((item, index) => lockedOf(readPackage(item, `patch.unused[${index}]`, UNUSED)))
}

// What Cargo.lock says of a package.
export const lockedOf = ({ name, version, source, checksum }) => ({ name, version, source, checksum })
