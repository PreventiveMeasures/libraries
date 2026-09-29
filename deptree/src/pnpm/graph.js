// The graph a pnpm 10 install links, as @pnpm/deps.graph-builder builds it
// from a frozen lockfile: a node for each snapshot installed, at
// node_modules/.pnpm/<its directory>/node_modules/<its name>, with its
// dependencies and optional dependencies as children by alias; and, for
// each project, its direct dependencies by alias. A child left out of the
// install is left out of its parent's children too. A `link:` child is the
// directory it names, which is no node. Paths here are relative to the
// lockfile's directory, the root of the tree.

import { DeptreeError, quote } from '../error.js'
import { depPathToFilename } from './filename.js'

const VIRTUAL_STORE = 'node_modules/.pnpm'

// A target as a path: a node's directory, or where a link leads, which
// may climb out of the lockfile's directory.
function childOf(target, nodes, skipped) {
  if (target.startsWith('link:')) return target.slice(5)
  if (skipped.has(target)) return undefined
  return nodes.get(target).dir
}

function childrenOf(targets, nodes, skipped) {
  const children = new Map()
  for (const [alias, target] of Object.entries(targets)) {
    const dir = childOf(target, nodes, skipped)
    if (dir !== undefined) children.set(alias, dir)
  }
  return children
}

// `nodes` by snapshot key, and `direct`, by project, the children each
// project links: devDependencies first, as pnpm spreads them, which is
// the order hoisting walks them in.
export async function buildGraph(lockfile, skipped, maxLength) {
  const nodes = new Map()
  const keyByDir = new Map()
  for (const [key, pkg] of Object.entries(lockfile.packages)) {
    if (skipped.has(key)) continue
    const store = `${VIRTUAL_STORE}/${await depPathToFilename(key, maxLength)}`
    const dir = `${store}/node_modules/${pkg.name}`
    if (keyByDir.has(dir)) throw new DeptreeError(`${quote(keyByDir.get(dir))} and ${quote(key)} would be installed in one directory`, quote(dir))
    keyByDir.set(dir, key)
    nodes.set(key, { key, pkg, name: pkg.name, dir, modules: `${store}/node_modules` })
  }
  for (const node of nodes.values()) {
    node.children = childrenOf({ ...node.pkg.dependencies, ...node.pkg.optionalDependencies }, nodes, skipped)
  }
  const direct = new Map()
  for (const [id, importer] of Object.entries(lockfile.importers)) {
    direct.set(id, childrenOf({ ...importer.devDependencies, ...importer.dependencies, ...importer.optionalDependencies }, nodes, skipped))
  }
  return { nodes, direct }
}
