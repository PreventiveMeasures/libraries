// A tree mounted into the caller's Vfs at the lockfile's directory, writing
// over and removing nothing; Vfs.mount judges it whole first, so a refusal
// leaves the Vfs as it was. A node_modules there already is refused: kept,
// Node would read it as the tree's, and removed, the caller's would be lost.

import { VfsError } from '@preventive/vfs'
import { basename } from '@preventive/vfs/path.js'
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

export function checkCollisions(vfs) {
  const [clash] = vfs.collisions(fold)
  if (clash !== undefined) throw new DeptreeError(`${quote(clash.names[0])} and ${quote(clash.names[1])} are one name on macOS`, quote(clash.path))
}

// `root` is the package's directory in the tree, without a leading `/`.
export function writeFiles(vfs, root, { dirs, files }, stats, skip = () => false) {
  for (const dir of dirs) if (!skip(dir)) vfs.mkdir(`/${root}/${dir}`, { recursive: true })
  for (const [path, file] of files) {
    if (skip(path)) continue
    try {
      vfs.writeFile(`/${root}/${path}`, file.data, { mode: file.mode })
    } catch (error) {
      if (error instanceof VfsError) throw new DeptreeError(`cannot be written: ${error.message}`, quote(`${root}/${path}`), { cause: error })
      throw error
    }
    stats.files++
    stats.bytes += file.data.length
  }
}

// A clash is refused by what is there; at the root, a path there is the
// tree's too. The tree's bytes are shared with `target`, not copied.
export function mount(tree, target, folded, check = checkNoModules) {
  check(target, folded)
  const clash = (path, [there]) => {
    if (there !== path) throw new DeptreeError(`${quote(basename(there))} is there already, which is one name with ${quote(basename(path))} on macOS`, where(path))
    throw new DeptreeError(`a ${target.lstat(path).type} is there already, where the tree has a ${tree.lstat(path).type}`, where(path))
  }
  target.mount(tree, '/', { clash, fold: folded ? fold : undefined })
}
