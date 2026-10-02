// composer.json, of what `composer install` reads of it beside the
// lockfile: the content-hash Locker::isFresh holds the lockfile to, and
// the root package as RootPackageLoader loads it, its name, the version it
// gives, if any, which Composer otherwise guesses from git, and its links.
// The root installs nothing, but what it provides and replaces meets a
// requirement, and what it conflicts with, requires and replaces is held
// to the lockfile.

import { LockfileError, at, quote } from '../error.js'
import { refuse, string } from '../shape.js'
import { decodeJson, encodeJson } from './json.js'
import { md5 } from './md5.js'
import { LINKS, checkName, plain, readVersion } from './package.js'
import { compareKeys, lower } from './php.js'
import { normalize, parseConstraints } from './semver.js'

export const WHERE = 'composerJson'

// Locker::getContentHash: of these keys, and config.platform.
const RELEVANT = ['name', 'version', 'require', 'require-dev', 'conflict', 'replace', 'provide', 'minimum-stability', 'prefer-stable', 'repositories', 'extra']

function contentHash(config) {
  const relevant = new Map(RELEVANT.filter((key) => config.has(key)).map((key) => [key, config.get(key)]))
  const settings = config.get('config')
  if (settings instanceof Map && settings.get('platform') !== undefined && settings.get('platform') !== null) relevant.set('config', new Map([['platform', settings.get('platform')]]))
  return md5(encodeJson(new Map([...relevant].sort(([a], [b]) => compareKeys(a, b)))))
}

const ALIAS = /^([^,\t\n\v\f\r #]+)(?:#[^ ]+)? +as +([^,\t\n\v\f\r ]+)$/u

// ArrayLoader::parseLinks of the root's, of an object of strings, as
// Composer's schema holds composer.json to before it is loaded, with what
// RootPackageLoader refuses of a requirement: an alias that is not of two
// versions, and the root itself.
function readLinks(config, key, name, version) {
  const value = config.get(key)
  if (value === undefined) return []
  if (!(value instanceof Map)) throw refuse('a mapping', value, at(WHERE, key))
  const byTarget = new Map()
  for (const [written, constraint] of value) {
    const target = lower(written)
    const where = at(at(WHERE, key), written)
    plain(string(constraint, where), where)
    const parsed = constraint === 'self.version' ? (version === undefined ? { all: true } : parseConstraints(version.pretty)) : parseConstraints(constraint)
    if (parsed === undefined) throw new LockfileError(`${quote(constraint)} is not a version constraint Composer reads`, where)
    if (key === 'require' || key === 'require-dev') {
      const alias = ALIAS.exec(constraint)
      if (alias === null ? constraint.includes(' as ') : normalize(alias[1]) === undefined || normalize(alias[2]) === undefined) throw new LockfileError(`${quote(constraint)} is not an alias of one version as another, which Composer refuses`, where)
      if (target === name) throw new LockfileError('the root itself, which Composer refuses', where)
    }
    byTarget.set(target, { target, pretty: constraint, constraint: parsed })
  }
  return [...byTarget.values()]
}

function decode(text) {
  if (typeof text !== 'string') throw new TypeError('composerJson: expected the text of composer.json')
  const config = decodeJson(text, WHERE)
  if (!(config instanceof Map)) throw new LockfileError('expected an object', WHERE)
  return config
}

// The content-hash of a composer.json, read or not.
export const contentHashOf = (text) => contentHash(decode(text))

export function readComposerJson(text) {
  const config = decode(text)
  let name = '__root__'
  if (config.has('name')) {
    name = checkName(config.get('name'), at(WHERE, 'name'))
    if (lower(name) !== name) throw new LockfileError(`${quote(name)} has capitals, which Composer refuses of the root`, at(WHERE, 'name'))
  }
  let version
  if (config.has('version')) {
    const pretty = string(config.get('version'), at(WHERE, 'version'))
    version = { pretty, normalized: readVersion(pretty, at(WHERE, 'version')) }
  }
  const links = Object.create(null)
  for (const [field, key] of Object.entries(LINKS)) links[field] = readLinks(config, key, name, version)
  return { contentHash: contentHash(config), name, version: version?.normalized, links }
}
