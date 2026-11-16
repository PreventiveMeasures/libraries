// @pnpm/hoist: an alias a pattern matches is linked in node_modules (public) or .pnpm/node_modules (private),
// the first to take it keeping it, in pnpm's order: the projects' direct dependencies, then the graph by
// depth, then by directory

import { compareNames } from '@preventive/vfs/path.js'
import { DeptreeError, quote } from '../error.js'
import { createMatcher } from '../matcher.js'

// pnpm's graphWalker on a stack: a level's nodes are listed, and all their children stepped to, before the
// first child's are, so a node's depth is not always its least
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
  const walked = []
  const level = (depth, found) => {
    for (const node of found) walked.push({ node, depth })
    return { depth: depth + 1, next: found.map((node) => step(node.children.values())), i: 0 }
  }
  const stack = [level(0, step(starts))]
  while (stack.length > 0) {
    const top = stack.at(-1)
    if (top.i === top.next.length) stack.pop()
    else stack.push(level(top.depth, top.next[top.i++]))
  }
  return walked
}

// UTF-16 order, as pnpm's lexCompare has it.
const lexCompare = (a, b) => (a > b ? 1 : a < b ? -1 : 0)

// Each alias is looked up folded in `taken`, which gains each one hoisted.
function hoistGraph(nodes, starts, taken, typeOf, { projects = new Map(), installed = nodes, major = 10 } = {}) {
  const named = new Map([...projects].map(([id, name]) => [name, { project: id }]))
  const root = new Map(major < 12 ? named : [])
  // The first of each alias in `starts`.
  const first = new Map(starts.toReversed())
  for (const [alias] of starts) root.set(alias, first.get(alias))
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

// `projects`, by directory, are hoisted by name too. pnpm 10 lists them first among the root's aliases, as
// spelled, a project winning over a package hoisted to its place; pnpm 11 folds case and skips one a project's
// direct dependency is named as; pnpm 12 walks `hoisting`, through the skipped snapshots, hoisting none.
export function hoist(nodes, direct, { hoistPattern, publicHoistPattern }, projects = new Map(), major = 10, hoisting) {
  if (hoistPattern === undefined && publicHoistPattern === undefined) return new Map()
  const isPublic = createMatcher(publicHoistPattern ?? [])
  const isPrivate = createMatcher(hoistPattern ?? [])
  const typeOf = (alias) => (isPublic(alias) ? 'node_modules' : isPrivate(alias) ? 'node_modules/.pnpm/node_modules' : undefined)
  if (major >= 12) {
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
