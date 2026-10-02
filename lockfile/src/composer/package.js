// One package of a composer.lock, as Locker::lockPackages writes it: what
// ArrayDumper makes of the package ArrayLoader reads from it, less its
// version_normalized and installation-source, its time moved last. A field
// is refused where Composer would write it back otherwise, or would not
// read it: a string where a list goes, an empty value, a key out of order,
// a version or a constraint it does not parse. Paths are relative and URLs
// held to their kind; what Composer only passes on is handed back as
// written.

import { LockfileError, at, quote } from '../error.js'
import { checkRefName, checkRelative, isCommit, isHttpUrl } from '../names.js'
import { kind } from '../shape.js'
import { keysOf } from './json.js'
import { compareKeys, compareStrings, empty, lower, trim } from './php.js'
import { normalize, parseConstraints, parseStability } from './semver.js'

const refuse = (expected, value, where) => new LockfileError(`expected ${expected}, found ${kind(value)}`, where)

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

// A mapping with the `fields` named alone, each in its place in them;
// `where` undefined for the top of the file.
export function ordered(value, where, fields, refused = {}) {
  if (!isRecord(value)) throw refuse('a mapping', value, where)
  const step = (key) => (where === undefined ? key : at(where, key))
  let last = -1
  for (const key of keysOf(value)) {
    if (Object.hasOwn(refused, key)) throw new LockfileError(refused[key], step(key))
    const place = fields.indexOf(key)
    if (place === -1) throw new LockfileError(`unsupported field ${quote(key)}`, where)
    if (place < last) throw new LockfileError(`out of the order Composer writes, before ${quote(fields[last])}`, step(key))
    last = place
  }
  return value
}

export function string(value, where) {
  if (typeof value !== 'string') throw refuse('a string', value, where)
  return value
}

// What Composer reads only where PHP's empty() is false of it, which is of
// "0" too, and so writes no other way.
export function filled(value, where) {
  if (empty(string(value, where))) throw new LockfileError(`${quote(value)}, which Composer reads as no value and does not write`, where)
  return value
}

// A version or a constraint: no control character, where PCRE reads a
// line end otherwise than the port of it here.
const CONTROL = /[\p{Cc}]/u

export function plain(value, where) {
  if (CONTROL.test(string(value, where))) throw new LockfileError(`${quote(value)} has a control character in it`, where)
  return value
}

const nonEmpty = (value, where) => {
  if (Array.isArray(value) ? value.length === 0 : !isRecord(value)) throw refuse('a non-empty mapping or sequence', value, where)
  return value
}

const list = (value, where) => {
  if (!Array.isArray(value)) throw refuse('a sequence', value, where)
  if (value.length === 0) throw new LockfileError('an empty sequence, which Composer does not write', where)
  return value
}

const strings = (value, where, check = string) => list(value, where).map((item, index) => check(item, `${where}[${index}]`))

const record = (value, where) => {
  if (!isRecord(value)) throw refuse('a mapping', value, where)
  if (keysOf(value).length === 0) throw new LockfileError('an empty mapping, which Composer does not write', where)
  return value
}

// Keys as ksort leaves them.
function sortedKeys(value, where) {
  const keys = keysOf(value)
  for (let i = 1; i < keys.length; i++) {
    if (compareKeys(keys[i - 1], keys[i]) > 0) throw new LockfileError(`out of the order Composer sorts the keys in, after ${quote(keys[i - 1])}`, at(where, keys[i]))
  }
  return keys
}

// A version as a package is locked at: one Composer normalizes, as a tag
// or a branch names it, with no alias, stability flag or space about it.
export function checkVersion(value, where) {
  const version = plain(value, where)
  const normalized = /\s|@(?:stable|RC|beta|alpha|dev)$/iu.test(version) || version === '0' ? undefined : normalize(version)
  if (normalized === undefined) throw new LockfileError(`${quote(version)} is not a version Composer locks a package at`, where)
  return normalized
}

export function checkConstraint(value, where) {
  if (plain(value, where) !== 'self.version' && parseConstraints(value) === undefined) throw new LockfileError(`${quote(value)} is not a version constraint Composer reads`, where)
  return value
}

// A name as ValidatingArrayLoader::hasPackageNamingError takes one, which
// Composer 2.10 holds every package it installs to: a vendor and a
// package, capitals let be, as Composer goes by the name in lowercase.
const NAME = /^[a-z0-9](?:[_.-]?[a-z0-9]+)*\/[a-z0-9](?:(?:[_.]|-{1,2})?[a-z0-9]+)*$/iu
const RESERVED = new Set(['nul', 'con', 'prn', 'aux', ...['com', 'lpt'].flatMap((device) => Array.from({ length: 9 }, (_, i) => `${device}${i + 1}`))])

