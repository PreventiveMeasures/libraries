// The graph a pnpm 10 install links, as @pnpm/deps.graph-builder builds it
// from a frozen lockfile: a node per installed snapshot with children by
// alias, and each project's direct dependencies by alias. A child left out
// of the install is left out of its parent's children; a `link:` child is
// the directory it names, which is no node. Paths are relative to the
// lockfile's directory.

import { compareNames } from '@preventive/vfs/path.js'
import { DeptreeError, quote } from '../error.js'
import { depPathToFilename } from './filename.js'

const VIRTUAL_STORE = 'node_modules/.pnpm'

// A `link:` target may climb out of the lockfile's directory. Every other
// target is a snapshot, as the lockfile reader ensures, with no node where
// it is left out of the install.
const childOf = (target, nodes) => (target.startsWith('link:') ? target.slice(5) : nodes.get(target)?.dir)

const childrenOf = (targets, nodes) => new Map(Object.entries(targets).map(([alias, target]) => [alias, childOf(target, nodes)]).filter(([, dir]) => dir !== undefined))

// The graph pnpm 12 hoists from: every snapshot's node by directory,
// skipped or not, and each project's direct dependencies but its
// `link:`s, projects ordered by their ids' bytes.
function hoistingOf(lockfile, all) {
  const nodes = new Map([...all.values()].map((node) => [node.dir, { modules: node.modules, children: childrenOf({ ...node.pkg.dependencies, ...node.pkg.optionalDependencies }, all) }]))
  const direct = new Map(Object.keys(lockfile.importers).sort(compareNames).map((id) => {
    const { devDependencies, dependencies, optionalDependencies } = lockfile.importers[id]
    return [id, new Map([...childrenOf({ ...devDependencies, ...dependencies, ...optionalDependencies }, all)].filter(([, dir]) => nodes.has(dir)))]
  }))
  return { nodes, direct }
}

// `nodes` by snapshot key; `direct` each project's children,
// devDependencies first as pnpm spreads them, the order hoisting walks
// them in; and for pnpm 12, `hoisting`. No two snapshots may share a
// directory, counting with pnpm 12 those skipped, which it hoists from.
export async function buildGraph(lockfile, skipped, maxLength, major = 10) {
  const all = new Map()
  const keyByDir = new Map()
  for (const [key, pkg] of Object.entries(lockfile.packages)) {
    if (major < 12 && skipped.has(key)) continue
    const store = `${VIRTUAL_STORE}/${await depPathToFilename(key, maxLength, major)}`
    const dir = `${store}/node_modules/${pkg.name}`
    if (keyByDir.has(dir)) throw new DeptreeError(`${quote(keyByDir.get(dir))} and ${quote(key)} would be installed in one directory`, quote(dir))
    keyByDir.set(dir, key)
    all.set(key, { key, pkg, name: pkg.name, dir, modules: `${store}/node_modules` })
  }
  const nodes = new Map([...all].filter(([key]) => !skipped.has(key)))
  for (const node of nodes.values()) {
    node.children = childrenOf({ ...node.pkg.dependencies, ...node.pkg.optionalDependencies }, nodes)
  }
  const direct = new Map(Object.entries(lockfile.importers).map(([id, importer]) => [id, childrenOf({ ...importer.devDependencies, ...importer.dependencies, ...importer.optionalDependencies }, nodes)]))
  return { nodes, direct, hoisting: major >= 12 ? hoistingOf(lockfile, all) : undefined }
}
