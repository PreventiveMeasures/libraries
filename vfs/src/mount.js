// One tree of inodes merged into another, as Vfs.mount does it: judged
// entry by entry in walk order, a directory into one there under the same
// name and anything else beside what is there, then copied in once all is
// judged, so a refusal changes nothing. Links are names here like any
// other, never followed in either tree, so nothing lands outside the
// directory merged into. Nothing here is called but by a Vfs, which has
// already found that directory and holds the inodes of both trees.

import { VfsError, wrongType } from './error.js'
import { compareNames } from './path.js'

const CLASHES = new Set(['error', 'keep', 'replace'])

export function checkMount({ clash = 'error', fold } = {}) {
  if (typeof clash !== 'string') throw wrongType('clash', clash, "'error', 'keep' or 'replace'")
  if (!CLASHES.has(clash)) throw new RangeError(`clash must be 'error', 'keep' or 'replace', not ${JSON.stringify(clash)}`)
  if (fold !== undefined && typeof fold !== 'function') throw wrongType('fold', fold, 'a function')
  return { clash, fold }
}

// Merges the directory `from` into the directory `into`, which is at
// `base`; `inode` makes an inode of the Vfs merged into, as its #inode does.
export function merge(into, from, base, { clash, fold }, inode) {
  // The tree's entries left to judge, in walk order, each with the pair of
  // directories it is judged in; a pair holds its keys once `fold` is asked.
  const pending = []
  const enter = (pair) => {
    const names = namesOf(pair.from)
    for (let i = names.length - 1; i >= 0; i--) pending.push({ pair, name: names[i], node: pair.from.entries.get(names[i]) })
  }
  enter({ into, from, at: base === '/' ? '' : base })
  const plan = []
  while (pending.length > 0) {
    const { pair, name, node } = pending.pop()
    const there = pair.into.entries.get(name)
    if (there?.type === 'directory' && node.type === 'directory') {
      enter({ into: there, from: node, at: `${pair.at}/${name}` })
      continue
    }
    const taken = there === undefined ? folded(pair, name, fold) : [name]
    if (taken.length > 0 && clash === 'error') throw new VfsError('EEXIST', `${pair.at}/${name}`)
    if (taken.length === 0 || clash === 'replace') plan.push({ dir: pair.into, name, node, taken })
  }
  // Every copy is made before any is put in place, so a tree merged into
  // itself is copied as it was.
  const copies = new Map()
  const made = plan.map(({ node }) => copy(node, copies, inode))
  plan.forEach(({ dir, name, taken }, i) => {
    for (const other of taken) dir.entries.delete(other)
    dir.entries.set(name, made[i])
  })
}

// A copy of `top` and all under it, its inodes made in walk order: one for
// each of the tree's, which `copies` holds, so two names of one file are
// two names of one copy.
function copy(top, copies, inode) {
  let made
  const pending = [{ node: top }]
  while (pending.length > 0) {
    const { node, dir, name } = pending.pop()
    if (!copies.has(node)) copies.set(node, inode(node.type, contentsOf(node), node.mode, node.mtime))
    const copied = copies.get(node)
    if (dir === undefined) made = copied
    else dir.entries.set(name, copied)
    if (node.type !== 'directory') continue
    const names = namesOf(node)
    for (let i = names.length - 1; i >= 0; i--) pending.push({ node: node.entries.get(names[i]), dir: copied, name: names[i] })
  }
  return made
}

const namesOf = (dir) => [...dir.entries.keys()].sort(compareNames)

// The names there that are one with `name` by `fold`'s keys, none without
// it, leaving out those the tree spells there too: each of those is judged
// against the tree's entry of its own spelling.
function folded(pair, name, fold) {
  if (fold === undefined) return []
  if (pair.keys === undefined) {
    const keys = new Map()
    for (const other of namesOf(pair.into)) {
      if (pair.from.entries.has(other)) continue
      const key = fold(other)
      if (keys.has(key)) keys.get(key).push(other)
      else keys.set(key, [other])
    }
    pair.keys = keys
  }
  return pair.keys.get(fold(name)) ?? []
}

// What a copy of an inode holds. A file's bytes are shared, as nothing
// writes into bytes once stored, unless their buffer has room past them,
// which an append to either inode would write into.
function contentsOf(node) {
  if (node.type === 'directory') return { entries: new Map() }
  if (node.type === 'symlink') return { target: node.target, size: node.size }
  const { bytes } = node
  return { bytes: bytes.byteOffset + bytes.length === bytes.buffer.byteLength ? bytes : bytes.slice() }
}
