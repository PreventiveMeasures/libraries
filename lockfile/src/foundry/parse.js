import { LockfileError, at, quote } from '../error.js'
import { checkRefName, checkRelative, isCommit, joinRelative, relativeTo } from '../names.js'
import { checkOptions, entries, record, string } from '../shape.js'
import { checkSubmodulePath, findNested, readGitmodules } from './gitmodules.js'
import { readJson } from './json.js'

const OPTIONS = ['gitmodules', 'directory', 'checkUrls']
const TYPES = ['rev', 'tag', 'branch']
const WHERE = 'gitmodules'

// A directory in the repository, from its root, in the form a path in
// .gitmodules has.
function isDirectory(value) {
  try {
    checkRelative(value, '')
  } catch {
    return false
  }
  return !value.split('/').includes('..')
}

function readOptions(options) {
  const { gitmodules, directory = '.', checkUrls = true } = checkOptions(options, OPTIONS)
  if (gitmodules !== undefined && typeof gitmodules !== 'string') throw new TypeError('gitmodules: expected the text of .gitmodules')
  if (gitmodules === undefined && options.directory !== undefined) throw new TypeError('directory needs gitmodules, whose paths it is for')
  if (gitmodules === undefined && options.checkUrls !== undefined) throw new TypeError('checkUrls needs gitmodules, whose urls it is for')
  if (!isDirectory(directory)) throw new TypeError('directory: expected a path in the repository, from its root, as "." or "packages/contracts"')
  if (typeof checkUrls !== 'boolean') throw new TypeError('checkUrls: expected a boolean')
  return { gitmodules, directory, checkUrls }
}

// forge build --locked holds the commit a submodule is at to this, as git
// writes it: a short hash, which forge install writes for `@c93f771`, or any
// other name for a commit, never matches.
function readRev(value, where) {
  if (!isCommit(string(value, where))) throw new LockfileError(`${quote(value)} is not a full commit hash, which forge build --locked compares the submodule's with`, where)
  return value
}

// serde's: `{ "rev": … }` alone, or a tag or branch with the commit it was
// at. forge checks a submodule out by the name of either, and a rev by itself.
function readDependency(value, where) {
  const types = Object.keys(record(value, where, TYPES))
  if (types.length !== 1) throw new LockfileError(`expected one of "rev", "tag" and "branch", found ${types.length === 0 ? 'none' : types.map((type) => quote(type)).join(' and ')}`, where)
  const [type] = types
  if (type === 'rev') return { type, name: undefined, rev: readRev(value.rev, at(where, 'rev')), url: undefined }
  const here = at(where, type)
  const pinned = record(value[type], here, ['name', 'rev'])
  const name = checkRefName(pinned.name, at(here, 'name'))
  return { type, name, rev: readRev(pinned.rev, at(here, 'rev')), url: undefined }
}

// Each dependency is a submodule .gitmodules maps, by its path from the
// lockfile's directory as forge writes it. A submodule it maps that the
// lockfile does not record is let be: git and forge pass over a section
// whose gitlink is gone from the index, which is not read here.
function addUrls(dependencies, gitmodules, directory, checkUrls) {
  const submodules = readGitmodules(gitmodules, WHERE, checkUrls)
  const names = new Map(Object.entries(submodules).map(([name, { path }]) => [path, name]))
  for (const [key, dependency, here] of entries(dependencies, '')) {
    const path = joinRelative(directory, key)
    if (path === '..' || path.startsWith('../')) throw new LockfileError(`outside the repository, from the lockfile's directory ${quote(directory)} in it`, here)
    const written = relativeTo(directory, path)
    if (written !== key) throw new LockfileError(`not as forge writes the path, ${quote(written)}`, here)
    const name = names.get(path)
    if (name === undefined) throw new LockfileError(`no submodule in .gitmodules is at ${quote(path)}`, here)
    dependency.url = submodules[name].url
  }
}

export function parseFoundryLockfile(source, options = {}) {
  if (typeof source !== 'string') throw new TypeError('expected a string')
  const { gitmodules, directory, checkUrls } = readOptions(options)
  const dependencies = Object.create(null)
  for (const [path, value, here] of entries(readJson(source), '')) {
    checkSubmodulePath(path, here)
    dependencies[path] = readDependency(value, here)
  }
  const inside = findNested(Object.keys(dependencies))
  if (inside !== undefined) throw new LockfileError(`inside the dependency ${quote(inside[1])}, whose submodules foundry.lock does not record`, at('', inside[0]))
  if (gitmodules !== undefined) addUrls(dependencies, gitmodules, directory, checkUrls)
  return { dependencies }
}
