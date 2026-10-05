// A tree mounted into the caller's Vfs at the lockfile's directory, writing
// over and removing nothing; Vfs.mount judges it whole first, so a refusal
// leaves the Vfs as it was. A node_modules there already is refused: kept,
// Node would read it as the tree's, and removed, the caller's would be lost.

import { VfsError } from '@preventive/vfs'
import { basename, dirname } from '@preventive/vfs/path.js'
import { DeptreeError, quote } from './error.js'

// As macOS takes a name, whatever its case and normalization.
export const fold = (name) => name.normalize('NFD').toLowerCase()

const where = (path) => `vfs[${quote(path)}]`

export function checkNoModules(vfs, folded) {
  for (const { path } of vfs.walk('/')) {
    const name = basename(path)
    if (name === 'node_modules' || (folded && fold(name) === 'node_modules')) {
      throw new DeptreeError('a node_modules is there already, which is neither kept beside the tree nor removed', where(path))
    }
  }
}

function checkCollisions(vfs) {
  const [clash] = vfs.collisions(fold)
  if (clash !== undefined) throw new DeptreeError(`${quote(clash.names[0])} and ${quote(clash.names[1])} are one name on macOS`, quote(clash.path))
}

// A path within a directory: no segment of it empty, `.` or `..`.
export const isInside = (path) => path !== '' && path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')

// Whether `child` is `parent` or under it, both paths from one directory in
// normal form, `.` being that one.
export const within = (parent, child) => child === parent || (parent === '.' ? child !== '..' && !child.startsWith('../') : child.startsWith(`${parent}/`))

// What the lockfile reader refuses in a path: a backslash, a separator on
// Windows, and what reads otherwise than it is written (a control character,
// a line or paragraph separator, a bidirectional control).
export const UNSAFE = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}\\]/u

const asRefusal = (error, what, path) => {
  if (error instanceof VfsError) return new DeptreeError(`cannot be ${what}: ${error.message}`, quote(path), { cause: error })
  return error
}

// Each builder holds what a tarball names and where a package goes to that
// first, and makes no link where a package is written after. What is made
// is held to it again, so that one slip puts nothing out of the tree or the
// package's directory. A directory: a place within the tree, each one on
// the way made where its parent is, or there already and no link. `real`
// keeps the directories found so, as a package's files share them.
export function makeDirs(vfs, path, real = new Set()) {
  if (!isInside(path)) throw new DeptreeError('is not a place within the tree', quote(path))
  let at = ''
  for (const segment of path.split('/')) {
    at = `${at}/${segment}`
    if (real.has(at)) continue
    if (vfs.isSymlink(at)) throw new DeptreeError('would be written through a link', quote(at.slice(1)))
    try {
      if (!vfs.isDirectory(at)) vfs.mkdir(at)
    } catch (error) {
      throw asRefusal(error, 'made', at.slice(1))
    }
    real.add(at)
  }
  return `/${path}`
}

// A file: a path within the package's directory, in a directory found as
// above, and no link at the path itself.
export function checkWrite(vfs, root, path, real) {
  const at = `/${root}/${path}`
  if (!isInside(root) || !isInside(path)) throw new DeptreeError('is not a path within the package', quote(at.slice(1)))
  const parent = dirname(at)
  if (!real.has(parent)) {
    if (vfs.realpath(parent) !== parent) throw new DeptreeError('would be written through a link', quote(at.slice(1)))
    real.add(parent)
  }
  if (vfs.isSymlink(at)) throw new DeptreeError('would be written through a link', quote(at.slice(1)))
  return at
}

// A link at `path`, a place within the tree under directories it spells,
// to `target`, as given.
export function writeLink(vfs, path, target) {
  if (!isInside(path)) throw new DeptreeError('is not a place within the tree', quote(path))
  if (path.includes('/')) makeDirs(vfs, dirname(path))
  try {
    vfs.symlink(target, `/${path}`)
  } catch (error) {
    throw asRefusal(error, 'made', path)
  }
}

// `root` is the package's directory in the tree, without a leading `/`;
// `links` are symlinks within it, by path, to their targets as given.
export function writeFiles(vfs, root, { dirs, files, links = new Map() }, stats, skip = () => false) {
  const real = new Set()
  makeDirs(vfs, root, real)
  for (const dir of dirs) {
    if (skip(dir)) continue
    if (!isInside(dir)) throw new DeptreeError('is not a path within the package', quote(`${root}/${dir}`))
    makeDirs(vfs, `${root}/${dir}`, real)
  }
  for (const [path, file] of files) {
    if (skip(path)) continue
    const at = checkWrite(vfs, root, path, real)
    try {
      vfs.writeFile(at, file.data, { mode: file.mode })
    } catch (error) {
      throw asRefusal(error, 'written', `${root}/${path}`)
    }
    stats.files++
    stats.bytes += file.data.length
  }
  for (const [path, target] of links) {
    if (skip(path)) continue
    const at = checkWrite(vfs, root, path, real)
    try {
      vfs.symlink(target, at)
    } catch (error) {
      throw asRefusal(error, 'made', `${root}/${path}`)
    }
    stats.links++
  }
}

// `target` with `tree` in it, or `tree` where there is none; on macOS, two
// names that are one there are refused first. A clash is refused by what is
// there; at the root, a path there is the tree's too. The tree's bytes are
// shared with `target`, not copied.
export function mount(tree, target, folded, check = checkNoModules) {
  if (folded) checkCollisions(tree)
  if (target === undefined) return tree
  check(target, folded)
  const clash = (path, [there]) => {
    if (there !== path) throw new DeptreeError(`${quote(basename(there))} is there already, which is one name with ${quote(basename(path))} on macOS`, where(path))
    throw new DeptreeError(`a ${target.lstat(path).type} is there already, where the tree has a ${tree.lstat(path).type}`, where(path))
  }
  target.mount(tree, '/', { clash, fold: folded ? fold : undefined })
  return target
}
