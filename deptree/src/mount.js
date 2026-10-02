// A tree built on its own, mounted into a Vfs the caller already has, at
// its root: the lockfile's directory. Nothing there is written over or
// removed. A node_modules there already, anywhere, is refused, or for
// another tree what its `check` refuses: kept beside the tree, Node would
// read it as the tree's, and removed, it would be the caller's lost;
// neither is safe. Vfs.mount judges everything before anything is written,
// so a refusal leaves the Vfs as it was.

import { VfsError } from '@preventive/vfs'
import { basename, dirname } from '@preventive/vfs/path.js'
import { DeptreeError, quote } from './error.js'

// As macOS takes a name, whatever its case and normalization.
export const fold = (name) => name.normalize('NFD').toLowerCase()

const where = (path) => `vfs[${quote(path)}]`

// Refuses a Vfs that holds a node_modules, or, where names are `folded`, a
// name that is one there.
export function checkNoModules(vfs, folded) {
  for (const { path } of vfs.walk('/')) {
    const name = basename(path)
    if (name === 'node_modules' || (folded && fold(name) === 'node_modules')) {
      throw new DeptreeError('a node_modules is there already, which is neither kept beside the tree nor removed', where(path))
    }
  }
}

function typeAt(vfs, path) {
  try {
    return vfs.lstat(path).type
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

// Mounts `tree` into `target` with Vfs.mount: each directory of the tree
// is one there already or is made, and each file and link is put where
// nothing is, and where names are `folded`, none beside a name it would be
// one with. A clash is refused by what is there. The tree's bytes are
// shared with `target`, not copied, and the tree is left as it is.
export function mount(tree, target, folded, check = checkNoModules) {
  check(target, folded)
  try {
    target.mount(tree, '/', { fold: folded ? fold : undefined })
  } catch (error) {
    if (!(error instanceof VfsError) || error.code !== 'EEXIST') throw error
    throw new DeptreeError(clashAt(tree, target, error.path), where(error.path), { cause: error })
  }
}

// What Vfs.mount found at `path`, where the tree has an entry: a name
// spelled as the tree's, or one that is one with it on macOS.
function clashAt(tree, target, path) {
  const existing = typeAt(target, path)
  if (existing !== undefined) return `a ${existing} is there already, where the tree has a ${tree.lstat(path).type}`
  const name = basename(path)
  const clash = target.readdir(dirname(path)).find((other) => fold(other) === fold(name))
  return `${quote(clash)} is there already, which is one name with ${quote(name)} on macOS`
}
