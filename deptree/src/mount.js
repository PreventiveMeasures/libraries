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

// Each builder holds what a tarball names and where a package goes to that
// first, and makes no link where a package is written after. A write is held
// to it again, so that one slip puts nothing out of the package's directory:
// its path within it, the directories on the way the ones it spells, which no
// link leads elsewhere, and no link at the path itself. `real` keeps the
// directories found so, as a package's files share them.
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
  const parent = dirname(`/${path}`)
  vfs.mkdir(parent, { recursive: true })
  if (vfs.realpath(parent) !== parent) throw new DeptreeError('would be linked through a link', quote(path))
  vfs.symlink(target, `/${path}`)
}

// `root` is the package's directory in the tree, without a leading `/`.
export function writeFiles(vfs, root, { dirs, files }, stats, skip = () => false) {
  for (const dir of dirs) if (!skip(dir)) vfs.mkdir(`/${root}/${dir}`, { recursive: true })
  const real = new Set()
  for (const [path, file] of files) {
    if (skip(path)) continue
    const at = checkWrite(vfs, root, path, real)
    try {
      vfs.writeFile(at, file.data, { mode: file.mode })
    } catch (error) {
      if (error instanceof VfsError) throw new DeptreeError(`cannot be written: ${error.message}`, quote(`${root}/${path}`), { cause: error })
      throw error
    }
    stats.files++
    stats.bytes += file.data.length
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
