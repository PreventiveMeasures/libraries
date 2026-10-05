// workspace.members, exclude and default-members as cargo reads them: each
// glob from the root through the glob crate, `*` and `?` taking any name in
// a directory, one with a leading dot too; `**` and `[`, and a path that
// leads out of the root or depends on where it is, are refused.

import { compareNames, join } from '@preventive/vfs/path.js'
import { DeptreeError, quote } from '../error.js'
import { wildcard } from '../matcher.js'
import { UNSAFE, fold } from '../mount.js'
import { typeOf } from '../project.js'

const WILD = /[*?]/u
const at = (dir) => (dir === '.' ? '/' : `/${dir}`)

// A path's components as Rust's Path has them past a root: no empty or `.`.
export const parts = (path) => path.split('/').filter((segment) => segment !== '' && segment !== '.')

// Each entry of the three lists, before anything is read by it.
export function checkLists(workspace) {
  for (const key of ['members', 'exclude', 'defaultMembers']) {
    for (const [index, entry] of (workspace[key] ?? []).entries()) {
      const where = `Cargo.toml: workspace.${key === 'defaultMembers' ? 'default-members' : key}[${index}]`
      if (entry.startsWith('/') || UNSAFE.test(entry)) throw new DeptreeError(`${quote(entry)} is not a relative path within the project, which is all that is read`, where)
      if (key !== 'exclude' && parts(entry).includes('..')) throw new DeptreeError(`${quote(entry)} leads out of the root, which is not read`, where)
      if (key !== 'exclude' && /\*\*|\[/u.test(entry)) throw new DeptreeError(`${quote(entry)} has a \`**\` or a \`[\`, which is not supported`, where)
    }
  }
}

// is_excluded: under an `exclude` path and no `members` one, each taken as
// written, a glob's wildcards as names.
export function isExcluded(workspace, path) {
  const under = (list) => list.some((entry) => {
    const prefix = parts(entry)
    return prefix.length <= path.length && prefix.every((segment, i) => segment === path[i])
  })
  return !under(workspace.members) && under(workspace.exclude)
}

// A name glob() checks for by a path, which on macOS takes it in any case.
function literal(names, segment, folded, dir, where) {
  if (names.includes(segment)) return [segment]
  const other = folded ? names.find((name) => fold(name) === fold(segment)) : undefined
  if (other !== undefined) throw new DeptreeError(`${quote(join(dir, segment))} is ${quote(join(dir, other))} on macOS, which is not supported`, where)
  return []
}

// Every path the glob takes, files among them, which glob() lists too. A
// link it reaches is refused, as glob() follows it.
function expand(project, glob, folded, where) {
  let found = ['.']
  for (const segment of parts(glob)) {
    const matches = WILD.test(segment) ? wildcard(segment, { one: true }) : undefined
    const next = []
    for (const dir of found) {
      if (typeOf(project, at(dir), false) !== 'directory') continue
      const names = project.readdir(at(dir))
      for (const name of matches === undefined ? literal(names, segment, folded, dir, where) : names.filter(matches)) {
        const path = join(dir, name)
        if (typeOf(project, at(path), false) === 'symlink') throw new DeptreeError('a link where cargo looks for members is not supported', quote(path))
        next.push(path)
      }
    }
    found = next
  }
  return found.sort(compareNames)
}

// members_paths: the directories each glob takes, where one that takes
// nothing at all fails as cargo goes to read it.
function pathsOf(project, globs, key, folded) {
  return globs.flatMap((glob, index) => {
    const where = `Cargo.toml: workspace.${key}[${index}]`
    const found = expand(project, glob, folded, where)
    if (found.length === 0) throw new DeptreeError(`${quote(glob)} takes nothing, which cargo fails on`, where)
    return found.filter((dir) => typeOf(project, at(dir)) === 'directory')
  })
}

export const explicitMembers = (project, workspace, folded) => pathsOf(project, workspace.members, 'members', folded)

// Cargo, run at the root, holds each default member to be a member, or a
// directory `members` takes, `listed`, that is excluded.
export function checkDefaultMembers(project, workspace, members, listed, folded) {
  if (workspace.defaultMembers === undefined) return
  for (const dir of pathsOf(project, workspace.defaultMembers, 'default-members', folded)) {
    if (members.has(dir) || (listed.has(dir) && isExcluded(workspace, parts(dir)))) continue
    throw new DeptreeError(`${quote(dir)} is no member, which cargo refuses`, 'Cargo.toml: workspace.default-members')
  }
}
