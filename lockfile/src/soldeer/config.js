// The config's dependencies, soldeer.toml's or foundry.toml's, each held to
// its entry as Soldeer 0.12 holds it before it installs from the lockfile.

import { LockfileError, at, quote } from '../error.js'
import { EMPTY, entries, record } from '../shape.js'
import { folders, sanitize } from './sanitize.js'
import { matches, parseVersion, soldeerRequirement } from './semver.js'

const WHERE = 'config.dependencies'
const OPTIONS = new Set(['version', 'url', 'git', 'rev', 'branch', 'tag', 'project_root'])

function text(value, where) {
  if (typeof value !== 'string') throw new LockfileError('expected a string', where)
  return value
}

// Soldeer's parse_dependency; what it would warn of and ignore is refused.
function readDependency(name, value, where) {
  if (typeof value === 'string') {
    if (value === '') throw new LockfileError('expected a version, which Soldeer requires', where)
    return { type: 'http', version: value }
  }
  record(value, where)
  const other = Object.keys(value).find((key) => !OPTIONS.has(key))
  if (other !== undefined) throw new LockfileError('a field Soldeer does not read', at(where, other))
  if (value.version === undefined) throw new LockfileError('expected a version, which Soldeer requires', where)
  const version = text(value.version, at(where, 'version'))
  if (version === '') throw new LockfileError('expected a version, which Soldeer requires', at(where, 'version'))
  if (value.project_root !== undefined) text(value.project_root, at(where, 'project_root'))
  const named = ['rev', 'branch', 'tag'].filter((key) => value[key] !== undefined)
  for (const key of named) text(value[key], at(where, key))
  if (value.git === undefined) {
    if (named.length > 0) throw new LockfileError('a field Soldeer ignores without a git repository', at(where, named[0]))
    if (value.url === undefined) return { type: 'http', version }
  } else {
    if (value.url !== undefined) throw new LockfileError('a url beside a git repository, which Soldeer refuses', at(where, 'url'))
    if (named.length > 1) throw new LockfileError(`${named.join(' and ')}, of which Soldeer takes one alone`, where)
  }
  // Soldeer names the folder after such a version, as it is.
  if (version.includes('=')) throw new LockfileError(`${quote(version)} has an "=", which Soldeer refuses in the version of what it does not resolve`, at(where, 'version'))
  if (value.git === undefined) return { type: 'http', version, url: text(value.url, at(where, 'url')) }
  return { type: 'git', version, git: text(value.git, at(where, 'git')), rev: value.rev }
}

// Soldeer's version_matches_req: by semver where both read as it, and else
// as the folder names they make, on Unix and on Windows alike.
function satisfies(version, requirement) {
  const comparators = soldeerRequirement(requirement)
  const parsed = parseVersion(version)
  if (comparators !== undefined && parsed !== undefined) return matches(comparators, parsed)
  return [false, true].every((windows) => sanitize(version, windows) === sanitize(requirement, windows))
}

const KIND = { http: 'a registry', git: 'a git', private: 'a private registry' }

// Soldeer's LockEntry::matches: of what it does not resolve, the very version.
function checkEntry(entry, dependency, where) {
  const kind = dependency.type === 'git' ? 'git' : dependency.url === undefined ? 'registry' : 'URL'
  const fits = dependency.type === 'git' ? entry.type === 'git' : entry.type === 'http' || (entry.type === 'private' && dependency.url === undefined)
  if (!fits) throw new LockfileError(`a ${kind} dependency, whose entry is ${KIND[entry.type]} one`, where)
  const fixed = kind !== 'registry'
  if (fixed ? entry.version !== dependency.version : !satisfies(entry.version, dependency.version)) {
    throw new LockfileError(`${quote(dependency.version)}, which its entry's version, ${quote(entry.version)}, ${fixed ? 'is not' : 'does not satisfy'}`, at(where, 'version'))
  }
  for (const field of ['url', 'git', 'rev']) {
    if (dependency[field] !== undefined && dependency[field] !== entry[field]) throw new LockfileError(`${quote(dependency[field])}, where its entry has ${quote(entry[field])}`, at(where, field))
  }
}

export function checkConfig(config, dependencies) {
  record(config, 'config')
  const table = config.dependencies ?? EMPTY
  const named = [new Map(), new Map()]
  for (const [name, value, here] of entries(table, WHERE)) {
    const dependency = readDependency(name, value, here)
    // Soldeer refuses two names it would install in one folder.
    for (const [system, folder] of folders(name).entries()) {
      const other = named[system].get(folder)
      if (other !== undefined) throw new LockfileError(`installed in the folder ${quote(folder)}, as ${quote(other)} is`, here)
      named[system].set(folder, name)
    }
    const entry = dependencies[name]
    if (entry === undefined) throw new LockfileError('no entry in the lockfile, which Soldeer then resolves anew', here)
    checkEntry(entry, dependency, here)
  }
  for (const name of Object.keys(dependencies)) {
    if (!Object.hasOwn(table, name)) throw new LockfileError('nothing in the config asks for it, and Soldeer drops it', at('dependencies', name))
  }
}
