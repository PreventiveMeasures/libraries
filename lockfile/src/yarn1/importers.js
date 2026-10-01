// yarn.lock names no projects, so their manifests come by directory. A name of
// a workspace with no entry links it, held to the range only with semver.

import { LockfileError, at, quote } from '../error.js'
import { KINDS, reach } from '../graph.js'
import { checkName, checkRelative, isName } from '../names.js'
import { EMPTY, entries, record, string, text, texts } from '../shape.js'
import { compile, matches } from './glob.js'
import { isRange, resolvePath, sourceOf } from './packages.js'

export const WHERE = 'manifests'

// yarn's resolveRelative: `file:` and `link:` go from the manifest's directory
// to the lockfile's, keeping `./`; absolute ones are refused, the root unknown.
function fromLockfile(range, dir, where) {
  const prefix = /^(?:file|link):/u.exec(range)?.[0]
  if (prefix === undefined && !range.startsWith('/')) return range
  const path = range.slice(prefix?.length ?? 0)
  if (path.startsWith('/') || /^[A-Za-z]:/u.test(path)) throw new LockfileError(`${quote(range)} is an absolute path`, where)
  const target = checkRelative(resolvePath(dir, path), where)
  const dotted = target !== '.' && /^\.(?:\/|$)/u.test(path) && !/^\.{0,2}\//u.test(target)
  return `${prefix}${dotted ? './' : ''}${target}`
}

// Whether yarn links a workspace for a range, as it does where its version
// satisfies the range; without semver, known of that very version alone.
function links(workspace, range, semver) {
  if (semver !== undefined) return semver.satisfies(workspace.version, range, { loose: true })
  return workspace.version === range ? true : undefined
}

// yarn writes no entry for what it links.
function checkLinked({ name, range, pattern, where }, workspaces, semver) {
  const workspace = workspaces.get(name)
  if (workspace !== undefined && links(workspace, range, semver) === true) {
    throw new LockfileError(`${quote(pattern)} is satisfied by the workspace ${quote(workspace.dir)}, which yarn links instead`, where)
  }
}

// A request with no entry is for a workspace, which only the manifests name.
export function linkWorkspace({ name, range, pattern, where }, workspaces, semver) {
  const workspace = workspaces?.get(name)
  if (workspace === undefined) throw new LockfileError(`${quote(pattern)} is not a pattern of the lockfile${workspaces === undefined ? ", nor a workspace's, as only the manifests may say" : ''}`, where)
  if (links(workspace, range, semver) === false) {
    throw new LockfileError(`${quote(pattern)} is not a pattern of the lockfile, nor satisfied by the workspace ${quote(workspace.dir)}, ${workspace.version}`, where)
  }
  return `link:${workspace.dir}`
}

// What a request leads to: its entry, or the workspace yarn links for it.
function resolveRequest(request, { packages, workspaces, semver }) {
  if (!(request.pattern in packages)) return linkWorkspace(request, workspaces, semver)
  checkLinked(request, workspaces, semver)
  return request.pattern
}

// yarn drops `//`, a comment, from a dependency list, and keeps a name listed
// twice in one alone.
function readTargets(manifest, dir, where, context) {
  const importer = Object.create(null)
  const listed = new Map()
  for (const kind of KINDS) {
    const targets = Object.create(null)
    for (const [name, range, here] of entries(manifest[kind] ?? EMPTY, at(where, kind))) {
      if (name === '//') continue
      if (listed.has(name)) throw new LockfileError(`listed under ${listed.get(name)} too`, here)
      listed.set(name, kind)
      const target = fromLockfile(string(range, here), dir, here)
      targets[name] = resolveRequest({ name, range: target, pattern: `${checkName(name, here)}@${target}`, where: here }, context)
    }
    importer[kind] = targets
  }
  return importer
}

// yarn's parsePatternInfo, which ignores a path ending in `/` or `*` or with
// `//`, and a range that is neither a semver range nor a source, a tag or
// an `npm:` alias among them, and resolves the pattern of every other. A
// `//` is a comment, which yarn drops before. Without semver, a range is
// told from a tag by its form alone.
function readResolutions(value, where, semver) {
  const rules = []
  for (const [path, range, here] of entries(value ?? EMPTY, where)) {
    if (path === '//') continue
    if (/\/$|\/{2,}|\*+$/u.test(path)) throw new LockfileError(`${quote(path)} is a path yarn ignores`, here)
    const names = path.match(/(?:@[^/]+\/)?[^/]+/gu) ?? [path]
    const tests = compile(names.length === 1 ? `**/${path}` : path, here)
    const name = checkName(names.at(-1), here)
    const other = names.slice(0, -1).find((segment) => segment !== '**' && !isName(segment.replaceAll(/[*?]/gu, 'x')))
    if (other !== undefined) throw new LockfileError(`${quote(other)} is not a package name, or a glob of one`, here)
    const target = string(range, here)
    if (sourceOf(target) === 'registry' && !isRange(target, semver)) throw new LockfileError(`${quote(target)} is a range yarn ignores in a resolution: neither a semver range nor a source`, here)
    rules.push({ path, tests, name, range: target, pattern: `${name}@${target}`, where: here })
  }
  return rules
}

