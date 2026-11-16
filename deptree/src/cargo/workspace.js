// The workspace as cargo finds it from the project's root, taken to be its root: the members and every
// other path package cargo reads, each parsed as cargo reads it, inheriting where cargo has it inherit

import { LockfileError, parseCargoManifest } from '@preventive/lockfile/cargo.js'
import { TomlError, parseToml } from '@preventive/lockfile/toml.js'
import { dirname } from '@preventive/vfs/path.js'
import { DeptreeError, quote } from '../error.js'
import { UNSAFE } from '../mount.js'
import { readUnlinked } from './inputs.js'
import { checkDefaultMembers, checkLists, explicitMembers, isExcluded, parts } from './members.js'

export const fileOf = (dir) => (dir === '.' ? 'Cargo.toml' : `${dir}/Cargo.toml`)
const manifestPath = (dir) => [...parts(dir), 'Cargo.toml']
// Whether the root has a [workspace] that does not exclude `dir`
const inRoot = (workspace, dir) => workspace !== undefined && !isExcluded(workspace, manifestPath(dir))

// A path from `base`, `..` only ahead of every name: else the filesystem would walk through a name that
// cargo's normalize_path drops unread
function resolvePath(base, path, where) {
  if (path.startsWith('/') || UNSAFE.test(path) || /^[A-Za-z]:/u.test(path)) throw new DeptreeError(`${quote(path)} is not a relative path within the project, which is all that is read`, where)
  const segments = parts(base)
  let named = false
  for (const segment of parts(path)) {
    if (segment !== '..') {
      named = true
      segments.push(segment)
    } else if (named) {
      throw new DeptreeError(`${quote(path)} has a \`..\` after a name, which is not supported`, where)
    } else if (segments.pop() === undefined) {
      throw new DeptreeError(`${quote(path)} leads out of the project, which is not read`, where)
    }
  }
  return segments.length === 0 ? '.' : segments.join('/')
}

export function parseAs(file, parse) {
  try {
    return parse()
  } catch (error) {
    if (error instanceof LockfileError || error instanceof TomlError) throw new DeptreeError(error.message, file, { cause: error })
    throw error
  }
}

// A Cargo.toml's text and TOML, or undefined where there is none.
function readRaw(project, dir) {
  const file = fileOf(dir)
  const text = readUnlinked(project, file, 'a manifest')
  return text === undefined ? undefined : { text, doc: parseAs(file, () => parseToml(text)) }
}

const pointerOf = (doc) => (doc.package ?? doc.project)?.workspace

const DEP_KEYS = { normal: 'dependencies', dev: 'dev-dependencies', build: 'build-dependencies' }
const depWhere = (dir, dep) => `${fileOf(dir)}: ${dep.target === undefined ? '' : `target.${quote(dep.target)}.`}${DEP_KEYS[dep.kind]}.${dep.name}`

// The root's manifest and [workspace], each Cargo.toml read, and each path package loaded
function contextOf(project, folded) {
  const read = new Map()
  const raw = (dir) => {
    if (!read.has(dir)) read.set(dir, readRaw(project, dir))
    return read.get(dir)
  }
  const top = raw('.')
  if (top === undefined) throw new DeptreeError('the project has no Cargo.toml')
  if (pointerOf(top.doc) !== undefined) throw new DeptreeError('a root that points to a workspace above it, which is not read, is not supported', 'Cargo.toml: package.workspace')
  const root = parseAs('Cargo.toml', () => parseCargoManifest(top.text))
  if (root.workspace !== undefined) checkLists(root.workspace)
  return { project, folded, read, raw, root, workspace: root.workspace, packages: new Map() }
}

// The workspace of the package in `dir`: its own, the root's, or none. A package.workspace pointing
// elsewhere than the root, and a [workspace] between the two, are refused.
function workspaceOf({ raw, workspace }, dir) {
  if (raw(dir).doc.workspace !== undefined) return 'own'
  for (let here = dir; here !== '.'; here = dirname(here)) {
    const doc = raw(here)?.doc
    if (doc === undefined) continue
    if (doc.workspace !== undefined) throw new DeptreeError('a [workspace] between a package and the root, one workspace in another, is not supported', fileOf(here))
    const pointer = pointerOf(doc)
    if (pointer === undefined) continue
    const where = `${fileOf(here)}: package.workspace`
    if (typeof pointer !== 'string' || resolvePath(here, pointer, where) !== '.' || workspace === undefined) throw new DeptreeError('a package.workspace pointing elsewhere than the root is not supported', where)
    return 'root'
  }
  return inRoot(workspace, dir) ? 'root' : 'none'
}

