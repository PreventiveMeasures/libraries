// A tree built on its own, mounted into a Vfs the caller already has, at
// its root: the lockfile's directory. Nothing there is written over or
// removed. A node_modules there already, anywhere, is refused: kept beside
// the tree, Node would read it as the tree's, and removed, it would be the
// caller's lost; neither is safe. Everything is checked before anything
// is written, so a refusal leaves the Vfs as it was.

import { basename, dirname } from '@preventive/vfs/path.js'
import { DeptreeError, quote } from './error.js'

// As macOS takes a name, whatever its case and normalization.
const fold = (name) => name.normalize('NFD').toLowerCase()

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

// Moves `tree` into `target`: each directory of the tree is one there
// already or is made, and each file and link is written where nothing is,
// and where names are `folded`, none beside a name it would be one with.
// Each file is taken out of `tree` as it is written.
export function mount(tree, target, folded) {
  checkNoModules(target, folded)
  const entries = [...tree.walk('/')].filter(({ path }) => path !== '/')
  for (const { path, type } of entries) {
    const existing = typeAt(target, path)
    if (existing !== undefined && (type !== 'directory' || existing !== 'directory')) {
      throw new DeptreeError(`a ${existing} is there already, where the tree has a ${type}`, where(path))
    }
    if (!folded || existing !== undefined || typeAt(target, dirname(path)) !== 'directory') continue
    const name = basename(path)
    const clash = target.readdir(dirname(path)).find((other) => fold(other) === fold(name))
    if (clash !== undefined) throw new DeptreeError(`${quote(clash)} is there already, which is one name with ${quote(name)} on macOS`, where(path))
  }
  for (const { path, type } of entries) {
    if (type === 'directory') {
      if (typeAt(target, path) === undefined) target.mkdir(path)
    } else if (type === 'symlink') {
      target.symlink(tree.readlink(path), path)
    } else {
      target.writeFile(path, tree.readFile(path), { mode: tree.lstat(path).mode })
      tree.unlink(path)
    }
  }
}