// yarn writes no pattern that nothing asks for, a resolution among what asks.
function checkReached(importers, packages, rules) {
  const starts = Object.values(importers).flatMap((importer) => KINDS.map((kind) => importer[kind]))
  const reached = reach([rules.map((rule) => rule.pattern).filter((pattern) => pattern in packages), ...starts], packages)
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

// Without semver, a manifest's version, which yarn cleans loosely, is held to
// semver's length and characters alone.
const LOOSE = /^[\s\dA-Za-z.+=-]{1,256}$/u

function readVersion(value, where, semver) {
  const version = text(value, where)
  if (!LOOSE.test(version)) throw new LockfileError(`${quote(version)} is not a version`, where)
  if (semver === undefined) return version
  const clean = semver.clean(version, { loose: true })
  if (clean === null) throw new LockfileError(`${quote(version)} is not a version semver reads`, where)
  return clean
}

// yarn reads a workspace that its globs find, outside node_modules, with a
// name and a version; it reads no field of these typos, but warns.
function readWorkspace(dir, manifest, here, globs, semver) {
  for (const typo of Object.keys(TYPOS)) if (Object.hasOwn(manifest, typo)) throw new LockfileError(`a field yarn does not read, for ${quote(TYPOS[typo])}`, at(here, typo))
  if (checkRelative(dir, here) === '.') return undefined
  if (globs.length === 0) throw new LockfileError('expected workspaces, as there are manifests of workspaces', at(at(WHERE, '.'), 'workspaces'))
  if (dir.split('/').includes('node_modules') || !globs.some((tests) => matches(tests, dir))) throw new LockfileError("not a workspace the root's `workspaces` finds", here)
  if (manifest.resolutions !== undefined) throw new LockfileError("a workspace's, which yarn does not read", at(here, 'resolutions'))
  const nameAt = at(here, 'name')
  const name = checkName(string(manifest.name, nameAt), nameAt)
  if (manifest.version === undefined) throw new LockfileError('expected a version, without which yarn ignores the workspace', at(here, 'version'))
  return { name, dir, version: readVersion(manifest.version, at(here, 'version'), semver) }
}

// Also hands resolutions.js the workspaces by name, and the root's resolutions.
export function readImporters(manifests, packages, requests, semver) {
  record(manifests, WHERE)
  const rootAt = at(WHERE, '.')
  const root = manifests['.']
  if (root === undefined) throw new LockfileError('expected the manifest beside the lockfile, "."', WHERE)
  const globs = readGlobs(record(root, rootAt), rootAt)
  const workspaces = new Map()
  for (const [dir, manifest, here] of entries(manifests, WHERE)) {
    const workspace = readWorkspace(dir, record(manifest, here), here, globs, semver)
    if (workspace === undefined) continue
    if (workspaces.has(workspace.name)) throw new LockfileError(`the name of the workspace ${quote(workspaces.get(workspace.name).dir)} too`, at(here, 'name'))
    workspaces.set(workspace.name, workspace)
  }
  for (const request of requests) if (request.pattern in packages) checkLinked(request, workspaces, semver)
  for (const request of requests) if (!(request.pattern in packages)) request.targets[request.name] = linkWorkspace(request, workspaces, semver)
  const context = { packages, workspaces, semver }
  const importers = Object.create(null)
  for (const [dir, manifest, here] of entries(manifests, WHERE)) importers[dir] = readTargets(manifest, dir, here, context)
  const rules = readResolutions(root.resolutions, at(rootAt, 'resolutions'), semver)
  // yarn resolves each resolution's pattern too, linked as a request is.
  for (const rule of rules) {
    if (!(rule.pattern in packages) && !workspaces.has(rule.name)) throw new LockfileError(`${quote(rule.pattern)} is not a pattern of the lockfile, where yarn records every resolution's`, rule.where)
    rule.target = resolveRequest(rule, context)
  }
  checkReached(importers, packages, rules)
  // yarn asks for the root's own through an aggregator where it has workspaces.
  const aggregated = Array.isArray(root.workspaces?.packages ?? root.workspaces)
  return { importers, workspaces, rules, aggregated }
}