// A path package's manifest and where its path dependencies lead, dev-dependencies a member's alone; an
// inherited one's path is from the root of the workspace it is inherited from
function load(context, dir, member, where) {
  const { raw, root, packages } = context
  if (raw(dir) === undefined) throw new DeptreeError(`${quote(fileOf(dir))} is not there, which cargo fails on`, where)
  const inherits = dir === '.' ? 'own' : workspaceOf(context, dir)
  if (member && dir !== '.' && inherits !== 'root') throw new DeptreeError('a member with a [workspace] of its own, which cargo refuses', fileOf(dir))
  const manifest = dir === '.' ? root : parseAs(fileOf(dir), () => parseCargoManifest(raw(dir).text, inherits === 'root' ? root : undefined))
  if (manifest.package === undefined && dir !== '.') throw new DeptreeError('a manifest with no [package], which cargo fails on as a path dependency', fileOf(dir))
  const links = []
  for (const [index, dep] of (manifest.package?.dependencies ?? []).entries()) {
    if (dep.source.type !== 'path' || (!member && dep.kind === 'dev')) continue
    const here = depWhere(dir, dep)
    links.push({ index, dir: resolvePath(dep.inherited && inherits === 'root' ? '.' : dir, dep.source.path, here), where: here })
  }
  packages.set(dir, { manifest, member, links })
  return links
}

// The root, those `members` takes, and each path dependency of one in the root and not excluded; what
// else they lead to is given back, for the packages that are not members
function loadMembers(context) {
  const { project, folded, workspace } = context
  const members = new Set()
  const pending = []
  const others = []
  const join = ({ dir, where }) => {
    if (members.has(dir)) return
    members.add(dir)
    pending.push({ dir, where })
  }
  const listed = workspace === undefined ? [] : explicitMembers(project, workspace, folded)
  if (workspace !== undefined) {
    for (const dir of listed) if (inRoot(workspace, dir)) join({ dir, where: 'Cargo.toml: workspace.members' })
    if (isExcluded(workspace, ['Cargo.toml'])) throw new DeptreeError('the root is excluded from its own workspace, which cargo refuses', 'Cargo.toml: workspace.exclude')
  }
  join({ dir: '.', where: 'Cargo.toml' })
  while (pending.length > 0) {
    const { dir, where } = pending.shift()
    for (const link of load(context, dir, true, where)) {
      if (inRoot(workspace, link.dir)) join(link)
      else others.push(link)
    }
  }
  if (workspace !== undefined) checkDefaultMembers(project, workspace, members, new Set(listed), folded)
  return others
}

// Each [patch] from a path, the config's from the directory its .cargo is in, which is the root too
function patchesOf(root, config) {
  const files = [[root.patch, 'Cargo.toml'], [config.patch, config.file]]
  return files.flatMap(([patch, file]) => Object.entries(patch).flatMap(([table, specs]) => Object.entries(specs).filter(([, spec]) => spec.source.type === 'path').map(([name, spec]) => {
    const where = `${file}: patch.${quote(table)}.${name}`
    return { dir: resolvePath('.', spec.source.path, where), name: spec.package, where }
  })))
}

// `config` is parseCargoConfig's, with its `file`; `read` each Cargo.toml read by directory, undefined for none
export function findWorkspace(project, config, folded) {
  const context = contextOf(project, folded)
  const others = loadMembers(context)
  const patches = patchesOf(context.root, config)
  others.push(...patches)
  while (others.length > 0) {
    const { dir, where } = others.shift()
    if (!context.packages.has(dir)) others.push(...load(context, dir, false, where))
  }
  for (const { dir, name, where } of patches) {
    const found = context.packages.get(dir).manifest.package.name
    if (found !== name) throw new DeptreeError(`${quote(fileOf(dir))} is of ${quote(found)}, not ${quote(name)}, which cargo fails on`, where)
  }
  return { root: context.root, packages: context.packages, read: context.read }
}
