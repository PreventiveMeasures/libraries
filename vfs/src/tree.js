// A tree of inodes taken whole: walked depth first, siblings in code point
// order, and merged into another as Vfs.mount does it -- copied, then judged
// entry by entry in that order, a directory into one there under the same
// name and anything else beside what is there, and put in place once all
// is judged, so a refusal changes nothing. Links are names here like any
// other, never followed in either tree, so nothing lands outside the
// directory merged into. Only a directory's entries are read here: what
// any inode holds besides is the Vfs's own, and so is a copy of it.

import { VfsError, wrongType } from './error.js'
import { compareNames } from './path.js'

export const namesOf = (dir) => [...dir.entries.keys()].sort(compareNames)

// A path as walk spells it: `name` the way down from `base`, '' for it.
export const spell = (base, name) => (name === '' ? base : base === '/' ? `/${name}` : `${base}/${name}`)

// Every inode at or under `top`, depth first, siblings in name order, a
// link named but not crossed, as `shape` has it: `name` is the way down
// from `top`, '' for it, and `leaf` the last name on it, in `parent`. A
// directory is gone into if `within` says so once what it yielded is taken.
export function* descend(top, shape = (entry) => entry, within = () => true) {
  const stack = [{ name: '', node: top, depth: 0 }]
  while (stack.length > 0) {
    const entry = stack.pop()
    yield shape(entry)
    if (entry.node.type !== 'directory' || !within(entry)) continue
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

// The options of a mount, checked, and `settle`, which says how a clash is
// settled.
export function checkMount({ clash = 'error', fold }) {
  if (typeof clash !== 'function') settled(clash, 'clash', "'error', 'keep', 'replace' or a function")
  if (fold !== undefined && typeof fold !== 'function') throw wrongType('fold', fold, 'a function')
  return { fold, settle: typeof clash === 'function' ? (path, there) => settled(clash(path, there), 'what clash returns') : () => clash }
}

// Merges a copy of the directory `from` into the directory `into`, which
// is at `base`. `inodes` copies an inode, its entries yet to be filled,
// and numbers a copy once all is judged, as it is put in place. The copy
// is made before anything is judged, so it is the tree as it was, whatever
// a function given does to it, a tree merged into itself among them, and
// no one else holds what is put in place.
export function merge(into, from, base, { settle, fold }, inodes) {
  const tree = copy(from, inodes.copy)
  // Each directory of the tree merged into one there, the only ones the
  // walk goes into, with the keys `fold` takes the names there to, once asked.
  const merged = new Map([[tree, { into }]])
  const plan = []
  for (const { name, leaf, parent, node } of descend(tree, undefined, (entry) => merged.has(entry.node))) {
    if (parent === undefined) continue
    const pair = merged.get(parent)
    const there = pair.into.entries.get(leaf)
    if (there?.type === 'directory' && node.type === 'directory') {
      merged.set(node, { into: there })
      continue
    }
    const taken = there === undefined ? folded(pair, parent, leaf, fold) : [leaf]
    if (taken.length > 0) {
      const path = spell(base, name)
      const how = settle(path, taken.map((other) => path.slice(0, -leaf.length) + other))
      if (how === 'error') throw new VfsError('EEXIST', path)
      if (how === 'keep') continue
    }
    plan.push({ dir: pair.into, name: leaf, node, taken })
  }
  for (const { dir, name, node, taken } of plan) {
    for (const each of descend(node)) inodes.number(each.node)
    for (const other of taken) dir.entries.delete(other)
    dir.entries.set(name, node)
  }
}

// Each set of two or more names in one directory at or under `top`, which
// is at `base`, that `fold` takes to one key: the directory, as walk spells
// it, and the names, in code point order, a directory's sets in the order
// of their first names.
export function* collisionsIn(top, base, fold) {
  for (const { name, node } of descend(top)) {
    if (node.type !== 'directory') continue
    for (const names of Map.groupBy(namesOf(node), (other) => fold(other)).values()) {
      if (names.length > 1) yield { path: spell(base, name), names }
    }
  }
}

// A copy of `top` and all under it, its inodes made in walk order: one for
// each of the tree's, so two names of one file are two names of one copy,
// and a directory's copy is there for what is under it.
function copy(top, copyOf) {
  const copies = new Map()
  for (const { node, parent, leaf } of descend(top)) {
    if (!copies.has(node)) copies.set(node, copyOf(node))
    if (parent !== undefined) copies.get(parent).entries.set(leaf, copies.get(node))
  }
  return copies.get(top)
}

// The names there that are one with `name` by `fold`'s keys, none without
// it, leaving out those the tree spells there too, in `from`: each of those
// is judged against the tree's entry of its own spelling.
function folded(pair, from, name, fold) {
  if (fold === undefined) return []
  pair.keys ??= Map.groupBy(namesOf(pair.into).filter((other) => !from.entries.has(other)), (other) => fold(other))
  return pair.keys.get(fold(name)) ?? []
}
