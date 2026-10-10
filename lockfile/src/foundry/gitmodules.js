// .gitmodules, by submodule name: where each is in the repository and where
// git fetches it from, held to what git's submodule commands and git config
// read alike, and what they do not ignore with a warning.

import { LockfileError, at, quote } from '../error.js'
import { checkRefName, checkRelative, checkRepo } from '../names.js'
import { checkOptions, field, record } from '../shape.js'
import { readConfig } from './config.js'

const FIELDS = ['path', 'url', 'branch', 'update', 'shallow', 'ignore', 'fetchrecursesubmodules']

// git's git_parse_int: strtoimax's integer in any base it reads, and a unit
// of k, m or g after it, within +/-(2^31 - 1) once multiplied out. Past eleven
// digits no base is within it. A `0b`, which glibc 2.38 and later read in
// base 0 and other C libraries do not, is refused, as git reads it two ways.
const INT = /^[\t\n\v\f\r ]*[+-]?(0[Xx][\dA-Fa-f]+|0[0-7]*|[1-9]\d*)([GKMgkm]?)$/u
const UNIT = { __proto__: null, '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }

function isInt(value) {
  const m = INT.exec(value)
  if (m === null) return false
  const [, digits, unit] = m
  const [radix, body] = /^0[Xx]/u.test(digits) ? [16, digits.slice(2)] : [digits.startsWith('0') ? 8 : 10, digits]
  const significant = body.replace(/^0+/u, '')
  return significant.length <= 11 && Number.parseInt(significant || '0', radix) <= Math.trunc((2 ** 31 - 1) / UNIT[unit.toLowerCase()])
}

// git's git_parse_maybe_bool: true, false and their like in any case, an
// empty one false, or an integer; git dies on anything else. A key alone is
// true. Its case is ASCII's, where a case-insensitive Unicode match would
// take the long s for `s`: no other letter lowercases into these.
const isBoolean = (value) => value === null || /^(?:true|false|yes|no|on|off)?$/u.test(value.toLowerCase()) || isInt(value)
const VALUES = {
  __proto__: null,
  shallow: isBoolean,
  fetchrecursesubmodules: (value) => isBoolean(value) || value === 'on-demand',
  ignore: (value) => ['all', 'dirty', 'untracked', 'none'].includes(value),
  // A new clone is checked out at its commit by any of these; `none` is
  // skipped by git submodule update, and so by forge install, and a command
  // is refused from .gitmodules.
  update: (value) => ['checkout', 'rebase', 'merge'].includes(value),
}

// git's check_submodule_name: a name is a directory under .git/modules.
function checkSubmoduleName(name, where) {
  if (name === '' || name.split(/[/\\]/u).includes('..')) throw new LockfileError('a name git ignores the submodule for, empty or with a ".." in it', where)
  return name
}

// `.git` as NTFS and HFS+ read a name, which git's verify_path refuses in
// a path wherever it runs, as core.protectNTFS is on by default: in any
// case, with spaces and dots after it, as its 8.3 short name `git~1`, or
// with the characters HFS+ ignores in it.
const HFS_IGNORED = /[\u200C-\u200F\u202A-\u202E\u206A-\u206F\uFEFF]/gu
const isDotGit = (segment) => /^(?:\.git|git~1)[ .]*$/u.test(segment.replaceAll(HFS_IGNORED, '').toLowerCase())

// Below the repository's root, `.git` none of its directories; git ignores
// one that starts with "-".
export function checkSubmodulePath(value, where) {
  const path = checkRelative(value, where)
  const segments = path.split('/')
  if (path === '.' || segments.at(-1) === '..') throw new LockfileError(`${quote(path)} is no submodule's path, but a directory it would be in`, where)
  if (segments.some(isDotGit)) throw new LockfileError(`${quote(path)} is in a ".git", where git writes no submodule`, where)
  if (path.startsWith('-')) throw new LockfileError(`${quote(path)} starts with "-", which git ignores the path for`, where)
  return path
}

// Where git fetches from: a URL of a host, or scp's `user@host:path`, which
// git tells from a path by a colon before any slash, the host anything up to
// it, an ssh config's alias too, or in brackets where it has a colon, as an
// IPv6 address does. Not a path on the machine that clones, or one relative
// to the superproject's remote, which only its clone knows.
const SCHEME = /^(?:https?|ssh|git|git\+ssh|ssh\+git):\/\/[^/]/u
const SCP = /^(?:[^@/:\\]+@)?(?:\[[^\]/\\]+\]|[^@/:\\[\]]+):(?!:|\/\/)/u
// git on Windows reads one character and a colon, `x:path`, as a path on
// the drive x:, and elsewhere as the host x; `user@x:path` is the host to
// both, and so is `[` and a colon, which the path after makes no path.
const DRIVE = /^[^[]:(?!:)/u

// What git takes for a url at all, of a host or not.
function readUrl(value, where) {
  if (typeof value === 'string' && value.startsWith('-')) throw new LockfileError(`${quote(value)} starts with "-", which git ignores the url for`, where)
  return checkRepo(value, where)
}

function checkUrl(value, where) {
  const url = readUrl(value, where)
  if (DRIVE.test(url)) throw new LockfileError(`${quote(url)} is a path on a drive to git on Windows, and a host's to git elsewhere`, where)
  if (SCHEME.test(url) ? URL.canParse(url) : SCP.test(url) && !url.includes('\\')) return url
  if (/^\.\.?\//u.test(url)) throw new LockfileError(`${quote(url)} is relative to the superproject's remote, which only a clone of it knows`, where)
  throw new LockfileError(`${quote(url)} is not a URL of a host that git fetches from: http(s), ssh, git, or user@host:path`, where)
}

// One header for each submodule, and a key once in it: git's submodule
// commands read the first of two, git config the last. `where` is '' for
// .gitmodules alone, and `file` undefined then too.
function group(entries, where, file) {
  const submodules = new Map()
  for (const { section, subsection, header, key, value, line } of entries) {
    if (section === undefined) throw new LockfileError(`a key outside any section, at line ${line + 1}`, file)
    if (section !== 'submodule' || subsection === undefined) {
      const form = section.startsWith('submodule.') ? 'the form [submodule.name], whose name git lowercases,' : `[${section}${subsection === undefined ? '' : ` "${subsection}"`}]`
      throw new LockfileError(`a section of ${form} where .gitmodules has [submodule "name"] alone, at line ${header + 1}`, file)
    }
    const here = at(where, subsection)
    checkSubmoduleName(subsection, here)
    const submodule = submodules.get(subsection) ?? submodules.set(subsection, { header, fields: Object.create(null) }).get(subsection)
    if (submodule.header !== header) throw new LockfileError(`a second section, at line ${header + 1}, where git writes one`, here)
    if (key in submodule.fields) throw new LockfileError(`twice, of which git's submodule commands read the first and git config the last, at line ${line + 1}`, at(here, key))
    submodule.fields[key] = value
  }
  return submodules
}

function readSubmodule(fields, where, checkUrls) {
  record(fields, where, FIELDS)
  for (const key of ['path', 'url', 'branch', 'update', 'ignore']) {
    if (fields[key] === null) throw new LockfileError('a key alone, where git expects a value', at(where, key))
  }
  for (const key of Object.keys(VALUES)) {
    if (key in fields && !VALUES[key](fields[key])) throw new LockfileError(`${quote(fields[key])} is not a value git reads here`, at(where, key))
  }
  if (fields.path === undefined) throw new LockfileError('expected a path, without which git has no submodule', at(where, 'path'))
  if (fields.url === undefined && checkUrls) throw new LockfileError('expected a url, without which git cannot clone the submodule', at(where, 'url'))
  const path = checkSubmodulePath(fields.path, at(where, 'path'))
  if (path.startsWith('../')) throw new LockfileError(`${quote(path)} is outside the repository, where git writes no submodule`, at(where, 'path'))
  const url = field(fields, 'url', where, checkUrls ? checkUrl : readUrl)
  // `.` is git's for the superproject's own branch.
  const branch = fields.branch === undefined || fields.branch === '.' ? fields.branch : checkRefName(fields.branch, at(where, 'branch'))
  return { path, url, branch }
}

// A path inside another, and that other; `..` and the like are no paths.
export function findNested(paths) {
  const seen = new Set(paths)
  for (const path of paths) {
    const segments = path.split('/')
    for (let i = 1; i < segments.length; i++) {
      const outer = segments.slice(0, i).join('/')
      if (seen.has(outer) && outer !== '..' && !outer.endsWith('/..')) return [path, outer]
    }
  }
  return undefined
}

export function readGitmodules(text, where, checkUrls) {
  const file = where === '' ? undefined : where
  const submodules = Object.create(null)
  const paths = new Map()
  for (const [name, { fields }] of group(readConfig(text, file), where, file)) {
    const here = at(where, name)
    const submodule = readSubmodule(fields, here, checkUrls)
    if (paths.has(submodule.path)) throw new LockfileError(`the path of the submodule ${quote(paths.get(submodule.path))} too`, at(here, 'path'))
    paths.set(submodule.path, name)
    submodules[name] = submodule
  }
  const inside = findNested([...paths.keys()])
  if (inside !== undefined) throw new LockfileError(`inside the submodule ${quote(paths.get(inside[1]))}, at ${quote(inside[1])}`, at(at(where, paths.get(inside[0])), 'path'))
  return submodules
}

export function parseGitmodules(text, options = {}) {
  if (typeof text !== 'string') throw new TypeError('expected a string')
  const { checkUrls = true } = checkOptions(options, ['checkUrls'])
  if (typeof checkUrls !== 'boolean') throw new TypeError('checkUrls: expected a boolean')
  return readGitmodules(text, '', checkUrls)
}
