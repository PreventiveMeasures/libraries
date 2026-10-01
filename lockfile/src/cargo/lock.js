// Cargo.lock of `version = 3` or `version = 4`, as cargo 1.53 and later
// write it. The fields read are the ones below; any other is refused, and
// so is any other version: 1 and 2, which have no `version`, and 5, which
// only a nightly cargo reads.
//
// A package's `dependencies` name others as briefly as tells them apart:
// the name alone where there is one version of it, the version too where
// there are more, and the source where one version comes from two. Cargo
// drops a dependency it cannot find that way, or finds two of; here either
// is refused.

import { LockfileError, at, quote } from '../error.js'
import { isVersion } from '../names.js'
import { parseToml } from '../toml/parse.js'
import { array, checkName, kind, optional, string, strings, table } from './shape.js'

// Where a package comes from, as Cargo.lock writes it: `registry+` and a
// registry's index, `sparse+` and an index over HTTP, or `git+`, a
// repository, the branch, tag or rev asked for, and after `#` the commit it
// resolved to. Two sources are one where cargo holds them so: of one kind,
// asking for the same branch, tag or rev, at the same URL once canonical
// (github.com's in https and lower case, no trailing `/` or `.git`),
// whatever the commit. `identity` is that, as a string.

const REFERENCES = ['branch', 'tag', 'rev']
const COMMIT = /^(?:[\da-f]{40}|[\da-f]{64})$/u

function canonical(url) {
  const github = url.hostname === 'github.com'
  const copy = new URL(github ? `https:${url.href.slice(url.protocol.length)}` : url.href)
  let path = copy.pathname.replace(/\/$/u, '')
  if (github) path = path.toLowerCase()
  copy.pathname = path.replace(/\.git$/u, '')
  return copy.href
}

// A URL as the url crate writes it, which is how cargo writes one back.
function parseUrl(text) {
  const url = URL.parse(text)
  return url !== null && url.href === text ? url : undefined
}

const identity = (scheme, url, reference = []) => JSON.stringify([scheme, canonical(url), ...reference])

