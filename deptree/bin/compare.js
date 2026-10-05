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
import { typeOf } from '../src/project.js'

const kindOf = (st) => (st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'other')

// The project's directory as deptree reads one, by paths from `/`: never
// above it, as `..` at `/` stays there. Names come in code point order, as a
// Vfs lists them, whatever order the filesystem keeps.
export function projectView(root) {
  const at = (path) => join(root, normalize(`/${path}`))
  return {
    readdir: (path) => readdirSync(at(path)).sort(compareNames),
    lstat(path) {
      const st = lstatSync(at(path))
      return { type: kindOf(st), mode: st.mode & 0o777 }
    },
    stat: (path) => ({ type: kindOf(statSync(at(path))) }),
    readFile: (path) => readFileSync(at(path)),
    readlink: (path) => readlinkSync(at(path)),
  }
}

// Everything under each of `dirs` (node_modules, by paths from the project's
// directory) as `project` reads it from disk: links not followed, every file
// read whole. One not there is left out.
export function readDisk(project, dirs) {
  const entries = new Map()
  const stack = dirs.filter((dir) => typeOf(project, dir, false) !== undefined)
  while (stack.length > 0) {
    const path = stack.pop()
    const entry = project.lstat(path)
    if (entry.type === 'file') entry.data = project.readFile(path)
    if (entry.type === 'symlink') entry.target = project.readlink(path)
    entries.set(path, entry)
    if (entry.type === 'directory') for (const name of project.readdir(path)) stack.push(`${path}/${name}`)
  }
  return entries
}

// Whether a path is a node_modules or under one.
const inModules = (path) => path === 'node_modules' || path.startsWith('node_modules/') || path.endsWith('/node_modules') || path.includes('/node_modules/')

// The tree deptree built, as readDisk reads the disk: what its Vfs holds
// under a node_modules, which is all of it but the directories on the way.
// The bytes are the Vfs's own, not copied.
export function readTree(vfs) {
  const entries = new Map()
  for (const { name, type, mode, data, linkname } of vfs.entries('/')) {
    if (!inModules(name)) continue
    const entry = { type, mode: mode & 0o777 }
    if (type === 'file') entry.data = data
    if (type === 'symlink') entry.target = linkname
    entries.set(name, entry)
  }
  return entries
}

// What deptree never builds, as it is no part of the tree a lockfile gives:
// the .bin directories, and each package manager's record of its install —
// pnpm's state files, npm's hidden lockfile, yarn's integrity file.
const NOT_BUILT = /(?:^|\/)node_modules\/(?:\.bin|\.modules\.yaml|\.pnpm-workspace-state(?:-v\d+)?\.json|\.pnpm\/lock\.yaml|\.package-lock\.json|\.yarn-integrity)$/u

// Whether a change is only one of those on disk.
export const notBuilt = ({ mark, path }) => mark === '-' && NOT_BUILT.test(path)

// A package's directory in node_modules/.pnpm, named by its key, that pnpm
// keeps there for a while after no install has it, and `pnpm prune` removes.
const LEFT_BEHIND = /(?:^|\/)node_modules\/\.pnpm\/[^/]*@[^/]*$/u

// Whether a change is one of those on disk alone.
export const leftBehind = ({ mark, type, path }) => mark === '-' && type === 'directory' && LEFT_BEHIND.test(path)

// Of the directories on disk alone, those that hold no file and no link,
// which Node finds nothing in. pnpm leaves a scope's directory behind once
// it removes the last package in it, and no pnpm command removes that.
export function emptyDirs(changes, disk) {
  const dirs = new Set(changes.filter(({ mark, type }) => mark === '-' && type === 'directory').map(({ path }) => path))
  for (const [path, { type }] of disk) {
    if (dirs.size === 0) break
    if (type === 'directory') continue
    // Nothing listed is under another listed, so the first one up is its.
    for (let dir = dirname(path); dir !== '.'; dir = dirname(dir)) {
      if (dirs.delete(dir)) break
    }
  }
  return dirs
}

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
    if (Buffer.compare(disk.data, tree.data) !== 0) what.push('content')
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
  // What is in `dir` is set side by side where it is the same on both sides:
  // only a directory has anything in it, and nothing is above node_modules.
  const sideBySide = (dir) => disk.get(dir)?.type === tree.get(dir)?.type
  const changes = []
  const compare = (path, there, built) => {
    if (!sideBySide(dirname(path))) return
    const change = changeOf(there, built)
    if (change !== undefined) changes.push({ path, ...change })
  }
  for (const [path, there] of disk) compare(path, there, tree.get(path))
  for (const [path, built] of tree) if (!disk.has(path)) compare(path, undefined, built)
  return changes.sort((a, b) => byPath(a.path, b.path))
}
