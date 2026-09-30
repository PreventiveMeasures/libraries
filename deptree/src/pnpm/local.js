// Directories outside node_modules the tree links to, read from the Vfs
// given as `vfs` where there is one: those local overrides name, and
// every other a `link:` leads to that is no project and is under the
// lockfile's directory. Each has to hold a package.json there, whose bins
// take their names as pnpm links them. An override to a directory is
// read only from a Vfs given, and one to a copy of it, as `file:` has
// pnpm install it, is refused: pnpm picks the files it copies with
// npm-packlist, whose rules are not followed here.

import { DeptreeError, quote } from '../error.js'
import { readManifest } from './projects.js'

// readManifest drops a byte order mark, as pnpm does one.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

function manifestAt(vfs, dir, where) {
  const path = `/${dir}/package.json`
  if (!vfs.isFile(path)) throw new DeptreeError(`${quote(dir)} holds no package.json in the Vfs given`, where)
  let text
  try {
    text = decoder.decode(vfs.readFile(path))
  } catch {
    throw new DeptreeError(`${quote(`${dir}/package.json`)} is not UTF-8`, where)
  }
  return readManifest(text, where)
}

// `overrides` is listOverrides's.
export function checkLocalOverrides(overrides, vfs) {
  for (const { selector, local } of overrides) {
    if (local === undefined) continue
    const where = `overrides[${quote(selector)}]`
    if (local.protocol === 'file:') throw new DeptreeError('an override to a copy of a directory, as file: has pnpm install it, is not supported: pnpm picks the files it copies with npm-packlist', where)
    if (vfs === undefined) throw new DeptreeError(`an override to a directory, ${quote(local.dir)}, is read only from a Vfs given as vfs`, where)
    manifestAt(vfs, local.dir, where)
  }
}

// By directory, the package.json of each directory the tree links to that
// is no node of `nodes`, no project of `projects`, and under the
// lockfile's directory, read from `vfs`; none without one.
export function readLinked(links, nodes, projects, vfs) {
  const linked = new Map()
  if (vfs === undefined) return linked
  for (const [path, target] of links) {
    if (nodes.has(target) || projects.has(target) || linked.has(target) || target === '..' || target.startsWith('../')) continue
    linked.set(target, manifestAt(vfs, target, quote(path)))
  }
  return linked
}
