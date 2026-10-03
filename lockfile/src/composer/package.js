// One package of a composer.lock, as Locker::lockPackages writes it: what
// ArrayDumper makes of the package ArrayLoader reads from it, less its
// version_normalized and installation-source, its time moved last. A field
// is refused where Composer would write it back otherwise, or would not
// read it: a string where a list goes, an empty value, a key out of order,
// a version or a constraint it does not parse. Paths are relative and URLs
// held to their kind; what Composer only passes on is handed back as
// written.

import { LockfileError, at, quote } from '../error.js'
import { checkRefName, checkRelative, checkRemote, isCommit, isHexSha1, isHttpUrlAnyCase } from '../names.js'
import { boolean, field, isMapping, record, refuse, string } from '../shape.js'
import { keysOf } from './json.js'
import { compareKeys, compareStrings, empty, lower, trim } from './php.js'
import { normalize, parseConstraints, parseStability } from './semver.js'

// A mapping's entries in the file's order, each with where it is. An empty
// one is not read here: json.js refuses `{}` below the top.
export const entriesOf = (value, where) => keysOf(value).map((key) => [key, value[key], at(where, key)])

// A mapping with the `fields` named alone, each in its place in them;
// `where` undefined for the top of the file.
export function ordered(value, where, fields, refused = {}) {
  record(value, where)
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

// What Composer reads only where PHP's empty() is false of it, which is of
// "0" too, and so writes no other way.
function filled(value, where) {
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
  if (Array.isArray(value) ? value.length === 0 : !isMapping(value)) throw refuse('a non-empty mapping or sequence', value, where)
  return value
}

const list = (value, where) => {
  if (!Array.isArray(value)) throw refuse('a sequence', value, where)
  if (value.length === 0) throw new LockfileError('an empty sequence, which Composer does not write', where)
  return value
}

const strings = (value, where, check = string) => list(value, where).map((item, index) => check(item, `${where}[${index}]`))

// Keys as ksort leaves them; `by` says whose sort it is.
export function sortedKeys(value, where, by = 'Composer sorts the keys in') {
  const keys = keysOf(value)
  for (let i = 1; i < keys.length; i++) {
    if (compareKeys(keys[i - 1], keys[i]) > 0) throw new LockfileError(`out of the order ${by}, after ${quote(keys[i - 1])}`, at(where, keys[i]))
  }
  return keys
}

// A version as a package is locked at: one Composer normalizes, as a tag
// or a branch names it, with no alias, stability flag or space about it.
function checkVersion(value, where) {
  const version = plain(value, where)
  const normalized = /\s|@(?:stable|rc|beta|alpha|dev)$/u.test(lower(version)) || version === '0' ? undefined : normalize(version)
  if (normalized === undefined) throw new LockfileError(`${quote(version)} is not a version Composer locks a package at`, where)
  return normalized
}

// Any version Composer reads, as an alias or the root's is: normalized.
export function readVersion(value, where) {
  const normalized = normalize(plain(value, where))
  if (normalized === undefined) throw new LockfileError(`${quote(value)} is not a version Composer reads`, where)
  return normalized
}

// A constraint as ArrayLoader::createLink parses it, `self.version` being
// `version`, as written, of the package that has it.
export function readConstraint(value, where, version) {
  const self = plain(value, where) === 'self.version'
  const parsed = parseConstraints(self ? version : value)
  if (parsed !== undefined) return parsed
  throw new LockfileError(self ? `"self.version", which is ${quote(version)}, and not a version constraint Composer reads` : `${quote(value)} is not a version constraint Composer reads`, where)
}

// A name as ValidatingArrayLoader::hasPackageNamingError takes one, which
// Composer 2.10 holds every package it installs to: a vendor and a
// package, capitals let be, as Composer goes by the name in lowercase.
// Composer's caseless regexes are of ASCII alone, as PCRE's without /u:
// here, of the name as strtolower lowers it, as JavaScript's `iu` would
// take ſ for s, and the Kelvin sign for k.
const NAME = /^[a-z0-9](?:[_.-]?[a-z0-9]+)*\/[a-z0-9](?:(?:[_.]|-{1,2})?[a-z0-9]+)*$/u
const RESERVED = new Set(['nul', 'con', 'prn', 'aux', ...['com', 'lpt'].flatMap((device) => Array.from({ length: 9 }, (_, i) => `${device}${i + 1}`))])

export function checkName(value, where) {
  const name = string(value, where)
  if (!NAME.test(lower(name))) throw new LockfileError(`${quote(name)} is not a package name, a vendor and a package as Composer takes them`, where)
  if (lower(name).split('/').some((part) => RESERVED.has(part))) throw new LockfileError(`${quote(name)} has a name Windows reserves in it, which Composer refuses`, where)
  if (name.endsWith('.json')) throw new LockfileError(`${quote(name)} ends in .json, which Composer refuses`, where)
  return name
}

// A link's target, lowercased as ArrayLoader lowers it, of the characters
// ValidatingArrayLoader takes in one.
const TARGET = /^[a-z0-9_./-]+$/u

const PLATFORM = /^(?:php(?:-64bit|-ipv6|-zts|-debug)?|hhvm|(?:ext|lib)-[a-z0-9](?:[_.-]?[a-z0-9]+)*|composer(?:-(?:plugin|runtime)-api)?)$/u

export const isPlatform = (name) => PLATFORM.test(lower(name))

// The links of one type, as written, by target, and as Composer parses
// them, `{ target, pretty, constraint }`.
function readLinks(value, where, version) {
  const written = Object.create(null)
  sortedKeys(record(value, where), where)
  const links = entriesOf(value, where).map(([target, pretty, here]) => {
    if (!TARGET.test(target)) throw new LockfileError(`${quote(target)} is not a package name in lowercase, as Composer writes a link's`, here)
    const constraint = readConstraint(pretty, here, version)
    written[target] = pretty
    return { target, pretty, constraint }
  })
  return { written, links }
}

// A path from the lockfile's directory, as Composer writes the one it was
// given: `./` in front or not.
function checkPath(value, where) {
  const path = plain(value, where)
  if (path.startsWith('/') || /^[A-Za-z]:/u.test(path)) throw new LockfileError(`${quote(path)} is an absolute path, of the machine the lockfile was written on`, where)
  // Not a path to Filesystem::isLocalPath, and opened by a stream wrapper
  // of PHP's: `data:`, `phar:`, `ftp:`.
  const scheme = /^[A-Za-z][\d+.A-Za-z-]*:/u.exec(path)
  if (scheme !== null) throw new LockfileError(`${quote(path)} is a URL, of ${scheme[0]}, and not a path`, where)
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
  fossil: ['https:', 'http:', 'ssh:'],
}

// P4PORT as Perforce::isValidPort takes it: `[tcp|ssl:][host:]port`, where
// `rsh:` and `jsh:` would run a command.
const P4PORT = /^(?:(?:tcp|ssl)(?:4|6|46|64)?:)?(?:\[[0-9a-f:.]+\]|[a-z0-9._][a-z0-9._-]*)(?::[a-z0-9._][a-z0-9._-]*)?$/u

// git's scp form, `[user@]host:path`, which git reaches over ssh where no
// `://` is in it and a `:` comes before any `/`, but of a drive letter.
const SCP = /^([\w.-]+@)?([\w.-]+):[^\s]/u

// A repository to clone: a URL of a scheme its tool fetches over, git's
// scp form, or a path from the lockfile's directory, which its tool reads
// as nothing but a place. An absolute path, or a file: URL, is of the
// machine the lockfile was written on.
function checkSourceUrl(value, where, type) {
  const url = notOption(value, where)
  if (type === 'perforce') {
    const port = lower(url)
    if (!P4PORT.test(port) || /^\s*(?:rsh|jsh)\s*:/u.test(port)) throw new LockfileError(`${quote(url)} is not a Perforce port, [tcp|ssl:][host:]port, as Composer takes one`, where)
    return url
  }
  checkRemote(url, where)
  const scp = type === 'git' && !url.includes('://') && !/^[A-Za-z]:/u.test(url) ? SCP.exec(url) : null
  if (scp !== null) {
    // `file:/srv/x`, of the host file to git, is a file: URL to a parser.
    if (scp[1] === undefined && /^(?:file|https?|ssh|git|ftps?)$/u.test(lower(scp[2]))) throw new LockfileError(`${quote(url)} is of the host ${scp[2]} to git, and a URL of ${lower(scp[2])}: to a URL parser`, where)
    return url
  }
  if (/^[A-Za-z][\d+.A-Za-z-]*:/u.test(url)) {
    const parsed = URL.parse(url)
    if (parsed === null || !REMOTE[type].includes(parsed.protocol) || /\s/u.test(url)) throw new LockfileError(`${quote(url)} is not a URL ${type} fetches from, ${REMOTE[type].join(' ')}`, where)
    return url
  }
  return checkPath(url, where)
}

function checkReference(value, where, type) {
  const reference = notOption(value, where)
  if (type === 'git' && !isCommit(reference)) checkRefName(reference, where)
  return reference
}

// A mirror Composer tries before or after the URL, Package::getUrls, held
// to what the URL is held to, `check`, as it stands in for it.
function readMirrors(value, where, check) {
  return list(value, where).map((item, index) => {
    const here = `${where}[${index}]`
    ordered(item, here, ['url', 'preferred'])
    const preferred = boolean(item.preferred, at(here, 'preferred'))
    return { url: check(item.url, at(here, 'url')), preferred }
  })
}

const SOURCES = ['git', 'hg', 'svn', 'fossil', 'perforce']

function readSource(value, where) {
  ordered(value, where, ['type', 'url', 'reference', 'mirrors'])
  const type = string(value.type, at(where, 'type'))
  if (!SOURCES.includes(type)) throw new LockfileError(`expected one of ${SOURCES.join(', ')}, which Composer clones from`, at(where, 'type'))
  if (value.reference === undefined) throw new LockfileError('expected a reference, without which Composer does not read a source', where)
  const check = (url, here) => checkSourceUrl(url, here, type)
  return {
    type,
    url: check(value.url, at(where, 'url')),
    reference: checkReference(value.reference, at(where, 'reference'), type),
    mirrors: field(value, 'mirrors', where, (mirrors, here) => readMirrors(mirrors, here, check)) ?? [],
  }
}

const ARCHIVES = ['zip', 'tar', 'gzip', 'xz', 'rar', 'phar', 'file']

// A dist's URL, or its mirror's: an http(s) one, of its scheme in any case,
// as HttpDownloader fetches it, but of a path dist, or a path.
function checkDistUrl(value, where, type) {
  const url = notOption(value, where)
  if (type === 'path' || !isHttpUrlAnyCase(url)) checkPath(url, where)
  return url
}

// An archive by URL, or by path, as an artifact repository has it; a
// directory by path. FileDownloader holds what it fetches to the sha1, in
// lowercase, where one is given.
function readDist(value, where) {
  ordered(value, where, ['type', 'url', 'reference', 'shasum', 'mirrors'])
  const type = string(value.type, at(where, 'type'))
  if (type !== 'path' && !ARCHIVES.includes(type)) throw new LockfileError(`expected path or one of ${ARCHIVES.join(', ')}, which Composer installs from`, at(where, 'type'))
  const check = (url, here) => checkDistUrl(url, here, type)
  const shasum = field(value, 'shasum', where, string)
  if (shasum !== undefined && shasum !== '' && !isHexSha1(shasum)) throw new LockfileError(`${quote(shasum)} is not a sha1 in lowercase hex, which Composer compares the download's with`, at(where, 'shasum'))
  return {
    type,
    url: check(value.url, at(where, 'url')),
    reference: field(value, 'reference', where, notOption),
    shasum: shasum || undefined,
    mirrors: field(value, 'mirrors', where, (mirrors, here) => readMirrors(mirrors, here, check)) ?? [],
  }
}

// A bin Composer links from the package's directory: ArrayLoader strips a
// leading `/`, Composer 2.10 refuses a `..` in it, and on Windows one from
// a drive, `C:\x`, or a share, `\\server\x`, is out of the package too.
function checkBin(value, where) {
  const bin = plain(value, where)
  if (bin === '' || /^(?:[\\/]|[A-Za-z]:)/u.test(bin) || /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(bin)) throw new LockfileError(`${quote(bin)} is not a path in the package, as Composer installs a bin from`, where)
  return bin
}

// Package::getTargetDir: each `.` and `..` segment dropped, and a leading
// `/`, so that the directory is under the package's.
const targetDirOf = (dir) => dir.replace(/(?:^|[\\/]+)\.\.?(?:[\\/]+|$)(?:\.\.?(?:[\\/]+|$))*/gu, '/').replace(/^\/+/u, '')

// target-dir as Composer writes it, of getTargetDir: empty for the
// package's directory itself, `.`, which Composer 2.7 and later write. A
// `\` is a separator to getTargetDir, as to Windows, where one that leads
// is of the drive's root: a path of either, under the package's directory.
function checkTargetDir(value, where) {
  const dir = plain(value, where)
  if (targetDirOf(dir) !== dir) throw new LockfileError(`${quote(dir)} is not written as Composer writes a target-dir, ${quote(targetDirOf(dir))}`, where)
  if (dir.startsWith('\\')) throw new LockfileError(`${quote(dir)} is of the drive's root on Windows, and not under the package's directory`, where)
  if (dir !== '') checkPath(dir.replaceAll('\\', '/'), where)
  return dir
}

function readSuggest(value, where) {
  const suggest = Object.create(null)
  sortedKeys(record(value, where), where)
  for (const [name, reason, here] of entriesOf(value, where)) {
    if (trim(string(reason, here)) === 'self.version') throw new LockfileError('"self.version", which Composer writes as the package\'s version', here)
    suggest[name] = reason
  }
  return suggest
}

function readScripts(value, where) {
  const scripts = Object.create(null)
  for (const [event, listeners, here] of entriesOf(record(value, where), where)) {
    if (!Array.isArray(listeners)) throw refuse('a sequence, as Composer writes even one listener', listeners, here)
    scripts[event] = listeners.map((item, index) => string(item, `${here}[${index}]`))
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
  return { name: field(value, 'name', where, filled), exclude: field(value, 'exclude', where, strings) ?? [] }
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

// The link types, by field of the package read and by key of the lockfile.
export const LINKS = { require: 'require', conflict: 'conflict', provide: 'provide', replace: 'replace', requireDev: 'require-dev' }

const FIELDS = [
  'name', 'version', 'target-dir', 'source', 'dist', 'require', 'conflict', 'provide', 'replace', 'require-dev', 'suggest', 'default-branch',
  'bin', 'type', 'extra', 'autoload', 'autoload-dev', 'notification-url', 'include-path', 'php-ext', 'archive', 'scripts', 'license',
  'authors', 'description', 'homepage', 'keywords', 'support', 'funding', 'abandoned', 'transport-options', 'time',
]

const REFUSED = {
  version_normalized: '`version_normalized`, which Composer leaves out of a lockfile',
  'installation-source': '`installation-source`, which Composer leaves out of a lockfile',
  repositories: "`repositories`, which Composer reads of the project's composer.json alone",
  'minimum-stability': "`minimum-stability`, which Composer reads of the project's composer.json alone",
}

// The package, and its links as Composer parses them, by field.
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
  const read = Object.entries(LINKS).map(([property, key]) => [property, field(value, key, where, (links, here) => readLinks(links, here, value.version)) ?? { written: Object.create(null), links: [] }])
  const free = (key) => field(value, key, where, nonEmpty)
  const pkg = {
    name,
    version: value.version,
    normalized,
    stability: parseStability(normalized),
    dev,
    source: field(value, 'source', where, readSource),
    dist: field(value, 'dist', where, readDist),
    ...Object.fromEntries(read.map(([property, { written }]) => [property, written])),
    suggest: field(value, 'suggest', where, readSuggest) ?? Object.create(null),
    defaultBranch: value['default-branch'] === true,
    bin: field(value, 'bin', where, (bins, here) => strings(bins, here, checkBin)) ?? [],
    type,
    targetDir: field(value, 'target-dir', where, checkTargetDir),
    extra: free('extra'),
    autoload: free('autoload'),
    autoloadDev: free('autoload-dev'),
    notificationUrl: field(value, 'notification-url', where, (url, here) => {
      if (!isHttpUrlAnyCase(string(url, here))) throw new LockfileError(`${quote(url)} is not an http(s) URL, which Composer posts installs to`, here)
      return url
    }),
    includePath: field(value, 'include-path', where, strings) ?? [],
    phpExt: free('php-ext'),
    archive: field(value, 'archive', where, readArchive) ?? { name: undefined, exclude: [] },
    scripts: field(value, 'scripts', where, readScripts) ?? Object.create(null),
    license: field(value, 'license', where, strings) ?? [],
    authors: free('authors'),
    description: field(value, 'description', where, filled),
    homepage: field(value, 'homepage', where, filled),
    keywords: field(value, 'keywords', where, readKeywords) ?? [],
    support: free('support'),
    funding: free('funding'),
    abandoned: field(value, 'abandoned', where, checkAbandoned),
    transportOptions: free('transport-options'),
    time: field(value, 'time', where, checkTime),
  }
  return { pkg, links: Object.fromEntries(read.map(([property, { links }]) => [property, links])) }
}
