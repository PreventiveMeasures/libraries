// Hoisting as pnpm 10 does it (@pnpm/hoist): every alias in the graph a
// pattern matches gets a link to what it names, in node_modules/.pnpm/
// node_modules for the private pattern and in the root node_modules for
// the public one, which wins where both match. The first to take an alias
// keeps it, and the order is pnpm's: the projects' direct dependencies
// first, then the graph by depth, a node's depth being where pnpm's walk
// first reaches it, and nodes of one depth in the order of their
// directories. An alias is taken with its case folded, and the root
// project's own aliases are taken before anything, as they were spelled.

import { compareNames } from '@preventive/vfs/path.js'
import { DeptreeError, quote } from '../error.js'
import { createMatcher } from '../matcher.js'

// pnpm's graphWalker and getDependencies: one level at a time, but each
// level's next is walked out to the bottom before the level's second
// node's next is, so a node's depth is where that walk first reaches it,
// which is not always the least.
function walk(nodes, starts) {
  const visited = new Set()
  const step = (dirs) => {
    const found = []
    for (const dir of dirs) {
      if (visited.has(dir)) continue
      visited.add(dir)
      const node = nodes.get(dir)
      if (node !== undefined) found.push(node)
    }
    return found
  }
  const levels = (depth, found) => {
    const listed = found.map((node) => ({ node, depth }))
    const next = found.map((node) => step(node.children.values()))
    return [...listed, ...next.flatMap((level) => levels(depth + 1, level))]
  }
  return levels(0, step(starts))
}

// UTF-16 order, as pnpm's lexCompare has it.
const lexCompare = (a, b) => (a > b ? 1 : a < b ? -1 : 0)

// The aliases hoisted from the graph, walked from `starts`: a Map of each
// link's path to its target. `taken` holds the names none may be hoisted
// by, each alias looked up in it folded: the root project's own aliases,
// and those hoisted, folded. Of `nodes`, those `installed` may be hoisted.
// With pnpm 10, `projects` are named among the top's, and hoisted last;
// with pnpm 12, each is hoisted once the top's are, and takes its name.
function hoistGraph(nodes, starts, taken, typeOf, { projects = new Map(), installed = nodes, major = 10 } = {}) {
  const named = new Map([...projects].map(([id, name]) => [name, { project: id }]))
  const root = new Map(major < 12 ? named : [])
  const listed = new Set()
  for (const [alias, dir] of starts) {
    if (listed.has(alias)) continue
    listed.add(alias)
    root.set(alias, dir)
  }
  // pnpm 12 orders the nodes of one depth by their directories' names.
  const keyOf = major >= 12 ? (node) => node.modules.slice(0, -'/node_modules'.length) : (node) => node.dir
  const order = [
    { children: root, key: '', depth: -1 },
    ...major >= 12 ? [{ children: named, key: '', depth: -1 }] : [],
    ...walk(nodes, starts.map(([, dir]) => dir)).map(({ node, depth }) => ({ children: node.children, key: keyOf(node), depth })),
  ]
  order.sort((a, b) => a.depth - b.depth || (major >= 12 ? compareNames(a.key, b.key) : lexCompare(a.key, b.key)))
  const links = new Map()
  const hoistedProjects = new Map()
  for (const { children } of order) {
    for (const [alias, dir] of children) {
      const where = typeOf(alias)
      if (where === undefined || taken.has(alias.toLowerCase())) continue
      if (typeof dir === 'object') {
        if (major >= 12) taken.add(alias.toLowerCase())
        hoistedProjects.set(`${where}/${alias}`, dir.project)
      } else if (installed.has(dir)) {
        taken.add(alias.toLowerCase())
        links.set(`${where}/${alias}`, dir)
      }
    }
  }
  for (const [path, dir] of hoistedProjects) links.set(path, dir)
  return links
}

// Where each hoisted alias is linked, and to which directory: a Map of
// the link's path to its target, both relative to the lockfile's
// directory. `nodes` is the graph by directory; `direct` its projects'
// direct dependencies, the root project's under `.`; `projects` the
// workspace's named projects by directory, where hoistWorkspacePackages
// has them hoisted by name too.
//
// pnpm 10 puts those names first among the root's, a direct dependency of
// one name replacing it. Hoisting a project does not take its name, so a
// package of that name may be hoisted to the same place too; there the
// project wins, as pnpm replaces a link into the store with it and leaves
// its own in place of one. It takes the root project's aliases as they are
// spelled, and folds the case of those it hoists.
//
// pnpm 11 folds the root project's aliases too. It hoists the graph, then
// each project by its name where no project's direct dependency in the
// graph has that name, and then the graph again with those names taken
// from it; a project hoisted is not held back by a `link:` of its name, or
// by a package hoisted by it. (It holds back two projects of which one's
// name is a directory of the other's, which no two names a package can
// have are.)
//
// pnpm 12 hoists from `hoisting`, graph.js's graph of every snapshot,
// skipped or not, which it walks through those skipped, though none of
// them is hoisted; its projects' direct dependencies are taken in the
// order of their ids, and those of the root project but its `link:`s,
// skipped or not, are taken from the start. Of two projects whose names
// are one folded, both of which its patterns take, which it hoists turns
// on an order not known here, which is refused.
export function hoist(nodes, direct, { hoistPattern, publicHoistPattern }, projects = new Map(), major = 10, hoisting = undefined) {
  if (hoistPattern === undefined && publicHoistPattern === undefined) return new Map()
  const isPublic = createMatcher(publicHoistPattern ?? [])
  const isPrivate = createMatcher(hoistPattern ?? [])
  const typeOf = (alias) => (isPublic(alias) ? 'node_modules' : isPrivate(alias) ? 'node_modules/.pnpm/node_modules' : undefined)
  if (major >= 12) {
    // Only a project a pattern takes is one pnpm 12 would hoist.
    const folded = new Map()
    for (const [id, name] of projects) {
      if (typeOf(name) === undefined) continue
      const key = name.toLowerCase()
      if (folded.has(key)) throw new DeptreeError(`its name and ${quote(folded.get(key))}'s are one with their case folded, of which pnpm 12 hoists one by an order not known here`, `manifests[${quote(id)}].name`)
      folded.set(key, id)
    }
    const starts = [...hoisting.direct.values()].flatMap((children) => [...children])
    const taken = new Set([...hoisting.direct.get('.')?.keys() ?? []].map((alias) => alias.toLowerCase()))
    return hoistGraph(hoisting.nodes, starts, taken, typeOf, { projects, installed: nodes, major })
  }
  const starts = [...direct.values()].flatMap((children) => [...children].filter(([, dir]) => nodes.has(dir)))
  const rootAliases = [...direct.get('.')?.keys() ?? []]
  if (major < 11) return hoistGraph(nodes, starts, new Set(rootAliases), typeOf, { projects })
  const takenByDependencies = new Set(starts.map(([alias]) => alias.toLowerCase()))
  const hoistedProjects = [...projects].filter(([, name]) => typeOf(name) !== undefined && !takenByDependencies.has(name.toLowerCase()))
  const taken = new Set([...rootAliases, ...hoistedProjects.map(([, name]) => name)].map((alias) => alias.toLowerCase()))
  const links = hoistGraph(nodes, starts, taken, typeOf)
  for (const [id, name] of hoistedProjects) links.set(`${typeOf(name)}/${name}`, id)
  return links
}
