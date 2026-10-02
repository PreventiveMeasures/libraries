// A tree built on its own, mounted into a Vfs the caller already has, at
// its root: the lockfile's directory. Nothing there is written over or
// removed. A node_modules there already, anywhere, is refused, or for
// another tree what its `check` refuses: kept beside the tree, Node would
// read it as the tree's, and removed, it would be the caller's lost;
// neither is safe. Vfs.mount judges everything before anything is written,
// so a refusal leaves the Vfs as it was.

import { basename } from '@preventive/vfs/path.js'
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

// macOS's filesystems take a name whatever its case and normalization, so
// two names that differ only in those are one there, and one would be
// lost: such a tree is refused where the host is macOS.
export function checkCollisions(vfs) {
  for (const { path, type } of vfs.walk('/')) {
    if (type !== 'directory') continue
    const folded = new Map()
    for (const name of vfs.readdir(path)) {
      const key = fold(name)
      if (folded.has(key)) throw new DeptreeError(`${quote(folded.get(key))} and ${quote(name)} are one name on macOS`, quote(path))
      folded.set(key, name)
    }
  }
}

// Mounts `tree` into `target` with Vfs.mount: each directory of the tree
// is one there already or is made, and each file and link is put where
// nothing is, and where names are `folded`, none beside a name it would be
// one with. A clash is refused by what is there, before anything is
// written; at the root, a path there is the tree's too. The tree's bytes
// are shared with `target`, not copied, and the tree is left as it is.
export function mount(tree, target, folded, check = checkNoModules) {
  check(target, folded)
  const clash = (path, [there]) => {
    if (there !== path) throw new DeptreeError(`${quote(basename(there))} is there already, which is one name with ${quote(basename(path))} on macOS`, where(path))
    throw new DeptreeError(`a ${target.lstat(path).type} is there already, where the tree has a ${tree.lstat(path).type}`, where(path))
  }
  target.mount(tree, '/', { clash, fold: folded ? fold : undefined })
}
