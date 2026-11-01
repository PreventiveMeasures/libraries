// The two sides `deptree compare` sets beside each other, what is on disk
// and what deptree builds, each a map from a path under the folders an
// install makes to its type, mode, and bytes or link target; and how they
// differ: files and links as @preventive/compare tells them, the rest here.

import { Buffer } from 'node:buffer'
import { lstatSync, readFileSync, readdirSync, readlinkSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { compareTrees } from '@preventive/compare'
import { compareNames, dirname, normalize } from '@preventive/vfs/path.js'
import { typeOf } from '../src/project.js'

const kindOf = (st) => (st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'other')

// The project's directory as deptree reads one, by paths from `/`, never
// above it, its names in code point order, as a Vfs lists them, and its
// modes with the setuid, setgid and sticky bits, as a Vfs keeps them.
export function projectView(root) {
  const at = (path) => join(root, normalize(`/${path}`))
  return {
    readdir: (path) => readdirSync(at(path)).sort(compareNames),
    lstat(path) {
      const st = lstatSync(at(path))
      return { type: kindOf(st), mode: st.mode & 0o7777 }
    },
    stat: (path) => ({ type: kindOf(statSync(at(path))) }),
    readFile: (path) => readFileSync(at(path)),
    readlink: (path) => readlinkSync(at(path)),
  }
}

// What deptree never builds: the .bin directories, each package manager's
// record of its install, the .git of a dependency Soldeer clones, and what
// CocoaPods generates in Pods beside the pods: its record, the podspecs of
// pods by :path, headers, support files and the projects.
const NOT_BUILT = /(?:^|\/)node_modules\/(?:\.bin|\.modules\.yaml|\.pnpm-workspace-state(?:-v\d+)?\.json|\.pnpm\/lock\.yaml|\.package-lock\.json|\.yarn-integrity)(?:\/|$)|^dependencies\/[^/]+\/\.git(?:\/|$)|^Pods\/(?:Manifest\.lock|Local Podspecs|Headers|Target Support Files|\.project_cache|[^/]+\.xcodeproj)(?:\/|$)/u

// Everything under each of `dirs` as `view` has it, the disk's projectView
// or the tree's Vfs: links not followed, every file read whole, and a
// folder not there left out. A directory deptree never builds is one entry,
// not entered, as only it is ever listed.
export function readSide(view, dirs) {
  const entries = new Map()
  const stack = dirs.filter((dir) => typeOf(view, dir, false) !== undefined)
  while (stack.length > 0) {
    const path = stack.pop()
    const { type, mode } = view.lstat(path)
    const entry = { type, mode }
    if (type === 'file') entry.data = view.readFile(path)
    if (type === 'symlink') entry.target = view.readlink(path)
    entries.set(path, entry)
    if (type === 'directory' && !NOT_BUILT.test(path)) for (const name of view.readdir(path)) stack.push(`${path}/${name}`)
  }
  return entries
}

// The paths on disk alone that hold nothing Node resolves: what deptree never
// builds, and directories of nothing else, as pnpm leaves a node_modules of a
// .bin of links to what it removed, a scope once its last package goes, or
// the hoisted linker's .pnpm of its state alone.
export function leftOut(changes, disk) {
  const left = new Set(changes.filter(({ mark }) => mark === '-').map(({ path }) => path))
  for (const [path, { type }] of disk) {
    if (left.size === 0) break
    if (type === 'directory' || NOT_BUILT.test(path)) continue
    // Nothing listed is under another listed, so the first one up is its.
    for (let at = path; at !== '.'; at = dirname(at)) {
      if (left.delete(at)) break
    }
  }
  return left
}

// A package's directory in node_modules/.pnpm on disk alone, which pnpm keeps
// for a while after no install has it.
export const leftBehind = ({ mark, type, path }) => mark === '-' && type === 'directory' && /(?:^|\/)node_modules\/\.pnpm\/[^/]*@[^/]*$/u.test(path)

// Walk order, as Vfs.walk goes: a `/` sorts before anything a name can hold.
export const byPath = (a, b) => compareNames(a.replaceAll('/', '\0'), b.replaceAll('/', '\0'))

const octal = (mode) => mode.toString(8).padStart(3, '0')

// What compare compares: files and links, whose directories it implies.
const compared = (entry) => entry === undefined || entry.type === 'file' || entry.type === 'symlink'
function entriesOf(side) {
  const entries = []
  for (const [name, { type, mode, data, target }] of side) {
    if (type === 'file') entries.push({ name, mode, data })
    if (type === 'symlink') entries.push({ name, type, linkname: target })
  }
  return entries
}

// A file or a link compare finds differs, in deptree's words, and whether a
// file's bytes do, as its mode alone may.
function changeOf({ status, old: disk, new: tree }) {
  if (status === 'added') return { mark: '+', type: tree.type }
  if (status === 'deleted') return { mark: '-', type: disk.type }
  if (status === 'type-changed') return { mark: '~', type: tree.type, what: `${disk.type} on disk, ${tree.type} in the tree` }
  if (tree.type === 'symlink') return { mark: '~', type: tree.type, what: `link to ${disk.target} on disk, to ${tree.target} in the tree` }
  const content = disk.mode === tree.mode || Buffer.compare(disk.data, tree.data) !== 0
  const what = content ? ['content'] : []
  if (disk.mode !== tree.mode) what.push(`mode ${octal(disk.mode)} on disk, ${octal(tree.mode)} in the tree`)
  return { mark: '~', type: tree.type, what: what.join('; '), content }
}

// How the disk differs from the tree, in walk order, each file or link with
// compare's `status` of it, as formatPatch takes it. Nothing is listed under
// a path only one side has, or of another type on each, as only a directory
// has anything in it; a directory's own mode is the umask's, not compared.
export function difference(disk, tree) {
  const shown = (path) => disk.get(dirname(path))?.type === tree.get(dirname(path))?.type
  const changes = []
  for (const path of new Set([...disk.keys(), ...tree.keys()])) {
    const [one, two] = [disk.get(path), tree.get(path)]
    if ((compared(one) && compared(two)) || !shown(path) || one?.type === two?.type) continue
    const mark = one === undefined ? '+' : two === undefined ? '-' : '~'
    changes.push({ path, mark, type: (two ?? one).type, ...(mark === '~' && { what: `${one.type} on disk, ${two.type} in the tree` }) })
  }
  for (const status of compareTrees(entriesOf(disk), entriesOf(tree), { renames: false, lines: false })) {
    const { path } = status.new ?? status.old
    if (compared(disk.get(path)) && compared(tree.get(path)) && shown(path)) changes.push({ path, ...changeOf(status), status })
  }
  return changes.sort((a, b) => byPath(a.path, b.path))
}
