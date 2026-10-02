// An entry of `packages`, read with every field npm writes for its kind: a
// link; a directory a link leads to, or the project's own, which npm reads
// as a project; or a package in a node_modules. npm writes a field only
// where it has a value: no empty list, no false flag, no empty string.

import { LockfileError, at, quote } from '../error.js'
import { checkIntegrity, checkName, checkRelative, checkRepo, checkVersion, isCommit, isHttpUrl } from '../names.js'
import { boolean, entries, field, flag, kind, record, string, text, texts } from '../shape.js'
import { fromHostedUrl } from './hosted.js'
import { isTarball } from './spec.js'

const MANIFEST = [
  'name', 'version', 'dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta',
  'bundleDependencies', 'acceptDependencies', 'funding', 'engines', 'os', 'cpu', 'libc', 'license',
  'hasInstallScript', 'bin', 'deprecated', 'workspaces', 'dev', 'optional', 'devOptional', 'peer',
]
const FIELDS = {
  link: ['link', 'resolved'],
  importer: [...MANIFEST, 'devDependencies'],
  package: [...MANIFEST, 'resolved', 'integrity', 'inBundle'],
}

// Fields npm writes that are refused here, and why.
const REFUSED = {
  __proto__: null,
  hasShrinkwrap: 'a shrinkwrap of its own, which is not supported',
  extraneous: 'nothing leads to it, and npm prunes it rather than install it',
}

function checkFields(entry, where, fields) {
  for (const key of Object.keys(record(entry, where))) {
    if (key in REFUSED) throw new LockfileError(REFUSED[key], at(where, key))
    if (!fields.includes(key)) throw new LockfileError(`unsupported field ${quote(key)}`, where)
  }
}

// A list or mapping, which npm leaves out where it is empty.
function filled(value, where) {
  if (typeof value === 'object' && value !== null && Object.keys(value).length === 0) {
    throw new LockfileError(`expected what npm writes, which leaves an empty ${Array.isArray(value) ? 'sequence' : 'mapping'} out`, where)
  }
  return value
}

const mapping = (read, empty = false) => (value, where) => {
  const map = Object.create(null)
  for (const [key, item, here] of entries(empty ? value : filled(value, where), where)) map[key] = read(item, here, key)
  return map
}

const spec = (value, where, name) => {
  checkName(name, where)
  return string(value, where)
}
const specs = mapping(spec)
const readName = (value, where) => checkName(text(value, where), where)
const names = (value, where) => texts(filled(value, where), where).map((name, index) => checkName(name, `${where}[${index}]`))
const strings = (value, where) => texts(filled(value, where), where)

// As the manifest has them: old ones list engines in a sequence, in which
// npm finds none.
const readEngines = (value, where) => (Array.isArray(value) ? strings(value, where) : mapping(string)(value, where))

const peersMeta = mapping((item, where, name) => {
  checkName(name, where)
  record(item, where, ['optional'])
  return { optional: field(item, 'optional', where, boolean) ?? false }
})

// A URL, a mapping of a type and a URL, or a sequence of either.
const funding = (value, where) => (typeof value === 'string' ? text(value, where) : mapping(text)(value, where))
const readFunding = (value, where) => (Array.isArray(value) ? filled(value, where).map((item, index) => funding(item, `${where}[${index}]`)) : funding(value, where))

// Globs, or the `packages` of them, which @npmcli/map-workspaces reads.
function readWorkspaces(value, where) {
  if (Array.isArray(value)) return strings(value, where)
  record(filled(value, where), where, ['packages', 'nohoist'])
  if (value.nohoist !== undefined) strings(value.nohoist, at(where, 'nohoist'))
  return strings(value.packages, at(where, 'packages'))
}

const READERS = {
  __proto__: null,
  dependencies: specs,
  optionalDependencies: specs,
  peerDependencies: specs,
  // Written as the manifest has it, empty too.
  devDependencies: mapping(spec, true),
  peerDependenciesMeta: peersMeta,
  acceptDependencies: specs,
  bundleDependencies: names,
  funding: readFunding,
  engines: readEngines,
  os: strings,
  cpu: strings,
  libc: strings,
  // A sequence in old packages.
  license: (value, where) => (Array.isArray(value) ? strings(value, where) : text(value, where)),
  bin: mapping(text),
  deprecated: text,
  workspaces: readWorkspaces,
}

// npm leaves devOptional out where dev or optional is set.
function readFlags(entry, where) {
  const flags = {}
  for (const name of ['dev', 'optional', 'devOptional', 'peer']) flags[name] = flag(entry[name], at(where, name))
  if (flags.devOptional && (flags.dev || flags.optional)) throw new LockfileError('set beside dev or optional, where npm leaves it out', at(where, 'devOptional'))
  return flags
}

// A registry keeps a package's tarball under its name, a scope's `/` once
// written `%2f`, and named after its version.
const REGISTRIES = new Set(['registry.npmjs.org', 'registry.yarnpkg.com'])

