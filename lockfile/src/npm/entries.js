// An entry of `packages`, read with every field npm writes for its kind: a
// link; a directory a link leads to, or the project's own, which npm reads
// as a project; or a package in a node_modules. npm writes a field only
// where it has a value: no empty list, no false flag, no empty string.

import { LockfileError, at, quote } from '../error.js'
import { checkName, checkRegistryTarball, checkRelative, checkRepo, checkVersion, isCommit, isHttpUrl, readIntegrities } from '../names.js'
import { boolean, field, flag, mapping, record, refuse, text, textMap, texts } from '../shape.js'
import { fromHostedUrl } from './hosted.js'
import { isTarball } from './spec.js'

// The flags npm writes of how a node is depended on.
export const FLAGS = ['dev', 'optional', 'devOptional', 'peer']

const MANIFEST = [
  'name', 'version', 'dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta',
  'bundleDependencies', 'acceptDependencies', 'funding', 'engines', 'os', 'cpu', 'libc', 'license',
  'hasInstallScript', 'bin', 'deprecated', 'workspaces', ...FLAGS,
]
const FIELDS = {
  link: ['link', 'resolved'],
  importer: [...MANIFEST, 'devDependencies'],
  package: [...MANIFEST, 'resolved', 'integrity', 'inBundle'],
}

// Fields npm writes that are refused here, and why.
const REFUSED = {
  hasShrinkwrap: 'a shrinkwrap of its own, which is not supported',
  extraneous: 'nothing leads to it, and npm prunes it rather than install it',
}

// A list or mapping, which npm leaves out where it is empty.
function filled(value, where) {
  if (typeof value === 'object' && value !== null && Object.keys(value).length === 0) {
    throw new LockfileError(`expected what npm writes, which leaves an empty ${Array.isArray(value) ? 'sequence' : 'mapping'} out`, where)
  }
  return value
}

const filledMapping = (read) => (value, where) => mapping(filled(value, where), where, read)

const specs = (value, where) => textMap(filled(value, where), where, checkName)
const readName = (value, where) => checkName(text(value, where), where)
const names = (value, where) => texts(filled(value, where), where, checkName)
const strings = (value, where) => texts(filled(value, where), where)

// A sequence of strings, which old manifests have, or what `read` reads.
const stringsOr = (read) => (value, where) => (Array.isArray(value) ? strings(value, where) : read(value, where))

// Of a peer, whether it is optional: what else the package.json says of
// it, npm writes as it is and passes over.
const peersMeta = filledMapping((item, where, name) => {
  checkName(name, where)
  return { optional: field(record(item, where), 'optional', where, boolean) ?? false }
})

// A URL, a mapping of a type and a URL, or a sequence of either.
const funding = (value, where) => (typeof value === 'string' ? text(value, where) : filledMapping(text)(value, where))
const readFunding = (value, where) => (Array.isArray(value) ? filled(value, where).map((item, index) => funding(item, `${where}[${index}]`)) : funding(value, where))

// Globs, or the `packages` of them, which @npmcli/map-workspaces reads.
const readWorkspaces = stringsOr((value, where) => {
  record(filled(value, where), where, ['packages', 'nohoist'])
  field(value, 'nohoist', where, strings)
  return strings(value.packages, at(where, 'packages'))
})

const READERS = {
  __proto__: null,
  dependencies: specs,
  optionalDependencies: specs,
  peerDependencies: specs,
  // Written as the manifest has it, empty too.
  devDependencies: (value, where) => textMap(value, where, checkName),
  peerDependenciesMeta: peersMeta,
  acceptDependencies: specs,
  bundleDependencies: names,
  funding: readFunding,
  // Engines in a sequence npm finds none in.
  engines: stringsOr((value, where) => textMap(filled(value, where), where)),
  os: strings,
  cpu: strings,
  libc: strings,
  license: stringsOr(text),
  bin: filledMapping(text),
  deprecated: text,
  workspaces: readWorkspaces,
}

// npm leaves devOptional out where dev or optional is set.
function readFlags(entry, where) {
  const flags = Object.fromEntries(FLAGS.map((name) => [name, flag(entry[name], at(where, name))]))
  if (flags.devOptional && (flags.dev || flags.optional)) throw new LockfileError('set beside dev or optional, where npm leaves it out', at(where, 'devOptional'))
  return flags
}

// npm checks a tarball with the strongest of its integrities.
function readIntegrity(value, where) {
  readIntegrities(value, where)
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
  checkRegistryTarball(tarball, name, version, where)
}

const GIT = /^git(?:\+[a-z]+)?:/u

// Where a package's files come from: a tarball, by URL, by a `file:` path
// from the lockfile's directory, or from the registry for its name and
// version where npm leaves the URL out; or a commit of a repository.
// Undefined where there is neither, as for a package bundled in another.
function readResolution(entry, where, name, version) {
  const resolvedAt = at(where, 'resolved')
  const resolved = field(entry, 'resolved', where, text)
  const integrity = field(entry, 'integrity', where, readIntegrity)
  if (resolved === undefined) return integrity === undefined ? undefined : { type: 'tarball', tarball: undefined, integrity }
  if (GIT.test(resolved)) {
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
  record(entry, where, FIELDS.link, REFUSED)
  if (entry.link !== true) throw refuse('true', entry.link, at(where, 'link'))
  return checkRelative(entry.resolved, at(where, 'resolved'))
}

// A project's directory, or a package; `folder` the name its location
// gives it, undefined for the project's own. A bundle of a directory but
// the project's is not supported.
export function readEntry(entry, where, kindOf, folder) {
  record(entry, where, FIELDS[kindOf], REFUSED)
  const read = Object.create(null)
  for (const key of Object.keys(READERS)) read[key] = field(entry, key, where, READERS[key])
  if (kindOf === 'importer' && folder !== undefined && read.bundleDependencies !== undefined) {
    throw new LockfileError('a bundle of a directory, which is not supported', at(where, 'bundleDependencies'))
  }
  const name = field(entry, 'name', where, readName)
  if (name !== undefined && name === folder) throw new LockfileError('the name of its folder, which npm leaves out', at(where, 'name'))
  const version = field(entry, 'version', where, kindOf === 'package' ? checkVersion : text)
  // npm leaves out the version of a repository's package.json that has none.
  if (kindOf === 'package' && version === undefined && !GIT.test(entry.resolved ?? '')) {
    throw new LockfileError('expected a version, which only a package from a git repository is read without', at(where, 'version'))
  }
  const pkg = { name: name ?? folder, version, ...read, hasInstallScript: flag(entry.hasInstallScript, at(where, 'hasInstallScript')), flags: readFlags(entry, where) }
  if (kindOf === 'package') {
    pkg.resolution = readResolution(entry, where, pkg.name, version)
    pkg.inBundle = flag(entry.inBundle, at(where, 'inBundle'))
  }
  return pkg
}