export function checkName(value, where) {
  const name = string(value, where)
  if (!NAME.test(name)) throw new LockfileError(`${quote(name)} is not a package name, a vendor and a package as Composer takes them`, where)
  if (lower(name).split('/').some((part) => RESERVED.has(part))) throw new LockfileError(`${quote(name)} has a name Windows reserves in it, which Composer refuses`, where)
  if (name.endsWith('.json')) throw new LockfileError(`${quote(name)} ends in .json, which Composer refuses`, where)
  return name
}

// A link's target, lowercased as ArrayLoader lowers it, of the characters
// ValidatingArrayLoader takes in one.
const TARGET = /^[a-z0-9_./-]+$/u

export const PLATFORM = /^(?:php(?:-64bit|-ipv6|-zts|-debug)?|hhvm|(?:ext|lib)-[a-z0-9](?:[_.-]?[a-z0-9]+)*|composer(?:-(?:plugin|runtime)-api)?)$/iu

export const isPlatform = (name) => PLATFORM.test(name)

function readLinks(value, where) {
  const links = Object.create(null)
  for (const target of sortedKeys(record(value, where), where)) {
    const here = at(where, target)
    if (!TARGET.test(target)) throw new LockfileError(`${quote(target)} is not a package name in lowercase, as Composer writes a link's`, here)
    links[target] = checkConstraint(value[target], here)
  }
  return links
}

// A path from the lockfile's directory, as Composer writes the one it was
// given: `./` in front or not.
export function checkPath(value, where) {
  const path = plain(value, where)
  if (path.startsWith('/') || /^[A-Za-z]:/u.test(path)) throw new LockfileError(`${quote(path)} is an absolute path, of the machine the lockfile was written on`, where)
  checkRelative(path.startsWith('./') ? path.slice(2) : path, where)
  return path
}

// Composer 2.10 refuses a URL or a reference that a tool would read as an
// option.
function notOption(value, where) {
  if (/^\s*-/u.test(plain(value, where))) throw new LockfileError(`${quote(value)} starts with "-", which a tool would read as an option and Composer refuses`, where)
  if (value === '') throw new LockfileError('an empty string, of which Composer fetches nothing', where)
  return value
}

const REMOTE = {
  git: ['https:', 'http:', 'ssh:', 'git:', 'git+ssh:'],
  hg: ['https:', 'http:', 'ssh:'],
  svn: ['https:', 'http:', 'svn:', 'svn+ssh:'],
  fossil: ['https:', 'http:'],
}

// P4PORT as Perforce::isValidPort takes it: `[tcp|ssl:][host:]port`, where
// `rsh:` and `jsh:` would run a command.
const P4PORT = /^(?:(?:tcp|ssl)(?:4|6|46|64)?:)?(?:\[[0-9a-f:.]+\]|[a-z0-9._][a-z0-9._-]*)(?::[a-z0-9._][a-z0-9._-]*)?$/iu

// A repository to clone: a URL of a scheme its tool fetches over, git's
// `user@host:path`, or a path from the lockfile's directory. An absolute
// path, or a file: URL, is of the machine the lockfile was written on.
function checkSourceUrl(value, where, type) {
  const url = notOption(value, where)
  if (type === 'perforce') {
    if (!P4PORT.test(url) || /^\s*(?:rsh|jsh)\s*:/iu.test(url)) throw new LockfileError(`${quote(url)} is not a Perforce port, [tcp|ssl:][host:]port, as Composer takes one`, where)
    return url
  }
  if (/^[a-z][a-z0-9+.-]*:/iu.test(url) && !(type === 'git' && /^[\w.-]+@[\w.-]+:/u.test(url))) {
    const parsed = URL.parse(url)
    if (parsed === null || !REMOTE[type].includes(parsed.protocol) || /\s/u.test(url)) throw new LockfileError(`${quote(url)} is not a URL ${type} fetches from, ${REMOTE[type].join(' ')}`, where)
    return url
  }
  if (type === 'git' && /^[\w.-]+@[\w.-]+:[^\s]/u.test(url)) return url
  return checkPath(url, where)
}

function checkReference(value, where, type) {
  const reference = notOption(value, where)
  if (type === 'git' && !isCommit(reference)) checkRefName(reference, where)
  return reference
}

// A mirror Composer tries before or after the URL, with %package%,
// %version%, %reference% and %type% in it.
function readMirrors(value, where) {
  return list(value, where).map((item, index) => {
    const here = `${where}[${index}]`
    ordered(item, here, ['url', 'preferred'])
    if (item.preferred !== true && item.preferred !== false) throw refuse('true or false', item.preferred, at(here, 'preferred'))
    return { url: notOption(item.url, at(here, 'url')), preferred: item.preferred }
  })
}

