// The two sides `bin/deptree.js compare` sets beside each other, and their
// difference. Not part of the published package: the library reads no disk,
// and only this development CLI does.
//
// Each side is a map from a path, relative to the project's directory and
// with no leading `/`, to what is there: its type, its mode, and a file's
// bytes or a link's target. Only what is under a node_modules is held, so
// the directories above, the projects' own, are never set side by side.

import { Buffer } from 'node:buffer'
import { lstatSync, readFileSync, readdirSync, readlinkSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { compareNames, dirname, normalize } from '@preventive/vfs/path.js'

const typeOf = (st) => (st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'other')

// The project's directory as deptree reads one, by paths from `/`: never
// above it, as `..` at `/` stays there. Names come in code point order, as a
// Vfs lists them, whatever order the filesystem keeps.
export function projectView(root) {
  const at = (path) => join(root, normalize(`/${path}`))
  return {
    readdir: (path) => readdirSync(at(path)).sort(compareNames),
    lstat(path) {
      const st = lstatSync(at(path))
      return { type: typeOf(st), mode: st.mode & 0o777 }
    },
    stat: (path) => ({ type: typeOf(statSync(at(path))) }),
    readFile: (path) => readFileSync(at(path)),
  }
}

// The node_modules a path is under, the first one from the project's
// directory, itself included; or undefined.
export function modulesOf(path) {
  const segments = path.split('/')
  const at = segments.indexOf('node_modules')
  return at === -1 ? undefined : segments.slice(0, at + 1).join('/')
}

const lstatOrNone = (path) => {
  try {
    return lstatSync(path)
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined
    throw error
  }
}

// Everything under each of `dirs` (node_modules, by paths from the project's
// directory `root`) as it is on disk, into `into`: links not followed, every
// file read whole. One not there is left out, and one read already is not
// read again.
export function readDisk(root, dirs, into = new Map()) {
  const stack = [...dirs].filter((dir) => !into.has(dir) && lstatOrNone(join(root, dir)) !== undefined)
  while (stack.length > 0) {
    const path = stack.pop()
    const full = join(root, path)
    const st = lstatSync(full)
    const entry = { type: typeOf(st), mode: st.mode & 0o777 }
    if (entry.type === 'file') entry.data = readFileSync(full)
    if (entry.type === 'symlink') entry.target = readlinkSync(full)
    into.set(path, entry)
    if (entry.type === 'directory') for (const name of readdirSync(full)) stack.push(`${path}/${name}`)
  }
  return into
}

// The tree deptree built, as readDisk reads the disk: what its Vfs holds
// under a node_modules, which is all of it but the directories on the way.
// The bytes are the Vfs's own, not copied.
export function readTree(vfs) {
  const entries = new Map()
  for (const { path, type } of vfs.walk('/')) {
    const rel = path.slice(1)
    if (modulesOf(rel) === undefined) continue
    const entry = { type, mode: vfs.lstat(path).mode & 0o777 }
    if (type === 'file') entry.data = vfs.readFile(path)
    if (type === 'symlink') entry.target = vfs.readlink(path)
    entries.set(rel, entry)
  }
  return entries
}

// What deptree never builds, as it is no part of the tree a lockfile gives:
// the .bin directories, and each package manager's record of its install —
// pnpm's state files, npm's hidden lockfile, yarn's integrity file.
const NOT_BUILT = /(?:^|\/)node_modules\/(?:\.bin|\.modules\.yaml|\.pnpm-workspace-state(?:-v\d+)?\.json|\.pnpm\/lock\.yaml|\.package-lock\.json|\.yarn-integrity)$/u

// Whether a change is only one of those on disk.
export const notBuilt = ({ mark, path }) => mark === '-' && NOT_BUILT.test(path)

// Depth first, siblings in code point order, as Vfs.walk goes.
export function byPath(a, b) {
  const [as, bs] = [a.split('/'), b.split('/')]
  for (let i = 0; i < Math.min(as.length, bs.length); i++) {
    if (as[i] !== bs[i]) return compareNames(as[i], bs[i])
  }
  return as.length - bs.length
}

const octal = (mode) => mode.toString(8).padStart(3, '0')

function changeOf(disk, tree) {
  if (disk === undefined) return { mark: '+', type: tree.type }
  if (tree === undefined) return { mark: '-', type: disk.type }
  if (disk.type !== tree.type) return { mark: '~', type: tree.type, what: `${disk.type} on disk, ${tree.type} in the tree` }
  const what = []
  if (disk.type === 'symlink' && disk.target !== tree.target) what.push(`link to ${disk.target} on disk, to ${tree.target} in the tree`)
  if (disk.type === 'file') {
    if (disk.data.length !== tree.data.length || Buffer.compare(disk.data, tree.data) !== 0) what.push('content')
    if (disk.mode !== tree.mode) what.push(`mode ${octal(disk.mode)} on disk, ${octal(tree.mode)} in the tree`)
  }
  return what.length === 0 ? undefined : { mark: '~', type: tree.type, what: what.join('; ') }
}

// What an install from the lockfile would change of what is on disk, in
// walk order: `+` a path only the tree has, `-` one only the disk has, `~`
// one both have otherwise, by type, bytes, mode or link target. A file's
// bytes are compared whole, never line by line. A directory only one side
// has is one change, and so is a path whose type differs: nothing under
// either is listed. A directory's own mode is not compared, as the umask
// sets it rather than the lockfile.
export function difference(disk, tree) {
  // Whether what is in `dir` is set side by side: it is a directory on both
  // sides, or on neither, being above every node_modules.
  const sideBySide = (dir) => {
    const [there, built] = [disk.get(dir), tree.get(dir)]
    if (there === undefined && built === undefined) return true
    return there?.type === 'directory' && built?.type === 'directory'
  }
  const changes = []
  for (const path of new Set([...disk.keys(), ...tree.keys()])) {
    if (!sideBySide(dirname(path))) continue
    const change = changeOf(disk.get(path), tree.get(path))
    if (change !== undefined) changes.push({ path, ...change })
  }
  return changes.sort((a, b) => byPath(a.path, b.path))
}
