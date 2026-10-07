// The two sides `deptree compare` sets beside each other, what is on disk
// and what deptree builds, each a map from a path under the folders an
// install makes to its type, mode, and bytes or link target; and how they
// differ.

import { Buffer } from 'node:buffer'
import { lstatSync, readFileSync, readdirSync, readlinkSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { diff } from '@preventive/diff'
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
// record of its install, and the .git of a dependency Soldeer clones.
const NOT_BUILT = /(?:^|\/)node_modules\/(?:\.bin|\.modules\.yaml|\.pnpm-workspace-state(?:-v\d+)?\.json|\.pnpm\/lock\.yaml|\.package-lock\.json|\.yarn-integrity)(?:\/|$)|^dependencies\/[^/]+\/\.git(?:\/|$)/u

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

function changeOf(disk, tree) {
  if (disk === undefined) return { mark: '+', type: tree.type }
  if (tree === undefined) return { mark: '-', type: disk.type }
  if (disk.type !== tree.type) return { mark: '~', type: tree.type, what: `${disk.type} on disk, ${tree.type} in the tree` }
  const what = []
  const content = disk.type === 'file' && Buffer.compare(disk.data, tree.data) !== 0
  if (disk.type === 'symlink' && disk.target !== tree.target) what.push(`link to ${disk.target} on disk, to ${tree.target} in the tree`)
  if (content) what.push('content')
  if (disk.type === 'file' && disk.mode !== tree.mode) what.push(`mode ${octal(disk.mode)} on disk, ${octal(tree.mode)} in the tree`)
  return what.length === 0 ? undefined : { mark: '~', type: tree.type, what: what.join('; '), content }
}

// How the disk differs from the tree, in walk order. Nothing is listed under
// a path only one side has, or of another type on each, as only a directory
// has anything in it; a directory's own mode is the umask's, not compared.
export function difference(disk, tree) {
  const changes = []
  for (const path of new Set([...disk.keys(), ...tree.keys()])) {
    if (disk.get(dirname(path))?.type !== tree.get(dirname(path))?.type) continue
    const change = changeOf(disk.get(path), tree.get(path))
    if (change !== undefined) changes.push({ path, ...change })
  }
  return changes.sort((a, b) => byPath(a.path, b.path))
}

// Text is UTF-8 with no NUL in it, as diff takes a NUL for a binary file's.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
function textOf(bytes) {
  if (bytes.includes(0)) return undefined
  try {
    return decoder.decode(bytes)
  } catch {
    return undefined
  }
}

// A name for patch and git apply to read back whole: in C quotes, as git
// writes one, where it holds a control character, a quote or a backslash,
// each such byte escaped; and, unlike git, where it holds a space, as patch
// strips one that ends a name from before the tab git puts after it.
const UNQUOTED = /[\p{Cc}"\\]/gu
const ESCAPES = { '\t': '\\t', '\n': '\\n', '"': '\\"', '\\': '\\\\' }
const octets = (char) => [...Buffer.from(char)].map((byte) => `\\${byte.toString(8).padStart(3, '0')}`).join('')
const cQuoted = (name) => (/[\p{Cc}"\\ ]/u.test(name) ? `"${name.replaceAll(UNQUOTED, (char) => ESCAPES[char] ?? octets(char))}"` : name)

// A unified diff from disk to the tree, labelled for `patch -p1`.
export function patchOf(path, disk, tree) {
  const [from, to] = [cQuoted(`a/${path}`), cQuoted(`b/${path}`)]
  const [a, b] = [textOf(disk), textOf(tree)]
  if (a === undefined || b === undefined) return `Binary files ${from} and ${to} differ\n`
  return `--- ${from}\n+++ ${to}\n${diff(a, b)}`
}