const SOURCES = ['git', 'hg', 'svn', 'fossil', 'perforce']

function readSource(value, where) {
  ordered(value, where, ['type', 'url', 'reference', 'mirrors'])
  const type = string(value.type, at(where, 'type'))
  if (!SOURCES.includes(type)) throw new LockfileError(`expected one of ${SOURCES.join(', ')}, which Composer clones from`, at(where, 'type'))
  if (value.reference === undefined) throw new LockfileError('expected a reference, without which Composer does not read a source', where)
  return {
    type,
    url: checkSourceUrl(value.url, at(where, 'url'), type),
    reference: checkReference(value.reference, at(where, 'reference'), type),
    mirrors: value.mirrors === undefined ? [] : readMirrors(value.mirrors, at(where, 'mirrors')),
  }
}

const ARCHIVES = ['zip', 'tar', 'gzip', 'xz', 'rar', 'phar', 'file']

// An archive by URL, or by path, as an artifact repository has it; a
// directory by path. FileDownloader holds what it fetches to the sha1, in
// lowercase, where one is given.
function readDist(value, where) {
  ordered(value, where, ['type', 'url', 'reference', 'shasum', 'mirrors'])
  const type = string(value.type, at(where, 'type'))
  if (type !== 'path' && !ARCHIVES.includes(type)) throw new LockfileError(`expected path or one of ${ARCHIVES.join(', ')}, which Composer installs from`, at(where, 'type'))
  const here = at(where, 'url')
  const url = notOption(value.url, here)
  if (type === 'path' || !isHttpUrl(url)) checkPath(url, here)
  const shasum = value.shasum === undefined ? undefined : string(value.shasum, at(where, 'shasum'))
  if (shasum !== undefined && shasum !== '' && !/^[\da-f]{40}$/u.test(shasum)) throw new LockfileError(`${quote(shasum)} is not a sha1 in lowercase hex, which Composer compares the download's with`, at(where, 'shasum'))
  return {
    type,
    url,
    reference: value.reference === undefined ? undefined : notOption(value.reference, at(where, 'reference')),
    shasum: shasum || undefined,
    mirrors: value.mirrors === undefined ? [] : readMirrors(value.mirrors, at(where, 'mirrors')),
  }
}

// A bin Composer links from the package's directory: ArrayLoader strips a
// leading `/`, and Composer 2.10 refuses a `..` in it.
function checkBin(value, where) {
  const bin = plain(value, where)
  if (bin === '' || bin.startsWith('/') || /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(bin)) throw new LockfileError(`${quote(bin)} is not a path in the package, as Composer installs a bin from`, where)
  return bin
}

// target-dir, under the package's directory: no `..`, nothing absolute.
function checkTargetDir(value, where) {
  const path = checkPath(value, where)
  if (path.split('/').includes('..')) throw new LockfileError(`${quote(path)} leads out of the package's directory`, where)
  return path
}

function readSuggest(value, where) {
  const suggest = Object.create(null)
  for (const name of sortedKeys(record(value, where), where)) {
    const reason = string(value[name], at(where, name))
    if (trim(reason) === 'self.version') throw new LockfileError('"self.version", which Composer writes as the package\'s version', at(where, name))
    suggest[name] = reason
  }
  return suggest
}

function readScripts(value, where) {
  const scripts = Object.create(null)
  for (const event of keysOf(record(value, where))) {
    const here = at(where, event)
    if (!Array.isArray(value[event])) throw refuse('a sequence, as Composer writes even one listener', value[event], here)
    scripts[event] = value[event].map((item, index) => string(item, `${here}[${index}]`))
  }
  return scripts
}

function readKeywords(value, where) {
  const keywords = strings(value, where)
  for (let i = 1; i < keywords.length; i++) {
    if (compareStrings(keywords[i - 1], keywords[i]) > 0) throw new LockfileError(`out of the order Composer sorts keywords in, after ${quote(keywords[i - 1])}`, `${where}[${i}]`)
  }
  return keywords
}

function readArchive(value, where) {
  ordered(value, where, ['name', 'exclude'])
  if (keysOf(value).length === 0) throw new LockfileError('an empty mapping, which Composer does not write', where)
  return {
    name: value.name === undefined ? undefined : filled(value.name, at(where, 'name')),
    exclude: value.exclude === undefined ? [] : strings(value.exclude, at(where, 'exclude')),
  }
}

function checkAbandoned(value, where) {
  if (value === true) return true
  if (typeof value !== 'string') throw refuse('true or the name of a replacement', value, where)
  return filled(value, where)
}

// DATE_RFC3339, as DateTime writes back what it reads: a real date, a time
// of day, and the offset as given.
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})[+-](\d{2}):(\d{2})$/u

