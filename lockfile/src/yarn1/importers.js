// yarn.lock names no projects, so their manifests come by directory. A name of
// a workspace with no entry links it, its version not held to the range.

import { LockfileError, at, quote } from '../error.js'
import { checkName, checkRelative, joinRelative } from '../names.js'
import { EMPTY, entries, record, string, text, texts } from '../shape.js'
import { compile, matches } from './glob.js'

export const KINDS = ['dependencies', 'devDependencies', 'optionalDependencies']
export const WHERE = 'manifests'

// yarn's resolveRelative: `file:` and `link:` go from the manifest's directory
// to the lockfile's, keeping `./`; absolute ones are refused, the root unknown.
function fromLockfile(range, dir, where) {
  const prefix = /^(?:file|link):/u.exec(range)?.[0]
  if (prefix === undefined && !range.startsWith('/')) return range
  const path = range.slice(prefix?.length ?? 0)
  if (path.startsWith('/') || /^[A-Za-z]:/u.test(path)) throw new LockfileError(`${quote(range)} is an absolute path`, where)
  const segments = path.split('/').filter((segment) => segment !== '' && segment !== '.')
  const target = checkRelative(joinRelative(dir, segments.length === 0 ? '.' : segments.join('/')), where)
  const dotted = target !== '.' && /^\.(?:\/|$)/u.test(path) && !/^\.{0,2}\//u.test(target)
  return `${prefix}${dotted ? './' : ''}${target}`
}

// yarn drops `//`, a comment, from a dependency list, and keeps a name listed
// twice in one alone.
function readTargets(manifest, dir, where, packages, workspaces) {
  const importer = Object.create(null)
  const listed = new Map()
  for (const kind of KINDS) {
    const targets = Object.create(null)
    for (const [name, range, here] of entries(manifest[kind] ?? EMPTY, at(where, kind))) {
      if (name === '//') continue
      if (listed.has(name)) throw new LockfileError(`listed under ${listed.get(name)} too`, here)
      listed.set(name, kind)
      const pattern = `${checkName(name, here)}@${fromLockfile(string(range, here), dir, here)}`
      if (pattern in packages) targets[name] = pattern
      else if (workspaces.has(name)) targets[name] = `link:${workspaces.get(name)}`
      else throw new LockfileError(`${quote(pattern)} is not a pattern of the lockfile`, here)
    }
    importer[kind] = targets
  }
  return importer
}

// yarn's parsePatternInfo, which ignores a path ending in `/` or `*` or with
// `//`, and resolves the pattern of every other.
function readResolutions(value, where) {
  const rules = []
  for (const [path, range, here] of entries(value ?? EMPTY, where)) {
    if (/\/$|\/{2,}|\*+$/u.test(path)) throw new LockfileError(`${quote(path)} is a path yarn ignores`, here)
    const names = path.match(/(?:@[^/]+\/)?[^/]+/gu) ?? [path]
    const name = checkName(names.at(-1), here)
    rules.push({ path, glob: names.length === 1 ? `**/${path}` : path, name, pattern: `${name}@${string(range, here)}`, where: here })
  }
  return rules
}

// yarn writes no pattern that nothing asks for, a resolution among what asks.
function checkReached(importers, packages, rules) {
  const reached = new Set()
  const installed = new Set()
  const visit = (targets) => {
    for (const target of targets) {
      if (target.startsWith('link:') || reached.has(target)) continue
      reached.add(target)
      installed.add(packages[target])
    }
  }
  visit(rules.map((rule) => rule.pattern).filter((pattern) => pattern in packages))
  for (const importer of Object.values(importers)) for (const kind of KINDS) visit(Object.values(importer[kind]))
  for (const pkg of installed) {
    visit(Object.values(pkg.dependencies))
    visit(Object.values(pkg.optionalDependencies))
  }
  const stray = Object.keys(packages).find((pattern) => !reached.has(pattern))
  if (stray !== undefined) throw new LockfileError('nothing asks for it: no manifest, no package and no resolution', at('', stray))
}

