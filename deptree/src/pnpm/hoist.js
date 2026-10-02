// Hoisting as @pnpm/hoist does it: an alias a pattern matches is linked in
// node_modules (public) or node_modules/.pnpm/node_modules (private), and the
// first to take it keeps it, in pnpm's order: the projects' direct
// dependencies, then the graph by depth, then by directory.

import { compareNames } from '@preventive/vfs/path.js'
import { DeptreeError, quote } from '../error.js'
import { createMatcher } from '../matcher.js'

// pnpm's graphWalker: each node's children are walked to the bottom before the
// next node's, so a node's depth is not always its least.
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

// Each alias is looked up folded in `taken`, which gains each one hoisted.
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

// pnpm 9's hoistGraph walks the lockfile from every project's direct
// dependencies, the first project to list an alias keeping it. A `link:` or
// skipped child takes its alias though nothing is linked by it, as does a
// project, and the root's specifiers are taken from the start. Snapshots of
// one depth are taken in the order of their keys.
function hoist9({ lockfile, nodes }, typeOf, projects) {
  const root = Object.create(null)
  for (const [id, name] of projects) root[name] = { project: id }
  const direct = Object.create(null)
  const starts = []
  for (const importer of Object.values(lockfile.importers)) {
    for (const [alias, target] of Object.entries({ ...importer.devDependencies, ...importer.dependencies, ...importer.optionalDependencies })) {
      if (target.startsWith('link:')) continue
      starts.push(target)
      if (!(alias in direct)) direct[alias] = target
    }
  }
  Object.assign(root, direct)
  const graph = new Map([...nodes].map(([key, { pkg }]) => [key, { key, children: new Map(Object.entries({ ...pkg.dependencies, ...pkg.optionalDependencies })) }]))
  const order = [{ children: Object.entries(root), key: '', depth: -1 }, ...walk(graph, starts).map(({ node, depth }) => ({ children: node.children, key: node.key, depth }))]
  order.sort((a, b) => a.depth - b.depth || lexCompare(a.key, b.key))
  const taken = new Set(Object.keys(lockfile.importers['.']?.specifiers ?? {}))
  const links = new Map()
  for (const { children } of order) {
    for (const [alias, target] of children) {
      const where = typeOf(alias)
      if (where === undefined || taken.has(alias.toLowerCase())) continue
      taken.add(alias.toLowerCase())
      if (target?.project !== undefined) links.set(`${where}/${alias}`, target.project)
      else if (nodes.has(target)) links.set(`${where}/${alias}`, nodes.get(target).dir)
    }
  }
  return links
}

// `projects` are the named projects by directory, which hoistWorkspacePackages
// hoists by name too. pnpm 10 lists their names first among the root's aliases,
// a direct dependency of the same name replacing one; a hoisted project takes
// no name, and wins over a package hoisted to its place, as pnpm replaces a
// link into the store with it but not its own with one. pnpm 10 takes the
// root's aliases as spelled; pnpm 11 folds them too, and hoists a project
// unless a project's direct dependency in the graph has its name. pnpm 12 walks
// `hoisting`, through the skipped snapshots though it hoists none of them.
export function hoist(nodes, direct, { hoistPattern, publicHoistPattern }, projects = new Map(), major = 10, hoisting) {
  if (hoistPattern === undefined && publicHoistPattern === undefined) return new Map()
  const isPublic = createMatcher(publicHoistPattern ?? [])
  const isPrivate = createMatcher(hoistPattern ?? [])
  const typeOf = (alias) => (isPublic(alias) ? 'node_modules' : isPrivate(alias) ? 'node_modules/.pnpm/node_modules' : undefined)
  if (major < 10) return hoist9(hoisting, typeOf, projects)
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