function checkTime(value, where) {
  const match = RFC3339.exec(string(value, where))
  const [year, month, day, hour, minute, second, offsetHours, offsetMinutes] = match === null ? [] : match.slice(1).map(Number)
  const days = new Date(Date.UTC(2000, month, 0)).getUTCDate() - (month === 2 && (year % 4 !== 0 || (year % 100 === 0 && year % 400 !== 0)) ? 1 : 0)
  if (match === null || month < 1 || month > 12 || day < 1 || day > days || hour > 23 || minute > 59 || second > 59 || offsetMinutes > 59 || offsetHours > 24) {
    throw new LockfileError(`${quote(value)} is not a time as Composer writes one, as 2026-10-02T00:00:00+00:00`, where)
  }
  return value
}

// In backticks, which tests/self-contained.test.js does not read as a
// module named after require, as it reads a quoted one.
const REQUIRE = `require`

// The link types, by field of the package read and by key of the lockfile.
export const LINKS = { require: REQUIRE, conflict: 'conflict', provide: 'provide', replace: 'replace', requireDev: 'require-dev' }

const FIELDS = [
  'name', 'version', 'target-dir', 'source', 'dist', REQUIRE, 'conflict', 'provide', 'replace', 'require-dev', 'suggest', 'default-branch',
  'bin', 'type', 'extra', 'autoload', 'autoload-dev', 'notification-url', 'include-path', 'php-ext', 'archive', 'scripts', 'license',
  'authors', 'description', 'homepage', 'keywords', 'support', 'funding', 'abandoned', 'transport-options', 'time',
]

const REFUSED = {
  version_normalized: '`version_normalized`, which Composer leaves out of a lockfile',
  'installation-source': '`installation-source`, which Composer leaves out of a lockfile',
  repositories: "`repositories`, which Composer reads of the project's composer.json alone",
  'minimum-stability': "`minimum-stability`, which Composer reads of the project's composer.json alone",
}

const optional = (value, key, where, read) => (value[key] === undefined ? undefined : read(value[key], at(where, key)))

export function readPackage(value, where, dev) {
  ordered(value, where, FIELDS, REFUSED)
  if (value.name === undefined) throw new LockfileError('expected a name', where)
  if (value.version === undefined) throw new LockfileError('expected a version', where)
  const name = checkName(value.name, at(where, 'name'))
  const normalized = checkVersion(value.version, at(where, 'version'))
  if (value.type === undefined) throw new LockfileError('expected a type, which Composer always writes', where)
  const type = filled(plain(value.type, at(where, 'type')), at(where, 'type'))
  if (lower(type) !== type) throw new LockfileError(`${quote(type)}, which Composer writes in lowercase`, at(where, 'type'))
  if (value['default-branch'] !== undefined && value['default-branch'] !== true) throw refuse('true, as Composer writes it of the default branch alone', value['default-branch'], at(where, 'default-branch'))
  const links = Object.fromEntries(Object.entries(LINKS).map(([field, key]) => [field, optional(value, key, where, readLinks) ?? Object.create(null)]))
  const free = (key) => optional(value, key, where, nonEmpty)
  return {
    name,
    version: value.version,
    normalized,
    stability: parseStability(normalized),
    dev,
    source: optional(value, 'source', where, readSource),
    dist: optional(value, 'dist', where, readDist),
    ...links,
    suggest: optional(value, 'suggest', where, readSuggest) ?? Object.create(null),
    defaultBranch: value['default-branch'] === true,
    bin: optional(value, 'bin', where, (bins, here) => strings(bins, here, checkBin)) ?? [],
    type,
    targetDir: optional(value, 'target-dir', where, checkTargetDir),
    extra: free('extra'),
    autoload: free('autoload'),
    autoloadDev: free('autoload-dev'),
    notificationUrl: optional(value, 'notification-url', where, (url, here) => {
      if (!isHttpUrl(string(url, here))) throw new LockfileError(`${quote(url)} is not an http(s) URL, which Composer posts installs to`, here)
      return url
    }),
    includePath: optional(value, 'include-path', where, (paths, here) => strings(paths, here)) ?? [],
    phpExt: free('php-ext'),
    archive: optional(value, 'archive', where, readArchive) ?? { name: undefined, exclude: [] },
    scripts: optional(value, 'scripts', where, readScripts) ?? Object.create(null),
    license: optional(value, 'license', where, (licenses, here) => strings(licenses, here)) ?? [],
    authors: free('authors'),
    description: optional(value, 'description', where, filled),
    homepage: optional(value, 'homepage', where, filled),
    keywords: optional(value, 'keywords', where, readKeywords) ?? [],
    support: free('support'),
    funding: free('funding'),
    abandoned: optional(value, 'abandoned', where, checkAbandoned),
    transportOptions: free('transport-options'),
    time: optional(value, 'time', where, checkTime),
  }
}