// `edge` for a source in a package's `dependencies`, which cargo writes
// without the commit; a package's own source has it.
export function parseLockSource(text, where, edge) {
  const fail = (why) => {
    throw new LockfileError(`${quote(text)} is not a source: ${why}`, where)
  }
  const [, scheme, rest] = /^(registry|sparse|git)\+(.*)$/su.exec(text) ?? fail('expected registry+, sparse+ or git+ and a URL')
  if (scheme !== 'git') {
    const url = parseUrl(scheme === 'sparse' ? text : rest)
    if (url === undefined || url.search !== '' || url.hash !== '') fail('expected a URL in normal form, without a query or a fragment')
    return { scheme, identity: identity(scheme, url) }
  }
  const [, base, query, commit] = /^([^#?]*)(?:\?([^#]*))?(?:#(.*))?$/su.exec(rest)
  if (edge ? commit !== undefined : !COMMIT.test(commit ?? '')) fail(edge ? 'a dependency names no commit' : 'expected "#" and the commit it resolved to')
  const url = parseUrl(base) ?? fail('expected a URL in normal form')
  const pairs = [...new URLSearchParams(query ?? '')]
  if (pairs.length > 1 || (pairs.length === 1 && !REFERENCES.includes(pairs[0][0]))) fail('expected at most one of branch=, tag= or rev=')
  return { scheme, identity: identity(scheme, url, pairs[0]) }
}

const CRATES_IO = new URL('https://github.com/rust-lang/crates.io-index')
const cratesIo = (source) => source.registry === undefined || source.registry === 'crates-io'

// A registry named but not by its index is one of the lockfile's registries,
// which one being cargo's configuration's to say.
export const ANY_REGISTRY = 'any registry'

// The identity of what a manifest names; a path is the package's own
// source, `parent`, as cargo reads it from where the manifest is.
export function sourceIdentity(source, parent) {
  if (source.type === 'path') return parent
  if (source.type === 'git') {
    const reference = REFERENCES.flatMap((key) => (source[key] === undefined ? [] : [key, source[key]]))
    return identity('git', new URL(source.url), reference)
  }
  if (source.index !== undefined) return identity(source.index.startsWith('sparse+') ? 'sparse' : 'registry', new URL(source.index))
  return cratesIo(source) ? identity('registry', CRATES_IO) : ANY_REGISTRY
}

// What a [patch] table is keyed by, as cargo matches one to a dependency:
// the canonical URL of the source it patches, whatever its kind or git
// reference, crates.io's for `crates-io`, or a registry's name where only
// cargo's configuration knows its URL. `patchKey` reads the table's key;
// `patchedAs` gives a dependency's, undefined for a path, which is patched
// by no table.
export function patchKey(key) {
  const url = key === 'crates-io' ? CRATES_IO : URL.parse(key)
  return url === null ? `registry ${key}` : canonical(url)
}

// The URL cargo first keys a [patch] table by, before it is canonical: one
// table of two at one such URL replaces the other.
export function patchUrl(key) {
  return key === 'crates-io' ? CRATES_IO.href : (URL.parse(key)?.href ?? `registry ${key}`)
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
const CHECKSUM = /^[\da-f]{64}$/u

// Keys cargo reads that are not read here, by why.
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

// The key a package goes by: how a lockfile names it in full, `name
// version` for a path package and `name version (source)` for any other.
const keyOf = (name, version, source) => (source === undefined ? `${name} ${version}` : `${name} ${version} (${source})`)

function readPackage(value, where, fields = PACKAGE) {
  table(value, where, fields, PACKAGE_REFUSED)
  const name = checkName(value.name, at(where, 'name'))
  const version = string(value.version, at(where, 'version'))
  if (!isVersion(version)) throw new LockfileError(`${quote(version)} is not a version`, at(where, 'version'))
  const source = optional(string)(value.source, at(where, 'source'))
  const parsed = source === undefined ? undefined : parseLockSource(source, at(where, 'source'), false)
  const checksum = optional(string)(value.checksum, at(where, 'checksum'))
  if (checksum !== undefined && (parsed === undefined || parsed.scheme === 'git')) {
    throw new LockfileError(`a ${parsed === undefined ? 'path' : 'git'} package has no checksum`, at(where, 'checksum'))
  }
  if (checksum !== undefined && !CHECKSUM.test(checksum)) throw new LockfileError(`${quote(checksum)} is not a sha256 checksum`, at(where, 'checksum'))
  const edges = value.dependencies === undefined ? [] : strings(value.dependencies, at(where, 'dependencies'))
  return { key: keyOf(name, version, source), name, version, source, checksum, identity: parsed?.identity, edges }
}

// Cargo's lookup_id, strict: a name there is, one version of it, and one
// source among the packages of that version, or the path package alone
// where the source is left out.
function resolveEdge(edge, where, byName) {
  const fail = (why) => {
    throw new LockfileError(`${quote(edge)} ${why}`, where)
  }
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

// Every package is reached from a path package, a workspace member or one
// of their path dependencies, as cargo prunes the rest; which of them are
// members, and reach it, linkCargo checks.
function checkReached(packages, where) {
  const reached = new Set(packages.filter((pkg) => pkg.source === undefined))
  for (const pkg of reached) for (const next of pkg.resolved) reached.add(next)
  const lost = packages.find((pkg) => !reached.has(pkg))
  if (lost !== undefined) throw new LockfileError(`nothing in the workspace depends on ${quote(lost.key)}, directly or not`, where)
}

export function parseCargoLock(text) {
  if (typeof text !== 'string') throw new TypeError('expected a string')
  const doc = table(parseToml(text), undefined, FIELDS, TOP_REFUSED)
  const version = checkVersion(doc.version, 'version')
  const read = array(doc.package ?? [], 'package').map((item, index) => readPackage(item, `package[${index}]`))
  const seen = new Map()
  for (const [index, pkg] of read.entries()) {
    const same = `${pkg.name} ${pkg.version} ${pkg.identity}`
    if (seen.has(same)) throw new LockfileError(`${quote(pkg.key)} is listed twice, first as package[${seen.get(same)}]`, `package[${index}]`)
    seen.set(same, index)
  }
  const byName = Map.groupBy(read, (pkg) => pkg.name)
  for (const [index, pkg] of read.entries()) {
    const where = at(`package[${index}]`, 'dependencies')
    pkg.resolved = pkg.edges.map((edge, i) => resolveEdge(edge, `${where}[${i}]`, byName))
    const twice = pkg.resolved.find((dep, i) => pkg.resolved.indexOf(dep) !== i)
    if (twice !== undefined) throw new LockfileError(`${quote(twice.key)} is listed twice`, where)
  }
  checkReached(read, 'package')
  const packages = Object.create(null)
  for (const pkg of read) {
    packages[pkg.key] = { name: pkg.name, version: pkg.version, source: pkg.source, checksum: pkg.checksum, dependencies: pkg.resolved.map((dep) => dep.key) }
  }
  return { version, packages, unusedPatches: readUnused(doc.patch) }
}

// [[patch.unused]]: what a [patch] in the workspace offers that nothing
// takes, which cargo keeps so as not to resolve it again.
function readUnused(value) {
  if (value === undefined) return []
  table(value, 'patch', ['unused'])
  return array(value.unused, 'patch.unused').map((item, index) => {
    const { name, version, source, checksum } = readPackage(item, `patch.unused[${index}]`, UNUSED)
    return { name, version, source, checksum }
  })
}
