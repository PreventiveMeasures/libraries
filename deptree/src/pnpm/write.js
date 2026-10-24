// How a snapshot's files are written: patched, and fixed as linking bins
// fixes them, then each into the tree, as the full tree and a lazy one
// write them.

import { dirname } from '@preventive/vfs/path.js'
import { DeptreeError, quote } from '../error.js'
import { checkWrite, isInside, makeDirs } from '../mount.js'
import { applyPatch, parsePatch } from '../patch.js'
import { typeOf } from '../project.js'
import { checkPatchOfBins, executableMode, fixBin } from './bins.js'

// A patch of `patches`, parsed once.
export function parsedPatch(patches, hash) {
  const patch = patches.get(hash)
  patch.parsed ??= parsePatch(patch.text, patch.path)
  return patch
}

export function compose(node, patches, { targets, executable }, { major, checkPatched }) {
  const where = quote(node.key)
  let files = node.files
  const { patchHash } = node.pkg
  if (patchHash !== undefined) {
    const patch = parsedPatch(patches, patchHash)
    patch.applied ??= new WeakMap()
    if (!patch.applied.has(files)) patch.applied.set(files, applyPatch(files, patch.parsed, { createdMode: major >= 12 ? 0o644 : undefined }))
    files = patch.applied.get(files)
    const manifest = checkPatchOfBins(node, files, targets, where, major)
    checkPatched?.(manifest, where)
  }
  if (targets.size === 0 && executable.size === 0) return files
  files = new Map(files)
  for (const path of targets) files.set(path, fixBin(files.get(path), `${where}: ${quote(path)}`, major))
  for (const path of executable) files.set(path, { ...files.get(path), mode: executableMode(files.get(path).mode, major) })
  return files
}

function addMade(made, dir) {
  for (let at = dir; !made.has(at) && at !== '/'; at = dirname(at)) made.add(at)
}

// Only this node writes under `dir`, and the tree holds no links yet, so `made`
// knows every directory there and no write needs a look first, which costs a
// thrown error where nothing is.
export function writeNode(vfs, dir, files, stats) {
  const root = `/${dir}`
  if (typeOf(vfs, root, false) !== undefined) throw new DeptreeError('would be written over with something else', quote(dir))
  const real = new Set()
  makeDirs(vfs, dir, real)
  const made = new Set([root])
  for (const [path, file] of files) {
    const at = `${root}/${path}`
    if (file.directory) {
      if (!isInside(path)) throw new DeptreeError('is not a path within the package', quote(at.slice(1)))
      makeDirs(vfs, at.slice(1), real)
      addMade(made, at)
      continue
    }
    if (made.has(at)) throw new DeptreeError('would be written over with something else', quote(at.slice(1)))
    const parent = dirname(at)
    if (!made.has(parent)) {
      makeDirs(vfs, parent.slice(1), real)
      addMade(made, parent)
    }
    vfs.writeFile(checkWrite(vfs, dir, path, real), file.data, { mode: file.mode })
    stats.files++
    stats.bytes += file.data.length
  }
}
