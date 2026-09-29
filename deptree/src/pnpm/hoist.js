// Hoisting as pnpm 10 does it (@pnpm/hoist): every alias in the graph a
// pattern matches gets a link to what it names, in node_modules/.pnpm/
// node_modules for the private pattern and in the root node_modules for
// the public one, which wins where both match. The first to take an alias
// keeps it, and the order is pnpm's: the projects' direct dependencies
// first, then the graph by depth, a node's depth being where pnpm's walk
// first reaches it, and nodes of one depth in the order of their
// directories. An alias is taken with its case folded, and the root
// project's own aliases are taken before anything, as they were spelled.

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

// Where each hoisted alias is linked, and to which directory: a Map of
// the link's path to its target, both relative to the lockfile's
// directory. `nodes` is the graph by directory; `direct` its projects'
// direct dependencies, the root project's under `.`; `projects` the
// workspace's named projects by directory, where hoistWorkspacePackages
// has them hoisted by name too.
//
// pnpm puts those names first among the root's, a direct dependency of
// one name replacing it. Hoisting a project does not take its name, so a
// package of that name may be hoisted to the same place too; there the
// project wins, as pnpm replaces a link into the store with it and leaves
// its own in place of one.
export function hoist(nodes, direct, { hoistPattern, publicHoistPattern }, projects = new Map()) {
  const links = new Map()
  if (hoistPattern === undefined && publicHoistPattern === undefined) return links
  const isPublic = createMatcher(publicHoistPattern ?? [])
  const isPrivate = createMatcher(hoistPattern ?? [])
  const starts = [...direct.values()].flatMap((children) => [...children].filter(([, dir]) => nodes.has(dir)))
  const root = new Map([...projects].map(([id, name]) => [name, { project: id }]))
  const listed = new Set()
  for (const [alias, dir] of starts) {
    if (listed.has(alias)) continue
    listed.add(alias)
    root.set(alias, dir)
  }
  const order = [
    { children: root, dir: '', depth: -1 },
    ...walk(nodes, starts.map(([, dir]) => dir)).map(({ node, depth }) => ({ children: node.children, dir: node.dir, depth })),
  ]
  order.sort((a, b) => a.depth - b.depth || lexCompare(a.dir, b.dir))
  const taken = new Set(direct.get('.')?.keys())
  const hoistedProjects = new Map()
  for (const { children } of order) {
    for (const [alias, dir] of children) {
      const where = isPublic(alias) ? 'node_modules' : isPrivate(alias) ? 'node_modules/.pnpm/node_modules' : undefined
      if (where === undefined || taken.has(alias.toLowerCase())) continue
      if (typeof dir === 'object') hoistedProjects.set(`${where}/${alias}`, dir.project)
      else if (nodes.has(dir)) {
        taken.add(alias.toLowerCase())
        links.set(`${where}/${alias}`, dir)
      }
    }
  }
  for (const [path, dir] of hoistedProjects) links.set(path, dir)
  return links
}