function checkRegistry(tarball, name, version, where) {
  const url = new URL(tarball)
  if (REGISTRIES.has(url.hostname) && url.pathname.replace(/^(\/@[^/]+)%2f/iu, '$1/') !== `/${name}/-/${name.slice(name.indexOf('/') + 1)}-${version}.tgz`) {
    throw new LockfileError(`${quote(tarball)} is not the registry's tarball of ${name}@${version}`, where)
  }
}

// Subresource integrity, of one hash or more, a space apart, of no
// algorithm twice: npm checks a tarball with the strongest.
function readIntegrity(value, where) {
  const algorithms = new Set()
  for (const part of text(value, where).split(' ')) {
    const algorithm = checkIntegrity(part, where).slice(0, part.indexOf('-'))
    if (algorithms.has(algorithm)) throw new LockfileError(`two ${algorithm} integrities`, where)
    algorithms.add(algorithm)
  }
  return value
}

// A tarball on disk, from the lockfile's directory, or by an http(s) URL,
// which npm reads as a repository where it is one on a git host.
function checkTarball(tarball, name, version, where) {
  if (tarball.startsWith('file:')) {
    if (!isTarball(tarball)) throw new LockfileError(`${quote(tarball)} is a directory, which npm packs again at every install: not supported`, where)
    checkRelative(tarball.slice(5), where)
    return
  }
  if (!isHttpUrl(tarball) || /\s/u.test(tarball)) throw new LockfileError(`${quote(tarball)} is not an http(s) URL, a file: tarball or a git URL`, where)
  if (fromHostedUrl(tarball) !== undefined) throw new LockfileError(`${quote(tarball)} is a repository to npm, which it reads as one on a git host`, where)
  checkRegistry(tarball, name, version, where)
}

// Where a package's files come from: a tarball, by URL, by a `file:` path
// from the lockfile's directory, or from the registry for its name and
// version where npm leaves the URL out; or a commit of a repository.
// Undefined where there is neither, as for a package bundled in another.
function readResolution(entry, where, name, version) {
  const resolvedAt = at(where, 'resolved')
  const resolved = field(entry, 'resolved', where, text)
  const integrity = field(entry, 'integrity', where, readIntegrity)
  if (resolved === undefined) return integrity === undefined ? undefined : { type: 'tarball', tarball: undefined, integrity }
  if (/^git(?:\+[a-z]+)?:/u.test(resolved)) {
    if (integrity !== undefined) throw new LockfileError('an integrity, which npm does not check for a git repository', at(where, 'integrity'))
    const sep = resolved.lastIndexOf('#')
    if (sep === -1 || !isCommit(resolved.slice(sep + 1))) throw new LockfileError(`expected a full commit hash after the "#" of ${quote(resolved)}`, resolvedAt)
    return { type: 'git', repo: checkRepo(resolved.slice(0, sep), resolvedAt), commit: resolved.slice(sep + 1) }
  }
  checkTarball(resolved, name, version, resolvedAt)
  if (integrity === undefined) throw new LockfileError('expected an integrity, which npm checks the tarball with', where)
  return { type: 'tarball', tarball: resolved, integrity }
}

// The name of the folder a location ends in, as npm reads one: a scope's
// folder and the one in it.
export function folderName(location) {
  const segments = location.split('/')
  const base = segments.at(-1)
  return segments.at(-2)?.startsWith('@') ? `${segments.at(-2)}/${base}` : base
}

// A link: where it leads, from the lockfile's directory.
export function readLink(entry, where) {
  checkFields(entry, where, FIELDS.link)
  if (entry.link !== true) throw new LockfileError(`expected true, found ${kind(entry.link)}`, at(where, 'link'))
  return checkRelative(entry.resolved, at(where, 'resolved'))
}

// A project's directory, or a package; `folder` the name its location
// gives it, undefined for the project's own.
export function readEntry(entry, where, kindOf, folder) {
  checkFields(entry, where, FIELDS[kindOf])
  const read = Object.create(null)
  for (const key of Object.keys(READERS)) read[key] = field(entry, key, where, READERS[key])
  const name = field(entry, 'name', where, readName)
  if (name !== undefined && name === folder) throw new LockfileError('the name of its folder, which npm leaves out', at(where, 'name'))
  const version = kindOf === 'package' ? checkVersion(entry.version, at(where, 'version')) : field(entry, 'version', where, text)
  const pkg = { name: name ?? folder, version, ...read, hasInstallScript: flag(entry.hasInstallScript, at(where, 'hasInstallScript')), flags: readFlags(entry, where) }
  if (kindOf === 'package') {
    pkg.resolution = readResolution(entry, where, pkg.name, version)
    pkg.inBundle = flag(entry.inBundle, at(where, 'inBundle'))
  }
  return pkg
}
