// A tree built on its own, mounted into the caller's Vfs at its root, the
// lockfile's directory, writing over and removing nothing. A node_modules
// there already, anywhere, is refused, or for another tree what its `check`
// refuses: kept, Node would read it as the tree's, and removed, the
// caller's would be lost. Vfs.mount judges everything before anything is
// written, so a refusal leaves the Vfs as it was. And the helpers every
// tree is built with.

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

// Refuses two names in a directory that macOS takes for one, as one would
// be lost there; called where the host is macOS.
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
