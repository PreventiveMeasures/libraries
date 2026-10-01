// The config's dependencies, soldeer.toml's or foundry.toml's, each held to
// its entry as Soldeer 0.12 holds it before it installs from the lockfile.

import { sanitizeWithOptions } from '../crate/sanitize-filename.js'
import { matches, parseVersion, parseVersionReq } from '../crate/semver.js'
import { LockfileError, at, quote } from '../error.js'
import { EMPTY, entries, record, string } from '../shape.js'

const WHERE = 'config.dependencies'
const OPTIONS = new Set(['version', 'url', 'git', 'rev', 'branch', 'tag', 'project_root'])

// A folder Soldeer names, on Unix and on Windows, as it runs on either.
const folders = (name) => [false, true].map((windows) => sanitizeWithOptions(name, { windows, truncate: true, replacement: '-' }))

// Where Soldeer would install what is called `name` in a folder taken.
export function claimFolder(taken, base, name, where) {
  for (const [system, folder] of folders(base).entries()) {
    const other = taken.get(`${system}/${folder}`)
    if (other !== undefined) throw new LockfileError(`installed in the folder ${quote(folder)}, as ${quote(other)} is`, where)
    taken.set(`${system}/${folder}`, name)
  }
}

function readVersion(value, where) {
  if (value === undefined || string(value, where) === '') throw new LockfileError('expected a version, which Soldeer requires', where)
  return value
}

// Soldeer's parse_dependency; what it would warn of and ignore is refused.
function readDependency(value, where) {
  if (typeof value === 'string') return { kind: 'registry', version: readVersion(value, where) }
  record(value, where)
  const other = Object.keys(value).find((key) => !OPTIONS.has(key))
  if (other !== undefined) throw new LockfileError('a field Soldeer does not read', at(where, other))
  for (const key of OPTIONS) if (key !== 'version' && value[key] !== undefined) string(value[key], at(where, key))
  const { url, git, rev } = value
  const kind = git === undefined ? (url === undefined ? 'registry' : 'URL') : 'git'
  const read = { kind, version: readVersion(value.version, at(where, 'version')), url, git, rev }
  const named = ['rev', 'branch', 'tag'].filter((key) => value[key] !== undefined)
  if (git === undefined && named.length > 0) throw new LockfileError('a field Soldeer ignores without a git repository', at(where, named[0]))
  if (git !== undefined && url !== undefined) throw new LockfileError('a url beside a git repository, which Soldeer refuses', at(where, 'url'))
  if (named.length > 1) throw new LockfileError(`${named.join(' and ')}, of which Soldeer takes one alone`, where)
  // Soldeer names the folder after the version of what it does not resolve.
  if (kind !== 'registry' && read.version.includes('=')) throw new LockfileError(`${quote(read.version)} has an "=", which Soldeer refuses in the version of what it does not resolve`, at(where, 'version'))
  return read
}

// Soldeer's version_matches_req: by semver where both read as it, a written
// comparator with no `^` exact, and else as the folder names they make.
function satisfies(locked, requirement) {
  const written = requirement.split(',')
  const comparators = parseVersionReq(requirement)?.map((cmp, index) => (cmp.op === '^' && !/^ *\^/u.test(written[index]) ? { ...cmp, op: '=' } : cmp))
  const parsed = parseVersion(locked)
  if (comparators !== undefined && parsed !== undefined) return matches(comparators, parsed)
  const [a, b] = [folders(locked), folders(requirement)]
  return a[0] === b[0] && a[1] === b[1]
}

const KIND = { http: 'a registry', git: 'a git', private: 'a private registry' }
// The entries Soldeer installs each kind of dependency from.
const FITS = { registry: ['http', 'private'], URL: ['http'], git: ['git'] }

// Soldeer's LockEntry::matches: of what it does not resolve, the very version.
function checkEntry(entry, dependency, where) {
  const { kind } = dependency
  if (!FITS[kind].includes(entry.type)) throw new LockfileError(`a ${kind} dependency, whose entry is ${KIND[entry.type]} one`, where)
  const fixed = kind !== 'registry'
  if (fixed ? entry.version !== dependency.version : !satisfies(entry.version, dependency.version)) {
    throw new LockfileError(`${quote(dependency.version)}, which its entry's version, ${quote(entry.version)}, ${fixed ? 'is not' : 'does not satisfy'}`, at(where, 'version'))
  }
  for (const field of ['url', 'git', 'rev']) {
    if (dependency[field] !== undefined && dependency[field] !== entry[field]) throw new LockfileError(`${quote(dependency[field])}, where its entry has ${quote(entry[field])}`, at(where, field))
  }
}

export function checkConfig(config, dependencies) {
  const table = record(config, 'config').dependencies ?? EMPTY
  const named = new Map()
  for (const [name, value, here] of entries(table, WHERE)) {
    const dependency = readDependency(value, here)
    // Soldeer refuses two names it would install in one folder.
    claimFolder(named, name, name, here)
    const entry = dependencies[name]
    if (entry === undefined) throw new LockfileError('no entry in the lockfile, which Soldeer then resolves anew', here)
    checkEntry(entry, dependency, here)
  }
  for (const name of Object.keys(dependencies)) {
    if (!Object.hasOwn(table, name)) throw new LockfileError('nothing in the config asks for it, and Soldeer drops it', at('dependencies', name))
  }
}
