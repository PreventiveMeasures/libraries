// .gitmodules, by submodule name: where each is in the repository and where
// git fetches it from, held to what git's submodule commands and git config
// read alike, and what they do not ignore with a warning.

import { LockfileError, at, quote } from '../error.js'
import { checkRefName, checkRelative, checkRepo } from '../names.js'
import { readConfig } from './config.js'

const FIELDS = new Set(['path', 'url', 'branch', 'update', 'shallow', 'ignore', 'fetchrecursesubmodules'])

// git reads these as true, false or an integer, and dies on anything else;
// a key alone is true.
const BOOLEAN = /^(?:true|false|yes|no|on|off|-?\d+)?$/iu
const isBoolean = (value) => value === null || BOOLEAN.test(value)
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
function checkName(name, where) {
  if (name === '' || name.split(/[/\\]/u).includes('..')) throw new LockfileError('a name git ignores the submodule for, empty or with a ".." in it', where)
  return name
}

// Below the repository's root, `.git` none of its directories; git ignores
// one that starts with "-".
export function checkSubmodulePath(value, where) {
  const path = checkRelative(value, where)
  const segments = path.split('/')
  if (path === '.' || segments.at(-1) === '..') throw new LockfileError(`${quote(path)} is no submodule's path, but a directory it would be in`, where)
  if (segments.some((segment) => segment.toLowerCase() === '.git')) throw new LockfileError(`${quote(path)} is in a ".git", where git writes no submodule`, where)
  if (path.startsWith('-')) throw new LockfileError(`${quote(path)} starts with "-", which git ignores the path for`, where)
  return path
}

// Where git fetches from: a URL of a host, or scp's `user@host:path`. Not a
// path on the machine that clones, or one relative to the superproject's
// remote, which only its clone knows; git ignores one that starts with "-".
const SCHEME = /^(?:https?|ssh|git|git\+ssh|ssh\+git):\/\/[^/]/u
const SCP = /^(?:[^@/:\\]+@)?[\dA-Za-z][\dA-Za-z.-]+:(?!:|\/\/)/u

function checkUrl(value, where) {
  const url = checkRepo(value, where)
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
    const here = at(where, checkName(subsection, at(where, subsection)))
    const submodule = submodules.get(subsection) ?? submodules.set(subsection, { header, fields: Object.create(null) }).get(subsection)
    if (submodule.header !== header) throw new LockfileError(`a second section, at line ${header + 1}, where git writes one`, here)
    if (!FIELDS.has(key)) throw new LockfileError(`unsupported field ${quote(key)}`, here)
    if (key in submodule.fields) throw new LockfileError(`twice, of which git's submodule commands read the first and git config the last, at line ${line + 1}`, at(here, key))
    submodule.fields[key] = value
  }
  return submodules
}

function readSubmodule(fields, where) {
  for (const key of ['path', 'url', 'branch', 'update', 'ignore']) {
    if (fields[key] === null) throw new LockfileError('a key alone, where git expects a value', at(where, key))
  }
  for (const key of Object.keys(VALUES)) {
    if (key in fields && !VALUES[key](fields[key])) throw new LockfileError(`${quote(fields[key])} is not a value git reads here`, at(where, key))
  }
  if (fields.path === undefined) throw new LockfileError('expected a path, without which git has no submodule', at(where, 'path'))
  if (fields.url === undefined) throw new LockfileError('expected a url, without which git cannot clone the submodule', at(where, 'url'))
  const path = checkSubmodulePath(fields.path, at(where, 'path'))
  if (path.startsWith('../')) throw new LockfileError(`${quote(path)} is outside the repository, where git writes no submodule`, at(where, 'path'))
  const url = checkUrl(fields.url, at(where, 'url'))
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

export function readGitmodules(text, where) {
  const file = where === '' ? undefined : where
  const submodules = Object.create(null)
  const paths = new Map()
  for (const [name, { fields }] of group(readConfig(text, file), where, file)) {
    const here = at(where, name)
    const submodule = readSubmodule(fields, here)
    if (paths.has(submodule.path)) throw new LockfileError(`the path of the submodule ${quote(paths.get(submodule.path))} too`, at(here, 'path'))
    paths.set(submodule.path, name)
    submodules[name] = submodule
  }
  const inside = findNested([...paths.keys()])
  if (inside !== undefined) throw new LockfileError(`inside the submodule ${quote(paths.get(inside[1]))}, at ${quote(inside[1])}`, at(at(where, paths.get(inside[0])), 'path'))
  return submodules
}

export function parseGitmodules(text) {
  if (typeof text !== 'string') throw new TypeError('expected a string')
  return readGitmodules(text, '')
}
