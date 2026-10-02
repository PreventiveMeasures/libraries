// A tree of inodes taken whole: walked depth first, siblings in code point
// order, and merged into another as Vfs.mount does it — judged entry by
// entry in that order, a directory into one there under the same name and
// anything else beside what is there, then copied in once all is judged,
// so a refusal changes nothing. Links are names here like any other, never
// followed in either tree, so nothing lands outside the directory merged
// into. Only a directory's entries are read here: what any inode holds
// besides is the Vfs's own, and so is a copy of it.

import { VfsError, wrongType } from './error.js'
import { compareNames } from './path.js'

export const namesOf = (dir) => [...dir.entries.keys()].sort(compareNames)

// Every inode at or under `top`, depth first, siblings in name order, a
// link named but not crossed, as `shape` has it: `name` is the way down
// from `top`, '' for it, and `leaf` the last name on it, in `parent`.
export function* descend(top, shape = (entry) => entry) {
  const stack = [{ name: '', node: top, depth: 0 }]
  while (stack.length > 0) {
    const entry = stack.pop()
    yield shape(entry)
    if (entry.node.type !== 'directory') continue
    const names = namesOf(entry.node)
    for (let i = names.length - 1; i >= 0; i--) {
      const name = entry.name === '' ? names[i] : `${entry.name}/${names[i]}`
      stack.push({ name, leaf: names[i], parent: entry.node, node: entry.node.entries.get(names[i]), depth: entry.depth + 1 })
    }
  }
}

const CLASHES = new Set(['error', 'keep', 'replace'])

// How a clash is settled, as given or as a function given returned it.
function settled(clash, what, expected = "'error', 'keep' or 'replace'") {
  if (typeof clash !== 'string') throw wrongType(what, clash, expected)
  if (!CLASHES.has(clash)) throw new RangeError(`${what} must be ${expected}, not ${JSON.stringify(clash)}`)
  return clash
}

export function checkMount({ clash = 'error', fold }) {
  if (typeof clash !== 'function') settled(clash, 'clash', "'error', 'keep', 'replace' or a function")
  if (fold !== undefined && typeof fold !== 'function') throw wrongType('fold', fold, 'a function')
  return { clash, fold }
}

// Merges the directory `from` into the directory `into`, which is at
// `base`; `copyOf` makes a copy of an inode, its entries yet to be filled.
export function merge(into, from, base, { clash, fold }, copyOf) {
  const settle = typeof clash === 'function' ? (path, there) => settled(clash(path, there), 'what clash returns') : () => clash
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
    if (taken.length > 0) {
      const path = `${pair.at}/${name}`
      const how = settle(path, taken.map((other) => `${pair.at}/${other}`))
      if (how === 'error') throw new VfsError('EEXIST', path)
      if (how === 'keep') continue
    }
    plan.push({ dir: pair.into, name, node, taken })
  }
  // Every copy is made before any is put in place, so a tree merged into
  // itself is copied as it was.
  const copies = new Map()
  for (const step of plan) step.made = copy(step.node, copies, copyOf)
  for (const { dir, name, taken, made } of plan) {
    for (const other of taken) dir.entries.delete(other)
    dir.entries.set(name, made)
  }
}

// A copy of `top` and all under it, its inodes made in walk order: one for
// each of the tree's, which `copies` holds, so two names of one file are
// two names of one copy, and a directory's copy is there for what is under
// it.
function copy(top, copies, copyOf) {
  for (const { node, parent, leaf } of descend(top)) {
    let made = copies.get(node)
    if (made === undefined) {
      made = copyOf(node)
      copies.set(node, made)
    }
    if (parent !== undefined) copies.get(parent).entries.set(leaf, made)
  }
  return copies.get(top)
}

// The names there that are one with `name` by `fold`'s keys, none without
// it, leaving out those the tree spells there too: each of those is judged
// against the tree's entry of its own spelling.
function folded(pair, name, fold) {
  if (fold === undefined) return []
  pair.keys ??= Map.groupBy(namesOf(pair.into).filter((other) => !pair.from.entries.has(other)), (other) => fold(other))
  return pair.keys.get(fold(name)) ?? []
}