// yarn's extractWorkspaces: globs, or `packages` and `nohoist` lists of them;
// it has workspaces in a private project alone.
function readGlobs(root, where) {
  const value = root.workspaces
  if (value === undefined) return []
  let listAt = at(where, 'workspaces')
  let list = value
  if (!Array.isArray(value)) {
    record(value, listAt, ['packages', 'nohoist'])
    if (value.nohoist !== undefined) texts(value.nohoist, at(listAt, 'nohoist'))
    list = value.packages ?? []
    listAt = at(listAt, 'packages')
  }
  const globs = texts(list, listAt)
  if (globs.length > 0 && root.private !== true) throw new LockfileError('expected true, as yarn has workspaces in a private project alone', at(where, 'private'))
  return globs.map((glob, index) => compile(glob.replace(/^(?:\.\/)+|\/+$/gu, ''), `${listAt}[${index}]`))
}

const TYPOS = {
  __proto__: null,
  depdenencies: 'dependencies', dependancies: 'dependencies', dependecies: 'dependencies', depends: 'dependencies',
  'dev-dependencies': 'devDependencies', devDependences: 'devDependencies', devDepenencies: 'devDependencies', devEependencies: 'devDependencies', devdependencies: 'devDependencies',
}

// yarn reads a workspace that its globs find, outside node_modules, with a
// name and a version; it reads no field of these typos, but warns.
function readWorkspace(dir, manifest, here, globs) {
  for (const typo of Object.keys(TYPOS)) if (Object.hasOwn(manifest, typo)) throw new LockfileError(`a field yarn does not read, for ${quote(TYPOS[typo])}`, at(here, typo))
  if (checkRelative(dir, here) === '.') return undefined
  if (globs.length === 0) throw new LockfileError('expected workspaces, as there are manifests of workspaces', at(at(WHERE, '.'), 'workspaces'))
  if (dir.split('/').includes('node_modules') || !globs.some((tests) => matches(tests, dir))) throw new LockfileError("not a workspace the root's `workspaces` finds", here)
  if (manifest.resolutions !== undefined) throw new LockfileError("a workspace's, which yarn does not read", at(here, 'resolutions'))
  const nameAt = at(here, 'name')
  const name = checkName(string(manifest.name, nameAt), nameAt)
  if (manifest.version === undefined) throw new LockfileError('expected a version, without which yarn ignores the workspace', at(here, 'version'))
  text(manifest.version, at(here, 'version'))
  return name
}

// Also hands resolutions.js the workspaces by name, and the root's resolutions.
export function readImporters(manifests, packages) {
  record(manifests, WHERE)
  const rootAt = at(WHERE, '.')
  const root = manifests['.']
  if (root === undefined) throw new LockfileError('expected the manifest beside the lockfile, "."', WHERE)
  const globs = readGlobs(record(root, rootAt), rootAt)
  const workspaces = new Map()
  for (const [dir, manifest, here] of entries(manifests, WHERE)) {
    const name = readWorkspace(dir, record(manifest, here), here, globs)
    if (name === undefined) continue
    if (workspaces.has(name)) throw new LockfileError(`the name of the workspace ${quote(workspaces.get(name))} too`, at(here, 'name'))
    workspaces.set(name, dir)
  }
  const importers = Object.create(null)
  for (const [dir, manifest, here] of entries(manifests, WHERE)) importers[dir] = readTargets(manifest, dir, here, packages, workspaces)
  const rules = readResolutions(root.resolutions, at(rootAt, 'resolutions'))
  const missing = rules.find((rule) => !(rule.pattern in packages) && !workspaces.has(rule.name))
  if (missing !== undefined) throw new LockfileError(`${quote(missing.pattern)} is not a pattern of the lockfile, where yarn records every resolution's`, missing.where)
  checkReached(importers, packages, rules)
  return { importers, workspaces, rules }
}
